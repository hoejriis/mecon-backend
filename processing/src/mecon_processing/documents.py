"""The processor's input: committed captures (committed-capture.schema.json), and where they are read from.

Internally a capture is a dict with `capture_id`, `source`, `topic`, `payload` (bytes, or None for a stub),
`stub` (bool), `retained` and `received_at`: the shape a capture archive's `read_committed()` returns.
"""

from __future__ import annotations

import base64
import binascii
import re
import sqlite3
from typing import Any

SOURCE_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
B64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")
RECEIVED_AT_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
HASH_RE = re.compile(r"[0-9a-f]{64}")
KEYS = {"capture_id", "source", "topic", "payload_b64", "stub", "retained", "received_at"}
REQUIRED = {"capture_id", "source", "topic", "retained", "received_at"}


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_committed(doc: Any) -> list[str]:
    """Why `doc` is not a committed capture (committed-capture.schema.json); empty when it is one."""
    if not isinstance(doc, dict):
        return ["a committed capture must be an object"]
    out: list[str] = []
    for k in sorted(set(doc) - KEYS):
        out.append(f"unknown field {k!r}")
    for k in sorted(REQUIRED - set(doc)):
        out.append(f"missing {k!r}")
    if ("payload_b64" in doc) == ("stub" in doc):
        out.append("exactly one of payload_b64 and stub is required")
    if "capture_id" in doc and not (_is_int(doc["capture_id"]) and doc["capture_id"] >= 1):
        out.append("capture_id must be an integer of at least 1")
    if "source" in doc and not (isinstance(doc["source"], str) and SOURCE_RE.fullmatch(doc["source"])):
        out.append("source must match [a-z0-9][a-z0-9-]{0,62}")
    if "topic" in doc and not (isinstance(doc["topic"], str) and 1 <= len(doc["topic"]) <= 512):
        out.append("topic must be a string of 1 to 512 characters")
    if "retained" in doc and not isinstance(doc["retained"], bool):
        out.append("retained must be a boolean")
    if "received_at" in doc and not (isinstance(doc["received_at"], str) and RECEIVED_AT_RE.fullmatch(doc["received_at"])):
        out.append("received_at must be a UTC time with milliseconds")
    if "payload_b64" in doc:
        b = doc["payload_b64"]
        if not (isinstance(b, str) and B64_RE.fullmatch(b)):
            out.append("payload_b64 must be base64 text")
        else:
            try:
                base64.b64decode(b, validate=True)
            except binascii.Error:
                out.append("payload_b64 does not decode as base64")
    if "stub" in doc:
        s = doc["stub"]
        if not (isinstance(s, dict) and set(s) == {"size", "content_hash"}):
            out.append("stub must be an object of size and content_hash")
        else:
            if not (_is_int(s["size"]) and s["size"] >= 1):
                out.append("stub.size must be an integer of at least 1")
            if not (isinstance(s["content_hash"], str) and HASH_RE.fullmatch(s["content_hash"])):
                out.append("stub.content_hash must be 64 lowercase hex digits")
    return out


def from_document(doc: Any) -> dict[str, Any]:
    """A committed-capture document as the internal capture; ValueError when it is not valid."""
    problems = validate_committed(doc)
    if problems:
        raise ValueError("; ".join(problems))
    stub = "stub" in doc
    return {"capture_id": doc["capture_id"], "source": doc["source"], "topic": doc["topic"],
            "payload": None if stub else base64.b64decode(doc["payload_b64"], validate=True),
            "stub": stub, "retained": doc["retained"], "received_at": doc["received_at"]}


class ArchiveReader:
    """Reads a capture archive's committed captures, the archive file opened read-only (capture's table shape)."""

    def __init__(self, path: str) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        uri = "file:" + self.path.replace("%", "%25").replace("?", "%3f").replace("#", "%23") + "?mode=ro"
        return sqlite3.connect(uri, uri=True, timeout=5.0)

    def read(self, after_id: int, limit: int) -> list[dict[str, Any]]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT capture_id, source, topic, payload, stub, retained, received_at FROM captures"
                " WHERE capture_id > ? ORDER BY capture_id LIMIT ?", (after_id, limit)).fetchall()
        finally:
            conn.close()
        return [{"capture_id": r[0], "source": r[1], "topic": r[2], "payload": None if r[3] is None else bytes(r[3]),
                 "stub": bool(r[4]), "retained": bool(r[5]), "received_at": r[6]} for r in rows]

    def pending(self, after_id: int) -> tuple[int, str | None]:
        """(how many committed captures are past `after_id`, the earliest received_at among them)."""
        conn = self._connect()
        try:
            n, oldest = conn.execute("SELECT COUNT(*), MIN(received_at) FROM captures WHERE capture_id > ?",
                                     (after_id,)).fetchone()
        finally:
            conn.close()
        return n, oldest
