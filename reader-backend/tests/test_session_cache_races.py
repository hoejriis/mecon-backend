"""The read cache never holds an answer a revocation could have overtaken."""
import asyncio
from datetime import datetime, timedelta, timezone

from mecon_reader_backend.ports import CAPABILITY_NAMES, Caller, Revocation, Subscribed
from mecon_reader_backend.sessions import SessionResolver


def _caller() -> Caller:
    return Caller(session_ref="s1", user_id="u1", display_name="U", role="user", break_glass=False,
                  capabilities={n: "available" for n in CAPABILITY_NAMES},
                  expires_at=datetime.now(timezone.utc) + timedelta(hours=1), csrf_token="c" * 43)


class _Lookup:
    """Answers every resolve with the same caller; the first one waits until released. The feed stays open."""

    def __init__(self):
        self.calls = 0
        self.first_started = asyncio.Event()
        self.release = asyncio.Event()

    async def resolve(self, credential, purpose, *, csrf_token=None, origin=None, sec_fetch_site=None,
                      include_csrf=False):
        self.calls += 1
        if self.calls == 1:
            self.first_started.set()
            await self.release.wait()
        return _caller()

    async def revocations(self):
        await asyncio.Event().wait()
        yield  # pragma: no cover


def test_a_revocation_during_the_lookup_keeps_its_answer_out_of_the_cache():
    async def go():
        lookup = _Lookup()
        r = SessionResolver(lookup)
        r._subscribed()  # the feed is up: only the revocation keeps the answer out
        first = asyncio.create_task(r.resolve("cred", "read"))
        await lookup.first_started.wait()
        r._revoked(Revocation("s1"))  # arrives while the lookup is still answering
        lookup.release.set()
        await first
        await r.resolve("cred", "read")
        assert lookup.calls == 2  # the second read asked the lookup again: nothing was cached
    asyncio.run(go())


def test_nothing_is_cached_while_the_revocation_feed_is_down():
    async def go():
        lookup = _Lookup()
        lookup.release.set()
        r = SessionResolver(lookup)
        r.feed_up = False  # as _watch_feed records an outage
        await r.resolve("cred", "read")
        await r.resolve("cred", "read")
        assert lookup.calls == 2
        r._subscribed()  # control: with the feed up, the second read is cached
        await r.resolve("cred", "read")
        await r.resolve("cred", "read")
        assert lookup.calls == 3
    asyncio.run(go())


# ---- the feed is up only once the core confirms the subscription ----

_END = object()


class _FeedLookup:
    """Answers every resolve with the same caller; each subscription reads its own queue (_END ends it)."""

    def __init__(self):
        self.calls = 0
        self.subscriptions: list[asyncio.Queue] = []

    async def resolve(self, credential, purpose, *, csrf_token=None, origin=None, sec_fetch_site=None,
                      include_csrf=False):
        self.calls += 1
        return _caller()

    async def revocations(self):
        q: asyncio.Queue = asyncio.Queue()
        self.subscriptions.append(q)
        while True:
            item = await q.get()
            if item is _END:
                return
            yield item


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0.01)


async def _reads(r, lookup, n=2, cred="cred"):
    before = lookup.calls
    for _ in range(n):
        await r.resolve(cred, "read")
    return lookup.calls - before


def test_nothing_is_cached_before_the_subscription_is_confirmed():
    async def go():
        lookup = _FeedLookup()
        r = SessionResolver(lookup)
        await r.resolve("warm", "read")  # starts the feed watcher
        await _settle()
        assert lookup.subscriptions and not r.feed_up
        assert await _reads(r, lookup) == 2
    asyncio.run(go())


def test_caching_starts_at_subscribed():
    async def go():
        lookup = _FeedLookup()
        r = SessionResolver(lookup)
        await r.resolve("warm", "read")
        await _settle()
        lookup.subscriptions[-1].put_nowait(Subscribed())
        await _settle()
        assert r.feed_up
        assert await _reads(r, lookup) == 1
    asyncio.run(go())


def test_a_revocation_is_not_an_up_signal():
    async def go():
        lookup = _FeedLookup()
        r = SessionResolver(lookup)
        await r.resolve("warm", "read")
        await _settle()
        lookup.subscriptions[-1].put_nowait(Revocation("someone_else"))
        await _settle()
        assert not r.feed_up
        assert await _reads(r, lookup) == 2
    asyncio.run(go())


def test_after_an_outage_the_feed_is_down_until_subscribed_again():
    async def go():
        lookup = _FeedLookup()
        r = SessionResolver(lookup, feed_retry_s=0.02)
        await r.resolve("warm", "read")
        await _settle()
        lookup.subscriptions[-1].put_nowait(Subscribed())
        await _settle()
        assert await _reads(r, lookup) == 1
        lookup.subscriptions[-1].put_nowait(_END)  # the feed ends
        await _settle()
        assert not r.feed_up and len(lookup.subscriptions) == 2  # resubscribed, not yet confirmed
        assert r._cache == {}
        assert await _reads(r, lookup) == 2
        lookup.subscriptions[-1].put_nowait(Revocation("someone_else"))
        await _settle()
        assert await _reads(r, lookup) == 2  # still down: a revocation is not the up signal
        lookup.subscriptions[-1].put_nowait(Subscribed())
        await _settle()
        assert await _reads(r, lookup) == 1
    asyncio.run(go())


# ---- the cache is bounded ----

def test_the_cache_holds_at_most_its_cap_and_evicts_the_oldest():
    async def go():
        lookup = _FeedLookup()
        r = SessionResolver(lookup, cache_max=3)
        r._subscribed()
        for cred in "abcde":
            await r.resolve(cred, "read")
        assert list(r._cache) == ["c", "d", "e"]
    asyncio.run(go())


def test_expired_entries_are_dropped_on_insert():
    async def go():
        lookup = _FeedLookup()
        r = SessionResolver(lookup, cache_s=0.05)
        r._subscribed()
        await r.resolve("a", "read")
        await asyncio.sleep(0.1)
        await r.resolve("b", "read")
        assert list(r._cache) == ["b"]
    asyncio.run(go())


def test_the_default_cap_is_ten_thousand():
    from mecon_reader_backend import FacadeConfig
    assert FacadeConfig().lookup_cache_max == 10_000
    assert SessionResolver(_FeedLookup()).cache_max == 10_000


def test_a_reinserted_key_moves_to_the_end_and_is_not_pruned_with_older_entries():
    from mecon_reader_backend.sessions import _Entry
    r = SessionResolver(_FeedLookup())
    c = _caller()
    r._insert("a", _Entry(c, 10.0), now=0.0)
    r._insert("b", _Entry(c, 12.0), now=1.0)
    r._insert("a", _Entry(c, 20.0), now=5.0)  # re-inserted: now the newest
    assert list(r._cache) == ["b", "a"]
    r._insert("c", _Entry(c, 30.0), now=15.0)  # b has run out; a has not
    assert list(r._cache) == ["a", "c"]
