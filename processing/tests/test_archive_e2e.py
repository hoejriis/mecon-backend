"""Captures from a real capture Archive file flow through the reader, the processor and the store."""

import base64
import json
import pathlib
import sqlite3
import sys

import pytest
from helpers import b64, make, packet

from mecon_processing.documents import ArchiveReader

CAPTURE_SRC = pathlib.Path(__file__).resolve().parents[2] / "capture" / "src"
if CAPTURE_SRC.is_dir():
    sys.path.insert(0, str(CAPTURE_SRC))
try:
    from mecon_capture.archive import Archive
except ImportError:  # the capture package is not beside this one: build the same table shape
    Archive = None

SHAPE = """
CREATE TABLE captures (
    capture_id   INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, topic TEXT NOT NULL, payload BLOB,
    payload_size INTEGER NOT NULL, content_hash TEXT NOT NULL, stub INTEGER NOT NULL, retained INTEGER NOT NULL,
    received_at  TEXT NOT NULL)
"""
HEX = packet(ptype=5, payload=b"hello").hex()


def doc(topic, payload, at, retained=False, source="own-broker"):
    return {"source": source, "topic": topic, "payload_b64": b64(payload), "retained": retained, "received_at": at}


def make_archive(path):
    batch = [
        doc("meshcore/AB12/obs-1/packets", json.dumps({"data": HEX, "RSSI": -90, "SNR": 7.5}).encode(), "2026-01-01T00:00:00.100Z"),
        doc("meshcore/AB12/obs-1/status", b"{}", "2026-01-01T00:00:00.200Z"),
        doc("meshcore/AB12/obs-1/packets", b"x" * 100, "2026-01-01T00:00:00.300Z"),  # over the limit: a stub
        doc("packets/obs-9", HEX.encode(), "2026-01-01T00:00:00.400Z", source="open-feed"),
        doc("meshcore/AB12/obs-1/packets", json.dumps({"data": HEX}).encode(), "2026-01-01T00:00:00.500Z", retained=True),
    ]
    if Archive is not None:
        a = Archive(str(path), max_payload_bytes=64)
        assert a.append("b1", batch)["committed"] == 5
        a.close()
        return
    conn = sqlite3.connect(path)
    conn.execute(SHAPE)
    for c in batch:
        p = base64.b64decode(c["payload_b64"])
        stub = len(p) > 64
        conn.execute("INSERT INTO captures (source, topic, payload, payload_size, content_hash, stub, retained, received_at)"
                     " VALUES (?,?,?,?,?,?,?,?)", (c["source"], c["topic"], None if stub else p, len(p), "0" * 64, int(stub),
                                                    int(c["retained"]), c["received_at"]))
    conn.commit()
    conn.close()


def test_a_real_archive_file_flows_end_to_end(tmp_path, schemas):
    path = tmp_path / "archive.sqlite3"
    make_archive(path)
    reader = ArchiveReader(str(path))
    assert reader.pending(0) == (5, "2026-01-01T00:00:00.100Z")
    store, proc = make(tmp_path)
    assert proc.drain(reader) == 5
    assert [(o["capture_id"], o.get("reason", "reception")) for o in store.outcomes()] == [
        (1, "reception"), (2, "not_a_packet"), (3, "stub"), (4, "reception"), (5, "retained")]
    r = store.receptions()
    assert [(x["observer_key"], x["rssi"], x["snr"]) for x in r] == [("obs-1", -90, 7.5), ("obs-9", None, None)]
    assert r[0]["packet_id"] == r[1]["packet_id"] and len(store.packets()) == 1
    assert store.hours() == store.computed_hours() and len(store.hours()) == 2
    c = proc.counters(reader)
    assert c["pending"] == 0 and c["processed"] == 5 and schemas["counters"].is_valid(c)
    for x in r:
        assert schemas["reception"].is_valid(x)


def test_the_archive_is_opened_read_only_and_new_captures_are_picked_up(tmp_path):
    path = tmp_path / "archive.sqlite3"
    make_archive(path)
    reader = ArchiveReader(str(path))
    with pytest.raises(sqlite3.OperationalError):
        conn = reader._connect()
        try:
            conn.execute("DELETE FROM captures")
        finally:
            conn.close()
    assert reader.pending(0)[0] == 5
    if Archive is not None:
        a = Archive(str(path), max_payload_bytes=64)
        a.append("b2", [doc("packets/obs-2", HEX.encode(), "2026-01-01T00:00:01.000Z", source="open-feed")])
        a.close()
        assert reader.pending(5) == (1, "2026-01-01T00:00:01.000Z")
        assert [c["capture_id"] for c in reader.read(3, 10)] == [4, 5, 6]
        assert reader.read(0, 2)[0]["payload"] is not None and reader.read(0, 3)[2]["payload"] is None
