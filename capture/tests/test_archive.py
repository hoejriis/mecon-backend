import base64
import threading

import pytest

from conftest import raw_fixture
from fakes.faulty_connection import FaultyConnection
from mecon_capture.archive import Archive


def cap(i, payload=b"x", topic="t/a", source="src", retained=False):
    return {"source": source, "topic": topic, "payload_b64": base64.b64encode(payload).decode(),
            "retained": retained, "received_at": f"2026-01-01T00:00:00.{i % 1000:03d}Z"}


def rows(arch):
    return arch.read_committed()


def identity(c):
    return c["received"] == c["committed"] + c["rejected"] + c["buffered"] + c["dropped"]


@pytest.fixture
def arch(tmp_path):
    a = Archive(str(tmp_path / "a.sqlite3"), max_payload_bytes=8)
    yield a
    a.close()


def test_request_must_be_well_formed(arch):
    for bad in [("bad id!", [cap(0)]), ("x", []), ("x", [cap(0)] * 501), ("", [cap(0)]), ("x" * 65, [cap(0)])]:
        with pytest.raises(ValueError):
            arch.append(*bad)
    assert arch.counters()["received"] == 0  # a refused request is not an accepted append


def test_batch_of_500_commits_and_ids_increase(arch):
    r1 = arch.append("b1", [cap(i) for i in range(500)])
    r2 = arch.append("b2", [cap(i) for i in range(3)])
    assert r1["committed"] == 500 and r2["committed"] == 3
    ids = [r["capture_id"] for r in rows(arch)]
    assert ids == sorted(ids) and len(set(ids)) == 503
    assert [r["capture_id"] for r in arch.read_committed(after_id=ids[500], limit=2)] == ids[501:503]


def test_oversize_boundary_is_strictly_greater(arch):
    r = arch.append("b", [cap(0, b"12345678"), cap(1, b"123456789")])
    assert r["stubbed"] == [1] and r["committed"] == 2
    full, stub = rows(arch)
    assert full["payload"] == b"12345678" and not full["stub"]
    assert stub["payload"] is None and stub["stub"] and stub["payload_size"] == 9


def test_stub_and_full_copy_hash_alike(tmp_path):
    a = Archive(str(tmp_path / "x.sqlite3"), max_payload_bytes=4)
    b = Archive(str(tmp_path / "y.sqlite3"), max_payload_bytes=400)
    a.append("b", [cap(0, b"0123456789")])
    b.append("b", [cap(0, b"0123456789")])
    assert rows(a)[0]["content_hash"] == rows(b)[0]["content_hash"]
    assert rows(a)[0]["payload"] is None and rows(b)[0]["payload"] == b"0123456789"


def test_payload_is_stored_byte_identical(arch):
    payload = bytes(range(8))  # NULs, high bytes
    arch.append("b", [cap(0, payload), cap(1, b"")])
    got = rows(arch)
    assert got[0]["payload"] == payload and got[1]["payload"] == b"" and got[1]["payload_size"] == 0


def test_malformed_is_rejected_alone(arch):
    bad = cap(1)
    del bad["topic"]
    r = arch.append("b", [cap(0), bad, cap(2), "junk", cap(4)])
    assert r["rejected"] == [{"index": 1, "reason": "malformed"}, {"index": 3, "reason": "malformed"}]
    assert r["committed"] == 3 and r["stubbed"] == []
    assert len(rows(arch)) == 3
    c = arch.counters()
    assert (c["received"], c["committed"], c["rejected"]) == (5, 3, 2) and identity(c)


def test_a_batch_of_only_malformed_commits_nothing_but_is_available(arch):
    r = arch.append("b", [{}, {}])
    assert r["storage"] == "available" and r["committed"] == 0 and len(r["rejected"]) == 2


def test_two_identical_receptions_are_two_captures(arch):
    arch.append("b", [cap(0), cap(0)])
    assert len(rows(arch)) == 2


def test_unavailable_at_start_is_not_accepted(arch):
    arch._conn = FaultyConnection(arch._conn, lambda w, n: w == "BEGIN")
    r = arch.append("b", [cap(0), cap(1)])
    assert r == {"batch_id": "b", "storage": "unavailable", "committed": 0, "rejected": [], "stubbed": []}
    c = arch.counters()
    assert c["received"] == 0 and c["unavailable_batches"] == 1 and c["buffered"] == 0 and identity(c)
    assert rows(arch) == []


@pytest.mark.parametrize("word,nth", [("INSERT", 1), ("INSERT", 3), ("INSERT", 5), ("COMMIT", 1)])
def test_failure_mid_batch_leaves_nothing_committed(arch, word, nth):
    real = arch._conn
    arch._conn = FaultyConnection(real, lambda w, n: w == word and n == nth)
    r = arch.append("b", [cap(i) for i in range(5)])
    assert r["storage"] == "unavailable" and r["committed"] == 0
    assert rows(arch) == []  # read through a fresh connection: nothing, not even the rows before the failure
    c = arch.counters()
    assert c["received"] == 0 and c["committed"] == 0 and c["buffered"] == 0 and c["unavailable_batches"] == 1 and identity(c)
    # the archive recovers: the same batch retried is committed whole
    arch._conn = real
    r = arch.append("b", [cap(i) for i in range(5)])
    assert r["storage"] == "available" and r["committed"] == 5 and len(rows(arch)) == 5
    c = arch.counters()
    assert c["received"] == 5 and c["unavailable_batches"] == 1 and identity(c)


def test_failure_after_a_good_batch_keeps_the_good_batch(arch):
    arch.append("g", [cap(0), cap(1)])
    arch._conn = FaultyConnection(arch._conn, lambda w, n: w == "INSERT" and n == 2)
    arch.append("b", [cap(2), cap(3), cap(4)])
    assert len(rows(arch)) == 2


def test_identity_holds_at_every_instant_during_an_append(arch):
    seen = []

    class Spy(FaultyConnection):
        def execute(self, sql, *a):
            seen.append(arch.counters())
            return super().execute(sql, *a)

    arch._conn = Spy(arch._conn, lambda w, n: False)
    arch.append("b", [cap(0), {"bad": 1}, cap(2, b"123456789012")])
    assert any(c["buffered"] == 3 for c in seen)  # in flight: accepted, not yet answered
    assert all(identity(c) for c in seen)
    assert all((c["oldest_buffered_ms"] is not None) == (c["buffered"] > 0) for c in seen)
    end = arch.counters()
    assert end["buffered"] == 0 and end["oldest_buffered_ms"] is None and identity(end)
    assert (end["received"], end["committed"], end["rejected"], end["stubbed"]) == (3, 2, 1, 1)


def test_dropped_counts_as_received_and_dropped(arch):
    arch.record_dropped(2)
    c = arch.counters()
    assert (c["received"], c["dropped"]) == (2, 2) and identity(c) and c["stubbed"] <= c["committed"]


def test_stubbed_never_exceeds_committed(arch):
    arch.append("b", [cap(0, b"123456789"), cap(1, b"123456789")])
    c = arch.counters()
    assert c["stubbed"] <= c["committed"] == 2


def test_committed_survives_reopen(tmp_path):
    p = str(tmp_path / "d.sqlite3")
    a = Archive(p)
    a.append("b", [cap(0), cap(1)])
    a.close()
    b = Archive(p)
    assert len(b.read_committed()) == 2
    b.append("c", [cap(2)])
    ids = [r["capture_id"] for r in b.read_committed()]
    assert ids == sorted(ids) and len(set(ids)) == 3
    assert b.counters()["received"] == 1  # counters start at zero with the archive


def test_wal_mode(arch):
    assert arch._conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_concurrent_appends_are_serialised_and_identity_holds(arch):
    errs = []

    def work(k):
        try:
            for j in range(20):
                arch.append(f"t{k}-{j}", [cap(j), cap(j + 1)])
        except Exception as e:  # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=work, args=(k,)) for k in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs and len(rows(arch)) == 160
    c = arch.counters()
    assert c["received"] == c["committed"] == 160 and identity(c)
