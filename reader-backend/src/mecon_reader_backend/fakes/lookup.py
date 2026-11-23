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
                      origin: str | None = None) -> Union[Caller, Denied]:
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
            if origin is None or origin not in self.world.reader_origins:
                return Denied("origin_rejected")
            if csrf_token is None or not hmac.compare_digest(csrf_token.encode(), expected.encode()):
                return Denied("csrf_failed")
        u = self.world.users[s.user]
        return Caller(session_ref=self.world.session_ref(s), user_id=u.id, display_name=u.display_name,
                      role="instance_admin" if u.role == "instance_admin" else "user", break_glass=False,
                      capabilities=self.capabilities(u), expires_at=s.expires_at, csrf_token=expected)

    async def revocations(self) -> AsyncIterator[Union[Subscribed, Revocation]]:
        q: asyncio.Queue = asyncio.Queue()
        self.world.revocation_queues.append(q)
        try:
            yield Subscribed()
            while True:
                yield await q.get()
        finally:
            self.world.revocation_queues.remove(q)
