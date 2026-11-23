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


def test_nothing_is_counted_until_the_commit_and_then_all_four_at_once(arch):
    """Acceptance is the commit (raw-capture section 4). Every statement of the append, the COMMIT included,
    sees untouched counters; right after it all four have moved together."""
    seen = []

    class Spy(FaultyConnection):
        def execute(self, sql, *a):
            seen.append((sql.split()[0].upper(), arch.counters()))
            return super().execute(sql, *a)

    arch._conn = Spy(arch._conn, lambda w, n: False)
    arch.append("b", [cap(0), {"bad": 1}, cap(2, b"123456789012")])
    assert [w for w, _ in seen] == ["BEGIN", "INSERT", "INSERT", "COMMIT"]
    zero = (0, 0, 0, 0)
    for _, c in seen:
        assert (c["received"], c["committed"], c["rejected"], c["stubbed"]) == zero and identity(c)
        assert c["buffered"] == 0 and c["oldest_buffered_ms"] is None
    end = arch.counters()
    assert (end["received"], end["committed"], end["rejected"], end["stubbed"]) == (3, 2, 1, 1)
    assert end["buffered"] == 0 and end["oldest_buffered_ms"] is None and end["dropped"] == 0 and identity(end)


def test_the_four_counters_are_updated_under_one_hold_of_the_counter_lock(arch):
    """Deterministic form of the next test: after the commit the counters take one lock hold, not several."""
    holds = []

    class CountingLock:
        def __init__(self, real):
            self._real = real

        def __enter__(self):
            holds.append(1)
            return self._real.__enter__()

        def __exit__(self, *a):
            return self._real.__exit__(*a)

    arch._state = CountingLock(arch._state)
    arch.append("b", [cap(0), {"bad": 1}, cap(2, b"123456789012")])
    assert len(holds) == 1
    arch._conn = FaultyConnection(arch._conn, lambda w, n: w == "BEGIN")
    holds.clear()
    arch.append("c", [cap(0)])
    assert len(holds) == 1  # an unavailable answer: the one count is unavailable_batches


def test_a_concurrent_reader_never_sees_a_half_counted_batch(arch):
    """received, committed and rejected move in one step: any snapshot has received == committed + rejected."""
    stop = threading.Event()
    bad = []

    def reader():
        while not stop.is_set():
            c = arch.counters()
            if not identity(c) or c["received"] != c["committed"] + c["rejected"]:
                bad.append(c)

    t = threading.Thread(target=reader)
    t.start()
    try:
        for j in range(40):
            arch.append(f"b{j}", [cap(0), {"bad": 1}, cap(1, b"123456789"), cap(2)] * 20)
    finally:
        stop.set()
        t.join()
    assert not bad and arch.counters()["received"] == 40 * 80


def test_the_archive_has_no_way_to_count_a_producers_shed_captures(arch):
    """A producer's own shed captures are the producer's to count; the archive's dropped is its own and 0."""
    assert not hasattr(arch, "record_dropped")
    arch.append("b", [cap(0)])
    assert arch.counters()["dropped"] == 0


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


H = "ab" * 32


def stub_cap(i, size=300000, h=H, topic="t/a"):
    return {"source": "src", "topic": topic, "stub": {"size": size, "content_hash": h},
            "retained": False, "received_at": f"2026-01-01T00:00:00.{i % 1000:03d}Z"}


def test_an_arrived_stub_is_committed_as_a_stub_with_its_own_size_and_hash(arch):
    r = arch.append("b", [cap(0), stub_cap(1, size=3, h=H), cap(2)])  # size 3 is under the archive's limit: still a stub
    assert r == {"batch_id": "b", "storage": "available", "committed": 3, "rejected": [], "stubbed": [1]}
    a, s, c = rows(arch)
    assert s["stub"] and s["payload"] is None and s["payload_size"] == 3 and s["content_hash"] == H
    assert not a["stub"] and a["payload"] == b"x" and not c["stub"]
    k = arch.counters()
    assert (k["received"], k["committed"], k["stubbed"]) == (3, 3, 1) and identity(k)


def test_an_arrived_stub_is_not_checked_as_base64_or_against_its_hash(arch):
    # the hash is not the hash of anything the archive could check; it is stored as given
    r = arch.append("b", [stub_cap(0, h="0" * 64)])
    assert r["committed"] == 1 and r["stubbed"] == [0] and rows(arch)[0]["content_hash"] == "0" * 64


@pytest.mark.parametrize("edit", [
    lambda c: dict(c, payload_b64="YQ=="),  # both a payload and a stub
    lambda c: {k: v for k, v in c.items() if k != "stub"},  # neither
    lambda c: dict(c, stub={"size": 0, "content_hash": H}),
    lambda c: dict(c, stub={"size": True, "content_hash": H}),
    lambda c: dict(c, stub={"size": 1.5, "content_hash": H}),
    lambda c: dict(c, stub={"size": 5, "content_hash": H.upper()}),
    lambda c: dict(c, stub={"size": 5, "content_hash": H[:-1]}),
    lambda c: dict(c, stub={"size": 5, "content_hash": H + "\n"}),
    lambda c: dict(c, stub={"size": 5}),
    lambda c: dict(c, stub={"size": 5, "content_hash": H, "extra": 1}),
    lambda c: dict(c, stub="x"),
    lambda c: dict(c, topic="bad\ud800topic"),
])
def test_a_malformed_stub_capture_is_rejected_alone(arch, edit):
    r = arch.append("b", [cap(0), edit(stub_cap(1))])
    assert r["rejected"] == [{"index": 1, "reason": "malformed"}] and r["committed"] == 1 and r["stubbed"] == []
