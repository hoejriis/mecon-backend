"""Session resolution around the SessionLookup port: fail-closed checks, the short cache, revocations."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Union

from .ports import CAPABILITY_NAMES, CAPABILITY_STATES, DENIAL_REASONS, Caller, Denied, Revocation, SessionLookup, Subscribed

log = logging.getLogger("mecon_reader_backend.sessions")


def caller_is_well_formed(c: object) -> bool:
    """A malformed lookup answer fails closed, like a lookup error."""
    if not isinstance(c, Caller):
        return False
    try:
        return (isinstance(c.session_ref, str) and c.session_ref != ""
                and isinstance(c.user_id, str) and 1 <= len(c.user_id) <= 128
                and isinstance(c.display_name, str)
                and c.role in ("instance_admin", "user") and isinstance(c.break_glass, bool)
                and (c.csrf_token is None or (isinstance(c.csrf_token, str) and len(c.csrf_token) >= 16))
                and isinstance(c.expires_at, datetime) and c.expires_at.tzinfo is not None
                and all(c.capabilities.get(n) in CAPABILITY_STATES for n in CAPABILITY_NAMES))
    except Exception:  # noqa: BLE001 - any surprise in the answer is a malformed answer
        return False


@dataclass
class _Entry:
    caller: Caller
    until: float  # monotonic


class SessionResolver:
    """Calls the lookup, caches read answers briefly, and watches the revocation feed.

    Writes are never served from the cache: every write reaches the lookup with its CSRF token and
    Origin. A cached Caller lives at most `cache_s`, never past its own expiry, and is dropped when
    its session is revoked.
    """

    def __init__(self, lookup: SessionLookup, *, cache_s: float = 5.0, cache_max: int = 10_000,
                 timeout_s: float = 2.0, feed_retry_s: float = 1.0, clock: Callable[[], float] = time.monotonic):
        self.lookup = lookup
        self.cache_s = cache_s
        self.cache_max = cache_max
        self.timeout_s = timeout_s
        self.feed_retry_s = feed_retry_s
        self._clock = clock
        self._cache: dict[str, _Entry] = {}
        self._streams: dict[str, set[asyncio.Event]] = {}
        self._feed_task: asyncio.Task | None = None
        # The feed counts as up only after the core confirmed the subscription (Subscribed), and is down
        # again after any end or error until the next Subscribed. Nothing is cached while it is down.
        self.feed_up = False
        self.feed_down_since: float | None = None  # when the current down period began
        self._revocation_epoch = 0  # bumped by every revocation and feed outage

    # ---- resolution ----

    async def resolve(self, credential: str, purpose: str, *, csrf_token: str | None = None,
                      origin: str | None = None, sec_fetch_site: str | None = None) -> Union[Caller, Denied]:
        self.ensure_feed()
        now = self._clock()
        if purpose in ("read", "session"):
            hit = self._cache.get(credential)
            if hit is not None and purpose == "session" and hit.caller.csrf_token is None:
                hit = None  # GET /session needs the token: ask the core, never answer without it
            if hit is not None:
                if hit.until > now and not self._expired(hit.caller):
                    return hit.caller
                self._cache.pop(credential, None)
        epoch = self._revocation_epoch
        try:
            answer = await asyncio.wait_for(
                self.lookup.resolve(credential, purpose, csrf_token=csrf_token if purpose == "write" else None,
                                    origin=origin, sec_fetch_site=sec_fetch_site), self.timeout_s)
        except Exception as exc:  # noqa: BLE001 - timeouts and adapter errors fail closed
            log.warning("session lookup failed: %s", type(exc).__name__)
            return Denied("core_unavailable")
        if isinstance(answer, Denied):
            return answer if answer.reason in DENIAL_REASONS else Denied("core_unavailable")
        if not caller_is_well_formed(answer):
            log.warning("session lookup answered with a malformed caller")
            return Denied("core_unavailable")
        if purpose == "session" and answer.csrf_token is None:
            log.warning("session lookup answered without the CSRF token it was asked for")
            return Denied("core_unavailable")
        if self._expired(answer):
            return Denied("expired")
        # Cache only an answer no revocation can have overtaken: none arrived while the lookup ran, and the
        # feed that would deliver one is up.
        if purpose in ("read", "session") and epoch == self._revocation_epoch and self.feed_up:
            self._insert(credential, _Entry(answer, now + self.cache_s), now)
        return answer

    def _insert(self, credential: str, entry: _Entry, now: float) -> None:
        # Pop first: a re-inserted key must move to the end, so the dict stays in `until` order (every
        # entry lives cache_s from its insert). Then prune from the front up to the first live entry.
        self._cache.pop(credential, None)
        while self._cache:
            oldest = next(iter(self._cache))
            if self._cache[oldest].until > now:
                break
            del self._cache[oldest]
        while len(self._cache) >= self.cache_max:
            del self._cache[next(iter(self._cache))]  # the oldest insert
        self._cache[credential] = entry

    @staticmethod
    def _expired(caller: Caller) -> bool:
        return caller.expires_at <= datetime.now(timezone.utc)

    def drop_cache(self) -> None:
        self._cache.clear()

    def forget_session(self, session_ref: str) -> None:
        for cred in [k for k, e in self._cache.items() if e.caller.session_ref == session_ref]:
            del self._cache[cred]

    # ---- revocations ----

    def ensure_feed(self) -> None:
        """Start the revocation watcher on the running loop (lazily: test transports skip lifespan)."""
        t = self._feed_task
        if t is not None and not t.done() and t.get_loop() is asyncio.get_running_loop():
            return
        if not self.feed_up and self.feed_down_since is None:
            self.feed_down_since = self._clock()
        self._feed_task = asyncio.get_running_loop().create_task(self._watch_feed())

    async def _watch_feed(self) -> None:
        while True:
            try:
                async for item in self.lookup.revocations():
                    if isinstance(item, Subscribed):
                        self._subscribed()
                    elif isinstance(item, Revocation):
                        self._revoked(item)
                log.warning("revocation feed ended")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("revocation feed failed: %s", type(exc).__name__)
            self.feed_up = False
            if self.feed_down_since is None:
                self.feed_down_since = self._clock()
            # Nothing cached may outlive a feed outage: a revocation could be missed meanwhile.
            self._revocation_epoch += 1
            self._cache.clear()
            await asyncio.sleep(self.feed_retry_s)

    def _subscribed(self) -> None:
        self.feed_up = True
        self.feed_down_since = None

    def _revoked(self, rev: Revocation) -> None:
        self._revocation_epoch += 1
        self.forget_session(rev.session_ref)
        for ev in self._streams.get(rev.session_ref, ()):
            ev.set()

    def register_stream(self, session_ref: str) -> asyncio.Event:
        ev = asyncio.Event()
        self._streams.setdefault(session_ref, set()).add(ev)
        return ev

    def unregister_stream(self, session_ref: str, ev: asyncio.Event) -> None:
        s = self._streams.get(session_ref)
        if s is not None:
            s.discard(ev)
            if not s:
                del self._streams[session_ref]

    def revoke_local(self, session_ref: str) -> None:
        """The facade itself saw the session end (logout): act as the feed would, at once."""
        self._revoked(Revocation(session_ref, "logout"))

    def feed_down_for(self) -> float:
        if self.feed_up or self.feed_down_since is None:
            return 0.0
        return self._clock() - self.feed_down_since
