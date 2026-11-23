"""Session resolution around the SessionLookup port: fail-closed checks, the short cache, revocations."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Union

from .ports import CAPABILITY_NAMES, CAPABILITY_STATES, DENIAL_REASONS, Caller, Denied, Revocation, SessionLookup

log = logging.getLogger("mecon_reader_backend.sessions")


def caller_is_well_formed(c: object) -> bool:
    """A malformed lookup answer fails closed, like a lookup error."""
    if not isinstance(c, Caller):
        return False
    try:
        return (isinstance(c.session_id, str) and c.session_id != ""
                and isinstance(c.user_id, str) and 1 <= len(c.user_id) <= 128
                and isinstance(c.display_name, str)
                and c.role in ("instance_admin", "user") and isinstance(c.break_glass, bool)
                and isinstance(c.csrf_token, str) and len(c.csrf_token) >= 16
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

    def __init__(self, lookup: SessionLookup, *, cache_s: float = 5.0, timeout_s: float = 2.0,
                 feed_retry_s: float = 1.0, clock: Callable[[], float] = time.monotonic):
        self.lookup = lookup
        self.cache_s = cache_s
        self.timeout_s = timeout_s
        self.feed_retry_s = feed_retry_s
        self._clock = clock
        self._cache: dict[str, _Entry] = {}
        self._streams: dict[str, set[asyncio.Event]] = {}
        self._feed_task: asyncio.Task | None = None
        self.feed_down_since: float | None = None

    # ---- resolution ----

    async def resolve(self, credential: str, purpose: str, *, csrf_token: str | None = None,
                      origin: str | None = None) -> Union[Caller, Denied]:
        self.ensure_feed()
        now = self._clock()
        if purpose == "read":
            hit = self._cache.get(credential)
            if hit is not None:
                if hit.until > now and not self._expired(hit.caller):
                    return hit.caller
                self._cache.pop(credential, None)
        try:
            if purpose == "write":
                answer = await asyncio.wait_for(
                    self.lookup.resolve(credential, "write", csrf_token=csrf_token, origin=origin), self.timeout_s)
            else:
                answer = await asyncio.wait_for(self.lookup.resolve(credential, purpose), self.timeout_s)
        except Exception as exc:  # noqa: BLE001 - timeouts and adapter errors fail closed
            log.warning("session lookup failed: %s", type(exc).__name__)
            return Denied("core_unavailable")
        if isinstance(answer, Denied):
            return answer if answer.reason in DENIAL_REASONS else Denied("core_unavailable")
        if not caller_is_well_formed(answer):
            log.warning("session lookup answered with a malformed caller")
            return Denied("core_unavailable")
        if self._expired(answer):
            return Denied("expired")
        if purpose == "read":
            self._cache[credential] = _Entry(answer, now + self.cache_s)
        return answer

    @staticmethod
    def _expired(caller: Caller) -> bool:
        return caller.expires_at <= datetime.now(timezone.utc)

    def forget_session(self, session_id: str) -> None:
        for cred in [k for k, e in self._cache.items() if e.caller.session_id == session_id]:
            del self._cache[cred]

    # ---- revocations ----

    def ensure_feed(self) -> None:
        """Start the revocation watcher on the running loop (lazily: test transports skip lifespan)."""
        t = self._feed_task
        if t is not None and not t.done() and t.get_loop() is asyncio.get_running_loop():
            return
        self._feed_task = asyncio.get_running_loop().create_task(self._watch_feed())

    async def _watch_feed(self) -> None:
        while True:
            try:
                async for rev in self.lookup.revocations():
                    self.feed_down_since = None
                    self._revoked(rev)
                log.warning("revocation feed ended")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("revocation feed failed: %s", type(exc).__name__)
            if self.feed_down_since is None:
                self.feed_down_since = self._clock()
            # Nothing cached may outlive a feed outage: a revocation could be missed meanwhile.
            self._cache.clear()
            await asyncio.sleep(self.feed_retry_s)

    def _revoked(self, rev: Revocation) -> None:
        self.forget_session(rev.session_id)
        for ev in self._streams.get(rev.session_id, ()):
            ev.set()

    def register_stream(self, session_id: str) -> asyncio.Event:
        ev = asyncio.Event()
        self._streams.setdefault(session_id, set()).add(ev)
        return ev

    def unregister_stream(self, session_id: str, ev: asyncio.Event) -> None:
        s = self._streams.get(session_id)
        if s is not None:
            s.discard(ev)
            if not s:
                del self._streams[session_id]

    def revoke_local(self, session_id: str) -> None:
        """The facade itself saw the session end (logout): act as the feed would, at once."""
        self._revoked(Revocation(session_id, "logout"))

    def feed_down_for(self) -> float:
        return 0.0 if self.feed_down_since is None else self._clock() - self.feed_down_since
