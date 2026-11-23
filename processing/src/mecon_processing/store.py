"""The processor's own SQLite store (WAL): packets, receptions, outcomes, hourly aggregates and a progress mark.

A batch is one transaction: outcomes, packets, receptions, aggregates and the progress mark commit together, or
none of them do. `receptions.capture_id` is UNIQUE, the contract's idempotence key.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

_SCHEMA = """
CREATE TABLE IF NOT EXISTS packets (
    packet_id     TEXT PRIMARY KEY,
    packet_type   TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receptions (
    capture_id         INTEGER NOT NULL UNIQUE,
    packet_id          TEXT    NOT NULL,
    source             TEXT    NOT NULL,
    observer_key       TEXT,
    received_at        TEXT    NOT NULL,
    device_observed_at INTEGER,
    rssi               REAL,
    snr                REAL,
    hop_count          INTEGER NOT NULL,
    route_type         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receptions_dup ON receptions (packet_id, source);
-- Reads by observer, in position order: the Reader backend's observation reads ask for a caller's observers only.
CREATE INDEX IF NOT EXISTS receptions_observer ON receptions (source, observer_key, capture_id);
CREATE TABLE IF NOT EXISTS outcomes (
    capture_id INTEGER PRIMARY KEY,
    outcome    TEXT NOT NULL CHECK (outcome IN ('reception', 'skipped')),
    reason     TEXT,
    CHECK ((outcome = 'skipped') = (reason IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS hours (
    source       TEXT    NOT NULL,
    observer_key TEXT    NOT NULL,
    hour         TEXT    NOT NULL,
    receptions   INTEGER NOT NULL,
    rssi_sum     REAL    NOT NULL,
    rssi_count   INTEGER NOT NULL,
    snr_sum      REAL    NOT NULL,
    snr_count    INTEGER NOT NULL,
    PRIMARY KEY (source, observer_key, hour)
);
CREATE TABLE IF NOT EXISTS progress (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_capture_id INTEGER NOT NULL
);
"""

RECEPTION_COLUMNS = ("capture_id", "packet_id", "source", "observer_key", "received_at", "device_observed_at",
                     "rssi", "snr", "hop_count", "route_type")
HOUR_COLUMNS = ("source", "observer_key", "hour", "receptions", "rssi_sum", "rssi_count", "snr_sum", "snr_count")


def hour_of(received_at: str) -> str:
    return received_at[:13] + ":00:00Z"


class Batch:
    """The writes of one batch, inside its transaction."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._c = conn

    def has_outcome(self, capture_id: int) -> bool:
        return self._c.execute("SELECT 1 FROM outcomes WHERE capture_id = ?", (capture_id,)).fetchone() is not None

    def add_outcome(self, capture_id: int, outcome: str, reason: str | None = None) -> None:
        self._c.execute("INSERT INTO outcomes (capture_id, outcome, reason) VALUES (?, ?, ?)",
                        (capture_id, outcome, reason))

    def see_packet(self, packet_id: str, packet_type: str, received_at: str) -> None:
        """First sight sets first_seen_at; a later sight raises last_seen_at, never lowers it."""
        cur = self._c.execute("INSERT OR IGNORE INTO packets (packet_id, packet_type, first_seen_at, last_seen_at)"
                              " VALUES (?, ?, ?, ?)", (packet_id, packet_type, received_at, received_at))
        if cur.rowcount == 0:
            self._c.execute("UPDATE packets SET last_seen_at = ? WHERE packet_id = ? AND last_seen_at < ?",
                            (received_at, packet_id, received_at))

    def has_duplicate(self, r: dict[str, Any]) -> bool:
        """An earlier reception of the same packet, source and observer with the same device time, rssi and snr
        (null equals null)."""
        return self._c.execute(
            "SELECT 1 FROM receptions WHERE packet_id = ? AND source = ? AND observer_key IS ?"
            " AND device_observed_at IS ? AND rssi IS ? AND snr IS ? LIMIT 1",
            (r["packet_id"], r["source"], r["observer_key"], r["device_observed_at"], r["rssi"], r["snr"]),
        ).fetchone() is not None

    def add_reception(self, r: dict[str, Any]) -> None:
        self._c.execute("INSERT INTO receptions (" + ", ".join(RECEPTION_COLUMNS) + ") VALUES (?,?,?,?,?,?,?,?,?,?)",
                        tuple(r[k] for k in RECEPTION_COLUMNS))
        if r["observer_key"] is None:
            return  # a reception with no observer is not folded
        self._c.execute(
            "INSERT INTO hours (source, observer_key, hour, receptions, rssi_sum, rssi_count, snr_sum, snr_count)"
            " VALUES (?, ?, ?, 1, ?, ?, ?, ?)"
            " ON CONFLICT (source, observer_key, hour) DO UPDATE SET receptions = receptions + 1,"
            " rssi_sum = rssi_sum + excluded.rssi_sum, rssi_count = rssi_count + excluded.rssi_count,"
            " snr_sum = snr_sum + excluded.snr_sum, snr_count = snr_count + excluded.snr_count",
            (r["source"], r["observer_key"], hour_of(r["received_at"]),
             r["rssi"] if r["rssi"] is not None else 0.0, int(r["rssi"] is not None),
             r["snr"] if r["snr"] is not None else 0.0, int(r["snr"] is not None)))

    def set_progress(self, capture_id: int) -> None:
        self._c.execute("INSERT INTO progress (id, last_capture_id) VALUES (1, ?)"
                        " ON CONFLICT (id) DO UPDATE SET last_capture_id = MAX(last_capture_id, excluded.last_capture_id)",
                        (capture_id,))


def fold_hours(receptions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The hourly aggregate as a fold over receptions in capture order; none for a reception with no observer."""
    acc: dict[tuple[str, str, str], dict[str, Any]] = {}
    for r in receptions:
        if r["observer_key"] is None:
            continue
        key = (r["source"], r["observer_key"], hour_of(r["received_at"]))
        h = acc.setdefault(key, dict(zip(HOUR_COLUMNS, (*key, 0, 0.0, 0, 0.0, 0))))
        h["receptions"] += 1
        if r["rssi"] is not None:
            h["rssi_sum"] += r["rssi"]
            h["rssi_count"] += 1
        if r["snr"] is not None:
            h["snr_sum"] += r["snr"]
            h["snr_count"] += 1
    return [acc[k] for k in sorted(acc)]


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5.0)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def batch(self) -> Iterator[Batch]:
        """One transaction: commits when the block ends, rolls back entirely when it raises."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield Batch(self._conn)
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def progress(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT last_capture_id FROM progress WHERE id = 1").fetchone()
        return 0 if row is None else row[0]

    def _rows(self, sql: str, columns: tuple[str, ...]) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(zip(columns, r)) for r in self._conn.execute(sql)]

    def outcomes(self) -> list[dict[str, Any]]:
        rows = self._rows("SELECT capture_id, outcome, reason FROM outcomes ORDER BY capture_id",
                          ("capture_id", "outcome", "reason"))
        return [{k: v for k, v in r.items() if k != "reason" or v is not None} for r in rows]

    def packets(self) -> list[dict[str, Any]]:
        return self._rows("SELECT packet_id, packet_type, first_seen_at, last_seen_at FROM packets ORDER BY packet_id",
                          ("packet_id", "packet_type", "first_seen_at", "last_seen_at"))

    def receptions(self) -> list[dict[str, Any]]:
        return self._rows("SELECT " + ", ".join(RECEPTION_COLUMNS) + " FROM receptions ORDER BY capture_id",
                          RECEPTION_COLUMNS)

    def hours(self) -> list[dict[str, Any]]:
        return self._rows("SELECT " + ", ".join(HOUR_COLUMNS) + " FROM hours ORDER BY source, observer_key, hour",
                          HOUR_COLUMNS)

    def computed_hours(self) -> list[dict[str, Any]]:
        """The hourly aggregate recomputed from the receptions alone (not stored)."""
        return fold_hours(self.receptions())

    def rebuild_hours(self) -> list[dict[str, Any]]:
        """Replace the stored aggregate by a fold over all receptions, in one transaction; returns the rows."""
        rows = self.computed_hours()
        with self.batch() as b:
            b._c.execute("DELETE FROM hours")
            for h in rows:
                b._c.execute("INSERT INTO hours (" + ", ".join(HOUR_COLUMNS) + ") VALUES (?,?,?,?,?,?,?,?)",
                             tuple(h[k] for k in HOUR_COLUMNS))
        return rows
