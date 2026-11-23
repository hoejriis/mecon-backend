"""A ReceptionStore over the processor's SQLite store (processing/): packets and receptions, read-only.

Observers are the processor's (source, observer_key) pairs. Their API ids are keyed hashes of that pair, so an id
reveals nothing about the topic or key it came from. The processor keeps no label or position: both come from an
`ObserverDirectory` the deployment supplies (a dict here; the real one is a later adapter), and a pair with no entry
is listed with a generic label and no location.

Nothing is carried past what the API allows: no packet hash (the correlation id is a keyed hash of the packet id
and the caller), no hop count or route type, no transmitter position, no payload. Each response is built field by
field from the reception row, never from the row as it is.

Cursors (and the event ids, which are cursors) are `obc_<sealed>_<tag>`. The position is a capture id: a place in
the store as a whole, which moves with every fleet's traffic. So it is never shown. `<sealed>` is the position
put through a keyed permutation of 64-bit numbers (a 4-round Feistel network on HMAC-SHA256), keyed per caller:
stable for one caller, so an event id dedups across snapshot and stream, but its order and gaps say nothing
about how much was stored between two of the caller's receptions. The tag, a keyed MAC over caller and sealed
value, makes a cursor work for the caller it was issued to and for nobody else.

Every query runs on its own read-only connection, off the event loop.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Sequence

from .ports import Caller, CoreError, EventBatch, ObserverPage, ScopedObserver, SnapshotResult

STORE_TIME = "%Y-%m-%dT%H:%M:%S.%fZ"  # received_at as the processor writes it
API_TIME = "%Y-%m-%dT%H:%M:%SZ"

# packet_type (the processor's names) -> the API's class. Anything not listed, including TRACE and PATH, is unknown:
# those two exist to describe a route, which this API never carries.
PACKET_KIND = {
    "TEXT_MESSAGE": "direct_message", "GROUP_TEXT": "channel_message", "GROUP_DATA": "channel_message",
    "ADVERT": "advert", "ACK": "acknowledgement", "CONTROL": "control",
}


@dataclass(frozen=True)
class ObserverInfo:
    label: str
    lat: float | None = None
    lon: float | None = None


ObserverDirectory = Mapping[str, ObserverInfo]  # keyed by the observer's API id


def _b64(raw: bytes, n: int) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")[:n]


def _tag(raw: bytes) -> str:
    return raw.hex()[:16]


def _round_rssi(x: Any) -> int | None:
    if x is None or isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        return None
    n = int(math.floor(x + 0.5))
    return n if -200 <= n <= 0 else None


def _snr(x: Any) -> float | None:
    if x is None or isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        return None
    return float(x) if -60 <= x <= 60 else None


def _api_time(store_time: str) -> str:
    return datetime.strptime(store_time, STORE_TIME).strftime(API_TIME)


def _parse_store_time(store_time: str) -> datetime:
    return datetime.strptime(store_time, STORE_TIME).replace(tzinfo=timezone.utc)


class SqliteReceptionStore:
    def __init__(self, path: str, *, key: bytes, directory: ObserverDirectory | None = None,
                 retention_s: int = 86_400, live_s: int = 900, offline_s: int = 21_600, max_delay_s: int = 86_400,
                 poll_s: float = 0.25, clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        if len(key) < 16:
            raise ValueError("the id key must be at least 16 bytes")
        self.path, self._key, self.directory = path, key, dict(directory or {})
        self.retention_s, self.live_s, self.offline_s, self.max_delay_s = retention_s, live_s, offline_s, max_delay_s
        self.poll_s, self._clock = poll_s, clock

    # ---- ids ----

    def _mac(self, *parts: str) -> bytes:
        return hmac.new(self._key, b"\x00".join(p.encode() for p in parts), hashlib.sha256).digest()

    def observer_id(self, source: str, observer_key: str) -> str:
        """The API id of an observer. A real ObservationScope computes the same ids with this function."""
        return "obs_" + _b64(self._mac("observer", source, observer_key), 22)

    def _correlation(self, caller: Caller, packet_id: str) -> str:
        # Never the packet's hash: a keyed hash of it, bound to the caller, so two callers cannot match theirs.
        return "pkc_" + _b64(self._mac("correlation", caller.user_id, packet_id), 22)

    def _reception_id(self, caller: Caller, capture_id: int) -> str:
        return "rcp_" + _b64(self._mac("reception", caller.user_id, str(capture_id)), 22)

    def _permute(self, caller: Caller, x: int, forward: bool) -> int:
        """A keyed permutation of 64-bit numbers, per caller: 4 Feistel rounds with HMAC-SHA256 as the round
        function. forward=False inverts it."""
        key = self._mac("cursor-permutation", caller.user_id)
        left, right = x >> 32, x & 0xFFFFFFFF
        rounds = range(4) if forward else range(3, -1, -1)
        for i in rounds:
            if forward:
                f = int.from_bytes(hmac.new(key, bytes([i]) + right.to_bytes(4, "big"), hashlib.sha256).digest()[:4], "big")
                left, right = right, left ^ f
            else:
                f = int.from_bytes(hmac.new(key, bytes([i]) + left.to_bytes(4, "big"), hashlib.sha256).digest()[:4], "big")
                left, right = right ^ f, left
        return (left << 32) | right

    def cursor(self, caller: Caller, position: int) -> str:
        sealed = format(self._permute(caller, position, True), "016x")
        return f"obc_{sealed}_" + _tag(self._mac("cursor", caller.user_id, sealed))

    def _position(self, caller: Caller, cursor: str) -> int:
        parts = cursor.split("_")
        if (len(parts) != 3 or parts[0] != "obc" or len(parts[1]) != 16
                or any(ch not in "0123456789abcdef" for ch in parts[1])):
            raise CoreError("gone", "cursor_expired")
        if not hmac.compare_digest(parts[2], _tag(self._mac("cursor", caller.user_id, parts[1]))):
            raise CoreError("gone", "cursor_expired")
        return self._permute(caller, int(parts[1], 16), False)

    # ---- reading ----

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=5.0)
        conn.execute("PRAGMA query_only = 1")
        return conn

    async def _run(self, fn: Callable[[sqlite3.Connection], Any]) -> Any:
        def work() -> Any:
            conn = self._connect()
            try:
                return fn(conn)
            finally:
                conn.close()
        try:
            return await asyncio.to_thread(work)
        except sqlite3.Error:
            raise CoreError("unavailable") from None

    def _allowed(self, conn: sqlite3.Connection, scope: Sequence[ScopedObserver]) -> dict[tuple[str, str], ScopedObserver]:
        """The (source, observer_key) pairs the scope names: the one scope filter, applied before any reception is read."""
        by_id = {s.observer_id: s for s in scope}
        out = {}
        for source, key in conn.execute("SELECT DISTINCT source, observer_key FROM hours"):
            s = by_id.get(self.observer_id(source, key))
            if s is not None:
                out[(source, key)] = s
        return out

    def _floor(self, conn: sqlite3.Connection) -> int:
        cutoff = (self._clock() - timedelta(seconds=self.retention_s)).strftime(STORE_TIME)
        row = conn.execute("SELECT MAX(capture_id) FROM receptions WHERE received_at < ?", (cutoff,)).fetchone()
        return row[0] or 0

    def _head(self, conn: sqlite3.Connection) -> int:
        return conn.execute("SELECT MAX(capture_id) FROM receptions").fetchone()[0] or 0

    def _valid_position(self, conn: sqlite3.Connection, caller: Caller, cursor: str) -> int:
        pos = self._position(caller, cursor)
        if pos < self._floor(conn) or pos > self._head(conn):
            raise CoreError("gone", "cursor_expired")
        return pos

    _SELECT = ("SELECT r.capture_id, r.packet_id, r.source, r.observer_key, r.received_at, r.device_observed_at, "
               "r.rssi, r.snr, p.packet_type FROM receptions r JOIN packets p ON p.packet_id = r.packet_id ")

    #: (source, observer_key) pairs per query: two bound parameters each, well under SQLite's limit.
    SCOPE_CHUNK = 200

    def _scan(self, conn: sqlite3.Connection, allowed: Mapping[tuple[str, str], ScopedObserver], *, after: int,
              limit: int, newest_first: bool) -> list[tuple]:
        """Receptions of allowed observers after a position, at most `limit`, in position order.

        The scope is a bound `(source, observer_key) IN (VALUES ...)` in the query, in chunks of SCOPE_CHUNK
        pairs, so a reception of an observer outside the scope is never read; each chunk's answer is already
        ordered and limited, and the chunks are merged by position."""
        if not allowed or limit <= 0:
            return []
        pairs = sorted(allowed)
        if newest_first:
            bound, args = "r.capture_id < ? AND r.capture_id > ? ", [self._head(conn) + 1, max(after, self._floor(conn))]
            order = "ORDER BY r.capture_id DESC "
        else:
            bound, args = "r.capture_id > ? ", [after]
            order = "ORDER BY r.capture_id "
        out: list[tuple] = []
        for k in range(0, len(pairs), self.SCOPE_CHUNK):
            chunk = pairs[k:k + self.SCOPE_CHUNK]
            values = ", ".join("(?, ?)" for _ in chunk)
            params = [x for pair in chunk for x in pair] + args + [limit]
            out += conn.execute(self._SELECT + f"WHERE (r.source, r.observer_key) IN (VALUES {values}) AND " + bound
                                + order + "LIMIT ?", params).fetchall()
        out.sort(key=lambda row: row[0], reverse=newest_first)
        return out[:limit]

    def _clock_confidence(self, received_at: str, observed: int | None) -> tuple[str, str]:
        """(observed_at, clock_confidence). The processor keeps a device time only after it passed its own checks, so
        a missing one is `unknown`; one far behind the Backend's receipt, or ahead of it, is `low`."""
        if observed is None:
            return _api_time(received_at), "unknown"
        at = datetime.fromtimestamp(observed, timezone.utc)
        skew = (_parse_store_time(received_at) - at).total_seconds()
        return at.strftime(API_TIME), "low" if skew < -60 or skew > self.max_delay_s else "high"

    def _reception(self, caller: Caller, row: tuple, s: ScopedObserver) -> dict[str, Any]:
        capture_id, packet_id, _source, _key, received_at, observed, rssi, snr, packet_type = row
        observed_at, confidence = self._clock_confidence(received_at, observed)
        return {"event_id": self.cursor(caller, capture_id),
                "packet_correlation_id": self._correlation(caller, packet_id),
                "reception_id": self._reception_id(caller, capture_id), "observer_id": s.observer_id,
                "observed_at": observed_at, "received_at": _api_time(received_at), "clock_confidence": confidence,
                "packet_kind": PACKET_KIND.get(packet_type, "unknown"), "transport": "mqtt",
                "rssi": _round_rssi(rssi), "snr": _snr(snr), "provenance": s.provenance}

    # ---- the port ----

    async def observers(self, caller: Caller, scope: Sequence[ScopedObserver], cursor: str | None,
                        limit: int) -> ObserverPage:
        start = 0
        if cursor:
            parts = cursor.split("_")
            if (len(parts) != 3 or parts[0] != "obp" or not (parts[1].isascii() and parts[1].isdigit())
                    or len(parts[1]) > 9
                    or not hmac.compare_digest(parts[2], _tag(self._mac("obs-page", caller.user_id, parts[1])))):
                raise CoreError("gone", "cursor_expired")
            start = int(parts[1])
        now = self._clock()

        def read(conn: sqlite3.Connection) -> list[dict[str, Any]]:
            allowed = self._allowed(conn, scope)
            heard = {(s, k): t for s, k, t in conn.execute(
                "SELECT source, observer_key, MAX(received_at) FROM receptions WHERE observer_key IS NOT NULL "
                "GROUP BY source, observer_key")}
            items = []
            for (source, key), s in allowed.items():
                info = self.directory.get(s.observer_id)
                last = heard.get((source, key))
                age = None if last is None else (now - _parse_store_time(last)).total_seconds()
                state = "offline" if age is None or age > self.offline_s else "live" if age <= self.live_s else "stale"
                shown = (info is not None and info.lat is not None and info.lon is not None
                         and s.location_precision_m is not None)
                items.append({"observer_id": s.observer_id,
                              "label": info.label if info else "Observer " + s.observer_id[4:10],
                              "location": {"lat": info.lat, "lon": info.lon, "precision_m": s.location_precision_m}
                              if shown else None,
                              "freshness": {"last_heard_at": None if last is None else _api_time(last),
                                            "state": state}})
            return sorted(items, key=lambda i: i["observer_id"])

        items = await self._run(read)
        chunk = items[start:start + limit]
        nxt = None
        if start + limit < len(items):
            n = str(start + limit)
            nxt = f"obp_{n}_" + _tag(self._mac("obs-page", caller.user_id, n))
        return ObserverPage(chunk, nxt)

    async def snapshot(self, caller: Caller, scope: Sequence[ScopedObserver], since: str | None,
                       limit: int) -> SnapshotResult:
        def read(conn: sqlite3.Connection) -> tuple[list[dict[str, Any]], str]:
            after = self._valid_position(conn, caller, since) if since is not None else None
            allowed = self._allowed(conn, scope)
            head = self._head(conn)
            if after is None:
                rows = list(reversed(self._scan(conn, allowed, after=0, limit=limit, newest_first=True)))
                position = head
            else:
                rows = self._scan(conn, allowed, after=after, limit=limit + 1, newest_first=False)
                position = rows[limit - 1][0] if len(rows) > limit else head
                rows = rows[:limit]
            return [self._reception(caller, r, allowed[(r[2], r[3])]) for r in rows], self.cursor(caller, position)

        items, cursor = await self._run(read)
        return SnapshotResult(items, cursor, self._clock() + timedelta(seconds=self.retention_s))

    async def events_after(self, caller: Caller, scope: Sequence[ScopedObserver], cursor: str | None,
                           wait_s: float) -> EventBatch:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_s
        start: int | None = None
        while True:
            def read(conn: sqlite3.Connection) -> tuple[list[dict[str, Any]], int]:
                nonlocal start
                if start is None:
                    start = self._head(conn) if cursor is None else self._valid_position(conn, caller, cursor)
                else:
                    self._valid_position(conn, caller, self.cursor(caller, start))
                allowed = self._allowed(conn, scope)
                head = self._head(conn)
                rows = self._scan(conn, allowed, after=start, limit=500, newest_first=False)
                # A full page leaves the cursor at its last reception, so the next read continues from there.
                position = rows[-1][0] if len(rows) >= 500 else head
                events = []
                for r in rows:
                    rec = self._reception(caller, r, allowed[(r[2], r[3])])
                    events.append({"event_id": rec["event_id"], "kind": "reception", "occurred_at": rec["received_at"],
                                   "version": 1, "reception": rec})
                return events, position

            events, position = await self._run(read)
            if events or loop.time() >= deadline:
                return EventBatch(events, self.cursor(caller, position))
            await asyncio.sleep(min(self.poll_s, max(0.0, deadline - loop.time())))
