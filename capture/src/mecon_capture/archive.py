"""The raw capture archive: a SQLite file of its own, appended to in batches.

Implements contracts/raw-capture/v1. One append is one transaction: the valid captures of a batch are
committed together or not at all. A capture that fails capture.schema.json is rejected alone. A valid
capture whose payload is over the limit is committed as a stub (size and content hash, no bytes); so is a
capture that arrives as a stub. This archive accepts at its commit: it counts a batch only once COMMIT has
succeeded, so a failure before or during the write answers unavailable and counts nothing but that.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import sqlite3
import threading
from typing import Any

BATCH_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
SOURCE_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
B64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")
RECEIVED_AT_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
HASH_RE = re.compile(r"[0-9a-f]{64}")
COMMON_KEYS = {"source", "topic", "retained", "received_at"}
FULL_KEYS = COMMON_KEYS | {"payload_b64"}
STUB_KEYS = COMMON_KEYS | {"stub"}
MAX_BATCH = 500

_SCHEMA = """
CREATE TABLE IF NOT EXISTS captures (
    capture_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT    NOT NULL,
    topic        TEXT    NOT NULL,
    payload      BLOB,
    payload_size INTEGER NOT NULL,
    content_hash TEXT    NOT NULL,
    stub         INTEGER NOT NULL CHECK (stub IN (0, 1)),
    retained     INTEGER NOT NULL CHECK (retained IN (0, 1)),
    received_at  TEXT    NOT NULL,
    CHECK ((stub = 1 AND payload IS NULL) OR (stub = 0 AND payload IS NOT NULL))
)
"""


def content_hash(topic: str, payload: bytes) -> str:
    """SHA-256 as lowercase hex over the topic's UTF-8 bytes, one zero byte, then the payload bytes."""
    return hashlib.sha256(topic.encode("utf-8") + b"\x00" + payload).hexdigest()


def check_capture(c: Any) -> tuple[bytes | None, int, str] | None:
    """(payload bytes or None for an arrived stub, size, content hash) of a capture that satisfies
    capture.schema.json, or None when it does not.

    Beyond the schema's pattern, a payload_b64 must really decode as base64 (the schema marks it
    contentEncoding base64), and the topic must be encodable as UTF-8 (the content hash needs it). A capture
    that arrives as a stub carries its own size and hash; the archive cannot check the hash, so it does not
    decode anything for it. Exactly one of payload_b64 and stub must be present.
    """
    if not isinstance(c, dict) or set(c) not in (FULL_KEYS, STUB_KEYS):
        return None
    src, topic, retained, at = c["source"], c["topic"], c["retained"], c["received_at"]
    if not (isinstance(src, str) and SOURCE_RE.fullmatch(src)):
        return None
    if not (isinstance(topic, str) and 1 <= len(topic) <= 512):
        return None
    if not isinstance(retained, bool):
        return None
    if not (isinstance(at, str) and RECEIVED_AT_RE.fullmatch(at)):
        return None
    try:
        topic.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if "stub" in c:
        st = c["stub"]
        if not (isinstance(st, dict) and set(st) == {"size", "content_hash"}):
            return None
        size, h = st["size"], st["content_hash"]
        if not (isinstance(size, int) and not isinstance(size, bool) and size >= 1):
            return None
        if not (isinstance(h, str) and HASH_RE.fullmatch(h)):
            return None
        return None, size, h
    b64 = c["payload_b64"]
    if not (isinstance(b64, str) and B64_RE.fullmatch(b64)):
        return None
    try:
        payload = base64.b64decode(b64, validate=True)
    except binascii.Error:
        return None
    return payload, len(payload), content_hash(topic, payload)


def is_valid_capture(c: Any) -> bool:
    return check_capture(c) is not None


class Archive:
    def __init__(self, path: str, max_payload_bytes: int = 65536) -> None:
        self.path = path
        self.max_payload_bytes = max_payload_bytes
        self._write_lock = threading.Lock()  # one append at a time
        self._state = threading.Lock()  # guards the counters; never held across I/O
        self._received = self._committed = self._rejected = self._stubbed = 0
        self._unavailable = 0
        self._conn = self._open()

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False, timeout=5.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute(_SCHEMA)
        return conn

    def close(self) -> None:
        with self._write_lock:
            self._conn.close()

    # ---- append ---------------------------------------------------------------------------

    def append(self, batch_id: str, captures: list[Any]) -> dict[str, Any]:
        """Commit a batch. Returns an append-result document.

        A malformed request (bad batch_id, an empty or oversized batch) is a caller bug and raises
        ValueError; it is not an append the archive accepts.
        """
        if not (isinstance(batch_id, str) and BATCH_ID_RE.fullmatch(batch_id)):
            raise ValueError("batch_id must match [A-Za-z0-9_-]{1,64}")
        if not (isinstance(captures, list) and 1 <= len(captures) <= MAX_BATCH):
            raise ValueError(f"a batch holds 1 to {MAX_BATCH} captures")
        with self._write_lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")  # the write lock: no lock, no acceptance
                rejected: list[dict[str, Any]] = []
                stubbed: list[int] = []
                rows = []
                for i, c in enumerate(captures):
                    checked = check_capture(c)
                    if checked is None:
                        rejected.append({"index": i, "reason": "malformed"})
                        continue
                    payload, size, digest = checked
                    stub = payload is None or size > self.max_payload_bytes
                    if stub:
                        stubbed.append(i)
                    rows.append((
                        c["source"], c["topic"], None if stub else payload, size,
                        digest, int(stub), int(c["retained"]), c["received_at"],
                    ))
                for row in rows:
                    self._conn.execute(
                        "INSERT INTO captures (source, topic, payload, payload_size, content_hash, stub, retained, received_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row)
                self._conn.execute("COMMIT")
            except (sqlite3.Error, OSError):
                self._rollback()
                return self._unavailable_result(batch_id)
            with self._state:  # accepted at the commit: all four counted together, in one step
                self._received += len(captures)
                self._committed += len(rows)
                self._rejected += len(rejected)
                self._stubbed += len(stubbed)
        return {"batch_id": batch_id, "storage": "available", "committed": len(rows),
                "rejected": rejected, "stubbed": stubbed}

    def _rollback(self) -> None:
        try:
            self._conn.execute("ROLLBACK")
        except (sqlite3.Error, OSError):
            pass

    def _unavailable_result(self, batch_id: str) -> dict[str, Any]:
        with self._state:
            self._unavailable += 1
        return {"batch_id": batch_id, "storage": "unavailable", "committed": 0, "rejected": [], "stubbed": []}

    # ---- counters and reads ---------------------------------------------------------------

    def counters(self) -> dict[str, Any]:
        """This archive accepts at its commit, so nothing is ever in flight (buffered 0, no oldest) and it
        sheds nothing (dropped 0): a producer's own shed captures are the producer's to count."""
        with self._state:
            return {
                "received": self._received, "committed": self._committed, "rejected": self._rejected,
                "stubbed": self._stubbed, "unavailable_batches": self._unavailable,
                "buffered": 0, "dropped": 0, "oldest_buffered_ms": None,
            }

    def read_committed(self, after_id: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
        """Committed captures with capture_id > after_id, in capture_id order. A stub has payload None."""
        conn = sqlite3.connect(self.path, timeout=5.0)
        try:
            sql = ("SELECT capture_id, source, topic, payload, payload_size, content_hash, stub, retained, received_at"
                   " FROM captures WHERE capture_id > ? ORDER BY capture_id")
            args: tuple[Any, ...] = (after_id,)
            if limit is not None:
                sql += " LIMIT ?"
                args += (limit,)
            return [
                {"capture_id": r[0], "source": r[1], "topic": r[2], "payload": None if r[3] is None else bytes(r[3]),
                 "payload_size": r[4], "content_hash": r[5], "stub": bool(r[6]), "retained": bool(r[7]),
                 "received_at": r[8]}
                for r in conn.execute(sql, args)
            ]
        finally:
            conn.close()
