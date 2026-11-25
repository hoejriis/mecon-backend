"""A fake SessionLookup over the in-memory world."""
from __future__ import annotations

import asyncio
import hmac
from typing import AsyncIterator, Union

from ..ports import Caller, Denied, Revocation, Subscribed
from .world import World, now


class FakeSessionLookup:
    def __init__(self, world: World):
        self.world = world
        self.unavailable = False  # tests flip this to model a lookup that cannot answer

    def capabilities(self, user) -> dict[str, str]:
        w = self.world
        return {"devices": "available", "messaging": "available",
                "send": "available" if w.switches.get("sending") == "on" else "unavailable",
                "events": "available", "observations": user.observations if w.observes else "unavailable"}

    async def resolve(self, credential: str, purpose: str, *, csrf_token: str | None = None,
                      origin: str | None = None, sec_fetch_site: str | None = None,
                      include_csrf: bool = False) -> Union[Caller, Denied]:
        if self.unavailable:
            return Denied("core_unavailable")
        s = self.world.sessions.get(credential)
        if s is None:
            return Denied("unknown")
        if s.revoked:
            return Denied("revoked")
        if s.expires_at <= now():
            return Denied("expired")
        expected = self.world.csrf_for(s)
        if purpose == "write":
            # The core's rule: an allow-listed Origin (trailing "/" stripped) or Sec-Fetch-Site "same-origin".
            listed = origin is not None and origin.rstrip("/") in self.world.reader_origins
            if not (listed or sec_fetch_site == "same-origin"):
                return Denied("origin_rejected")
            if csrf_token is None or not hmac.compare_digest(csrf_token.encode(), expected.encode()):
                return Denied("csrf_failed")
        u = self.world.users[s.user]
        return Caller(session_ref=self.world.session_ref(s), user_id=u.id, display_name=u.display_name,
                      role="instance_admin" if u.role == "instance_admin" else "user", break_glass=False,
                      capabilities=self.capabilities(u), expires_at=s.expires_at,
                      csrf_token=expected if include_csrf else None)

    async def revocations(self) -> AsyncIterator[Union[Subscribed, Revocation]]:
        q: asyncio.Queue = asyncio.Queue()
        self.world.revocation_queues.append(q)
        try:
            yield Subscribed()
            while True:
                yield await q.get()
        finally:
            self.world.revocation_queues.remove(q)
