"""The read cache never holds an answer a revocation could have overtaken."""
import asyncio
from datetime import datetime, timedelta, timezone

from mecon_reader_backend.ports import CAPABILITY_NAMES, Caller, Revocation
from mecon_reader_backend.sessions import SessionResolver


def _caller() -> Caller:
    return Caller(session_id="s1", user_id="u1", display_name="U", role="user", break_glass=False,
                  capabilities={n: "available" for n in CAPABILITY_NAMES},
                  expires_at=datetime.now(timezone.utc) + timedelta(hours=1), csrf_token="c" * 43)


class _Lookup:
    """Answers every resolve with the same caller; the first one waits until released. The feed stays open."""

    def __init__(self):
        self.calls = 0
        self.first_started = asyncio.Event()
        self.release = asyncio.Event()

    async def resolve(self, credential, purpose, *, csrf_token=None, origin=None):
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
        r.feed_down_since = 0.0  # as _watch_feed records an outage
        await r.resolve("cred", "read")
        await r.resolve("cred", "read")
        assert lookup.calls == 2
        r.feed_down_since = None  # control: with the feed up, the second read is cached
        await r.resolve("cred", "read")
        await r.resolve("cred", "read")
        assert lookup.calls == 3
    asyncio.run(go())
