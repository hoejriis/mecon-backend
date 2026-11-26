"""Fake ObservationScope and ReceptionStore over the in-memory world. Never production.

The scope here is a toy: a user sees their fleet's observers and every approved public source's. The real
rules (sharing between fleets, per-observer location sharing) belong to the core, not to the facade.
"""
from __future__ import annotations

import asyncio
import hashlib
from datetime import timedelta
from typing import Sequence

from ..ports import Caller, CoreError, EventBatch, ObserverPage, ScopedObserver, SnapshotResult
from .world import ObsReception, World, iso, now

OWN_PRECISION_M = 50.0
PUBLIC_PRECISION_M = 500.0
SNAPSHOT_LIFETIME = timedelta(days=1)
LIVE_S = 900
OFFLINE_S = 21600


class FakeObservationScope:
    def __init__(self, world: World):
        self.world = world
        self.unavailable = False  # tests flip this to model a core that cannot answer

    async def visible_observers(self, caller: Caller) -> Sequence[ScopedObserver]:
        if self.unavailable:
            raise CoreError("unavailable")
        w = self.world
        u = w.user_by_id(caller.user_id)
        if u is None:
            raise CoreError("forbidden")
        out = []
        for name, o in w.observers.items():
            if o.get("fleet") == u.fleet:
                prov, precision = "own_fleet", OWN_PRECISION_M
            elif o.get("approved_public_source"):
                prov, precision = "approved_public_source", PUBLIC_PRECISION_M
            else:
                continue
            out.append(ScopedObserver(w.observer_id(caller.user_id, name), prov, precision if o.get("location") else None))
        return out


class FakeReceptionStore:
    def __init__(self, world: World):
        self.world = world
        self.unavailable = False
        self.tick = 0.02

    def _check(self) -> None:
        if self.unavailable:
            raise CoreError("unavailable")

    def _names(self, caller: Caller, scope: Sequence[ScopedObserver]) -> dict[str, ScopedObserver]:
        # The one scope filter: only observers the scope names are ever read, by the caller's own ids.
        by_id = {s.observer_id: s for s in scope}
        return {n: by_id[self.world.observer_id(caller.user_id, n)] for n in self.world.observers
                if self.world.observer_id(caller.user_id, n) in by_id}

    def _correlation(self, caller: Caller, packet: str) -> str:
        return "pkc_" + hashlib.sha256(f"{caller.user_id}|{packet}".encode()).hexdigest()[:20]

    def _reception(self, caller: Caller, r: ObsReception, s: ScopedObserver) -> dict:
        w = self.world
        cursor = w.obs_cursor(r.seq)
        return {"event_id": cursor, "packet_correlation_id": self._correlation(caller, r.packet),
                "reception_id": "rcp_" + hashlib.sha256(f"{caller.user_id}|{r.seq}".encode()).hexdigest()[:20],
                "observer_id": s.observer_id, "observed_at": iso(r.received_at), "received_at": iso(r.received_at),
                "clock_confidence": "high", "packet_kind": w.packets[r.packet]["kind"], "transport": "mqtt",
                "rssi": r.rssi, "snr": r.snr, "provenance": s.provenance}

    def _held(self, caller: Caller, names: dict[str, ScopedObserver], after: int) -> list[ObsReception]:
        return [r for r in self.world.obs_receptions if r.seq > after and r.observer in names]

    def _event(self, caller: Caller, r: ObsReception, s: ScopedObserver) -> dict:
        rec = self._reception(caller, r, s)
        return {"event_id": rec["event_id"], "kind": "reception", "occurred_at": rec["received_at"], "version": 1,
                "reception": rec}

    async def observers(self, caller: Caller, scope: Sequence[ScopedObserver], cursor: str | None,
                        limit: int) -> ObserverPage:
        self._check()
        w = self.world
        start = 0
        if cursor:
            digits = cursor.removeprefix("obp_")
            if not cursor.startswith("obp_") or not (digits.isascii() and digits.isdigit()):
                raise CoreError("gone", "cursor_expired")
            start = int(digits, 10)
        names = self._names(caller, scope)
        items = []
        for name, s in names.items():
            o = w.observers[name]
            heard = [r.received_at for r in w.obs_receptions if r.observer == name]
            last = max(heard) if heard else None
            age = (now() - last).total_seconds() if last else None
            state = "offline" if age is None or age > OFFLINE_S else "live" if age <= LIVE_S else "stale"
            loc = o.get("location")
            location = None if loc is None or s.location_precision_m is None else {
                "lat": loc["lat"], "lon": loc["lon"], "precision_m": s.location_precision_m}
            items.append({"observer_id": s.observer_id, "label": o["label"], "location": location,
                          "freshness": {"last_heard_at": iso(last), "state": state}})
        items.sort(key=lambda i: i["observer_id"])
        chunk = items[start:start + limit]
        return ObserverPage(chunk, f"obp_{start + limit}" if start + limit < len(items) else None)

    async def snapshot(self, caller: Caller, scope: Sequence[ScopedObserver], since: str | None,
                       limit: int) -> SnapshotResult:
        self._check()
        w = self.world
        names = self._names(caller, scope)
        if since is not None:
            after = w.parse_obs_cursor(since)
            if after is None:
                raise CoreError("gone", "cursor_expired")
            held = self._held(caller, names, after)
            cursor = w.obs_cursor(held[limit - 1].seq) if len(held) > limit else w.obs_cursor(w.obs_seq)
            held = held[:limit]
        else:
            held = self._held(caller, names, w.obs_floor)[-limit:]
            cursor = w.obs_cursor(w.obs_seq)
        return SnapshotResult([self._reception(caller, r, names[r.observer]) for r in held], cursor,
                              now() + SNAPSHOT_LIFETIME)

    async def events_after(self, caller: Caller, scope: Sequence[ScopedObserver], cursor: str | None,
                           wait_s: float) -> EventBatch:
        self._check()
        w = self.world
        if cursor is None:
            start = w.obs_seq
        else:
            start = w.parse_obs_cursor(cursor)
            if start is None:
                raise CoreError("gone", "cursor_expired")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_s
        while True:
            names = self._names(caller, scope)
            held = self._held(caller, names, start)
            if held or loop.time() >= deadline:
                return EventBatch([self._event(caller, r, names[r.observer]) for r in held], w.obs_cursor(w.obs_seq))
            await asyncio.sleep(self.tick)
