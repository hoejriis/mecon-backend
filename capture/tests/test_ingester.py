import base64
import threading
import time

import pytest

from conftest import sub_fixture
from fakes.faulty_connection import FaultyConnection
from fakes.fake_transport import FakeTransport
from helpers import Clock, make_ingester
from mecon_capture.ingester import iso_ms
import datetime as dt

PROF = sub_fixture("A")["cases"][2]["value"]


def test_client_id_is_prefix_source_and_instance_tag(tmp_path):
    p2 = dict(PROF, name="other-feed")
    ig, _a, tr, _l = make_ingester([PROF, p2], tmp_path, client_id_prefix="cap", instance_tag="x9")
    ig.start()
    try:
        assert tr["open-feed"].connected_with == [("open-feed", "cap-open-feed-x9")]
        assert tr["other-feed"].connected_with == [("other-feed", "cap-other-feed-x9")]
    finally:
        ig.stop()


def test_message_becomes_a_capture_unchanged_and_stamped_at_arrival(tmp_path):
    clock = Clock("2026-03-04T05:06:07.891Z")
    ig, archive, _t, _l = make_ingester([PROF], tmp_path, clock=clock)
    s = ig.sessions[0]
    payload = b"\x00\xff{\"a\": 1}  \n"
    s.on_message("packets/obs-1", payload, False)
    clock.advance_ms(60_000)  # time passes before the flush
    s.on_message("packets/obs-1", b"", True)
    assert ig.flush_once()
    a, b = archive.read_committed()
    assert a["payload"] == payload and a["received_at"] == "2026-03-04T05:06:07.891Z" and not a["retained"]
    assert b["payload"] == b"" and b["received_at"] == "2026-03-04T05:07:07.891Z" and b["retained"]
    assert a["source"] == "open-feed" and a["topic"] == "packets/obs-1"


def test_iso_ms_format_and_truncation():
    t = dt.datetime(2026, 1, 2, 3, 4, 5, 999999, tzinfo=dt.timezone.utc)
    assert iso_ms(t) == "2026-01-02T03:04:05.999Z"
    t2 = dt.datetime(2026, 1, 2, 3, 4, 5, 0, tzinfo=dt.timezone(dt.timedelta(hours=2)))
    assert iso_ms(t2) == "2026-01-02T01:04:05.000Z"


def test_full_buffer_counts_dropped_and_never_blocks(tmp_path):
    ig, archive, _t, _l = make_ingester([PROF], tmp_path, buffer_max=3)
    s = ig.sessions[0]
    gate = threading.Lock()
    gate.acquire()
    real = archive.append

    def blocked(*a, **k):  # the archive is stuck: any caller of append would hang
        if not gate.acquire(timeout=3):
            raise AssertionError("the receive path waited on the archive")
        return real(*a, **k)

    archive.append = blocked
    t0 = time.monotonic()
    for i in range(1000):
        s.on_message("t", b"x", False)
    elapsed = time.monotonic() - t0
    assert elapsed < 1.0
    c = archive.counters()
    assert c["dropped"] == 997 and c["received"] == 997 and len(ig.buffer) == 3
    assert c["received"] == c["committed"] + c["rejected"] + c["buffered"] + c["dropped"]
    gate.release()
    archive.append = real
    assert ig.flush_once()
    c = archive.counters()
    assert c["received"] == 1000 and c["committed"] == 3 and c["dropped"] == 997
    assert c["received"] == c["committed"] + c["rejected"] + c["buffered"] + c["dropped"]


def test_network_thread_never_touches_the_archive_file(tmp_path):
    ig, archive, _t, _l = make_ingester([PROF], tmp_path)
    archive.append = lambda *a, **k: pytest.fail("append called from the receive path")
    for _ in range(10):
        ig.sessions[0].on_message("t", b"x", False)
    assert len(ig.buffer) == 10


def test_flush_batches_are_at_most_500_and_in_order(tmp_path):
    ig, archive, _t, _l = make_ingester([PROF], tmp_path, buffer_max=2000)
    sizes = []
    real = archive.append

    def spy(bid, caps):
        sizes.append(len(caps))
        return real(bid, caps)

    archive.append = spy
    for i in range(1201):
        ig.sessions[0].on_message("t", str(i).encode(), False)
    while len(ig.buffer):
        assert ig.flush_once()
    assert sizes == [500, 500, 201]
    assert [r["payload"] for r in archive.read_committed()] == [str(i).encode() for i in range(1201)]


def test_unavailable_keeps_the_batch_and_retries_it(tmp_path):
    ig, archive, _t, _l = make_ingester([PROF], tmp_path)
    for i in range(5):
        ig.sessions[0].on_message("t", str(i).encode(), False)
    good = archive._conn
    archive._conn = FaultyConnection(good, lambda w, n: w == "BEGIN")
    ids = []
    real = archive.append
    archive.append = lambda bid, caps: (ids.append(bid), real(bid, caps))[1]
    assert not ig.flush_once() and not ig.flush_once()
    assert len(ig.buffer) == 5 and archive.read_committed() == []
    archive._conn = good
    assert ig.flush_once() and len(ig.buffer) == 0
    assert len(set(ids)) == 1 and len(ids) == 3  # the same batch id on every retry
    assert [r["payload"] for r in archive.read_committed()] == [str(i).encode() for i in range(5)]
    c = archive.counters()
    assert c["unavailable_batches"] == 2 and c["received"] == c["committed"] == 5


def test_flusher_thread_commits_within_the_interval(tmp_path):
    ig, archive, _t, _l = make_ingester([PROF], tmp_path, flush_interval_s=0.05)
    ig.start()
    try:
        ig.sessions[0].on_message("t", b"x", False)
        end = time.time() + 5
        while time.time() < end and not archive.read_committed():
            time.sleep(0.02)
        assert len(archive.read_committed()) == 1
    finally:
        ig.stop()


def test_graceful_stop_flushes_the_buffer(tmp_path):
    ig, archive, tr, _l = make_ingester([PROF], tmp_path, flush_interval_s=60)  # the thread would not flush in time
    ig.start()
    for i in range(7):
        ig.sessions[0].on_message("t", b"x", False)
    ig.stop()
    assert len(archive.read_committed()) == 7 and len(ig.buffer) == 0
    assert tr["open-feed"].disconnects >= 1
    assert ig.sessions[0].status()["state"] == "disconnected"


def test_hard_stop_loses_the_buffer_and_stop_with_dead_archive_gives_up(tmp_path):
    ig, archive, _t, stream = make_ingester([PROF], tmp_path, flush_interval_s=60)
    archive._conn = FaultyConnection(archive._conn, lambda w, n: w == "BEGIN")
    ig.start()
    ig.sessions[0].on_message("t", b"x", False)
    t0 = time.monotonic()
    ig.stop(flush_timeout_s=0.5)
    assert time.monotonic() - t0 < 5
    assert len(ig.buffer) == 1 and any("buffer_lost_at_stop" in ln for ln in stream.lines)


def test_credential_missing_is_an_error_status_not_a_crash(tmp_path):
    from mecon_capture.transport import TransportError
    ig, archive, tr, _l = make_ingester([PROF], tmp_path)
    tr["open-feed"].fail_connect = TransportError("environment variable X is not set")
    ig.sessions[0].start()
    st = ig.sessions[0].status()
    assert st["state"] == "error" and "X is not set" in st["last_error"]


def test_log_never_carries_payloads(tmp_path):
    ig, archive, _t, stream = make_ingester([PROF], tmp_path)
    ig.sessions[0].on_connack(0)
    ig.sessions[0].on_message("t", b"SECRET-PAYLOAD", False)
    ig.flush_once()
    assert not any("SECRET-PAYLOAD" in ln for ln in stream.lines)


def test_the_buffer_level_shows_what_waits_for_the_archive_and_for_how_long():
    """While storage is unavailable the archive's counters see nothing of what waits; the buffer's level does."""
    import datetime as dt

    from mecon_capture.archive import Archive
    from mecon_capture.ingester import CaptureBuffer

    buf = CaptureBuffer(3, Archive(":memory:"))
    now = dt.datetime(2026, 1, 1, 0, 0, 5, tzinfo=dt.timezone.utc)
    assert buf.level(now) == {"buffered": 0, "bound": 3, "oldest_buffered_ms": None}
    for at in ("2026-01-01T00:00:01.250Z", "2026-01-01T00:00:03.000Z"):
        buf.put({"source": "own-broker", "topic": "t/a", "payload_b64": "", "retained": False, "received_at": at})
    assert buf.level(now) == {"buffered": 2, "bound": 3, "oldest_buffered_ms": 3750}
    buf.discard(1)
    assert buf.level(now)["oldest_buffered_ms"] == 2000
