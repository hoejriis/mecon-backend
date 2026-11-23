import json
import sqlite3

import pytest
from helpers import SOURCES, InjectedFault, ListSource, boom_after_writes, cap, env_cap, make, packet

from mecon_processing.config import ConfigError
from mecon_processing.processor import Processor
from mecon_processing.store import Store

P = packet(ptype=5, payload=b"hello").hex()
Q = packet(ptype=5, payload=b"other").hex()
TS = 1767225600  # 2026-01-01T00:00:00Z


def at(sec, ms=0):
    return f"2026-01-01T{sec // 3600:02d}:{sec // 60 % 60:02d}:{sec % 60:02d}.{ms:03d}Z"


def run(tmp_path, captures, **kw):
    store, proc = make(tmp_path, **kw)
    src = ListSource(captures)
    proc.drain(src)
    return store, proc, src


def outcomes(store):
    return [(o["capture_id"], o.get("reason", "reception")) for o in store.outcomes()]


def test_one_outcome_per_capture_with_reasons_in_order(tmp_path):
    caps = [
        cap(1, b"", stub=True, retained=True),  # stub is checked before retained
        cap(2, b"{}", retained=True),  # retained is checked before parsing
        cap(3, b"{}", topic="a/b/c/status"),
        cap(4, b"zzz"),
        env_cap(5, P, env_origin_id="other"),
        env_cap(6, "15"),  # frames to nothing
        env_cap(7, ""),  # zero bytes
        env_cap(8, P, env_ts=TS),
        env_cap(9, P, env_ts=TS),
        env_cap(10, P),
    ]
    store, proc, _ = run(tmp_path, caps)
    assert outcomes(store) == [(1, "stub"), (2, "retained"), (3, "not_a_packet"), (4, "malformed"), (5, "origin_mismatch"),
                               (6, "unparseable"), (7, "unparseable"), (8, "reception"), (9, "duplicate_report"), (10, "reception")]


def test_a_retained_capture_with_garbage_is_retained_not_malformed(tmp_path):
    store, _, _ = run(tmp_path, [cap(1, b"\xff", retained=True)])
    assert outcomes(store) == [(1, "retained")]


def test_a_stub_is_never_parsed(tmp_path):
    store, _, _ = run(tmp_path, [cap(1, None, stub=True)])
    assert outcomes(store) == [(1, "stub")]


def test_unknown_source_fails_the_capture_once_and_it_is_not_retried(tmp_path):
    store, proc, src = run(tmp_path, [env_cap(1, P, source="nobody"), env_cap(2, P)])
    assert outcomes(store) == [(1, "failed"), (2, "reception")]
    assert proc.counters(src)["skipped"]["failed"] == 1
    assert proc.drain(src) == 0 and outcomes(store)[0] == (1, "failed")


def test_a_failed_capture_does_not_stop_the_batch_or_leave_a_packet(tmp_path):
    bad = env_cap(1, P)
    bad["payload"] = 12345  # not bytes: the adapter blows up
    store, _, _ = run(tmp_path, [bad, env_cap(2, Q)])
    assert outcomes(store) == [(1, "failed"), (2, "reception")]
    assert [p["packet_id"] for p in store.packets()] == [store.receptions()[0]["packet_id"]]


def test_packet_first_and_last_seen(tmp_path):
    caps = [env_cap(1, P, at=at(10)), env_cap(2, P, at=at(20), env_ts=TS - 100), env_cap(3, P, at=at(30), env_ts=TS - 100),
            env_cap(4, P, at=at(15))]  # later capture, earlier received_at: never lowers
    store, _, _ = run(tmp_path, caps)
    assert outcomes(store) == [(1, "reception"), (2, "reception"), (3, "duplicate_report"), (4, "reception")]
    (p,) = store.packets()
    assert (p["first_seen_at"], p["last_seen_at"]) == (at(10), at(30))  # the duplicate report raised last_seen_at


def test_other_packet_fields_come_from_the_first_reception(tmp_path):
    a = packet(route=1, ptype=4, payload=b"x", path=b"\x01").hex()
    b = packet(route=2, ptype=4, payload=b"x", path=b"\x01\x02\x03").hex()
    store, _, _ = run(tmp_path, [env_cap(1, a, at=at(1)), env_cap(2, b, at=at(2))])
    (p,) = store.packets()
    assert p["packet_type"] == "ADVERT" and p["first_seen_at"] == at(1)
    r = store.receptions()
    assert [(x["hop_count"], x["route_type"]) for x in r] == [(1, 1), (3, 2)]  # each reception keeps its own


def test_separate_receptions_are_never_merged(tmp_path):
    caps = [
        env_cap(1, P, env_ts=TS, env_rssi=-90, env_snr=5),
        env_cap(2, P, env_ts=TS, env_rssi=-90, env_snr=5, topic="meshcore/AB12/obs-2/packets"),  # other observer
        env_cap(3, P, env_ts=TS, env_rssi=-90, env_snr=5, source="second-broker"),  # other source
        env_cap(4, P),  # no device time: always a reception
        env_cap(5, P),  # a flood retransmission heard again
    ]
    store, _, _ = run(tmp_path, caps)
    assert outcomes(store) == [(i, "reception") for i in range(1, 6)]
    assert len({r["capture_id"] for r in store.receptions()}) == 5


@pytest.mark.parametrize("second,dup", [
    ({"env_ts": TS, "env_rssi": -90, "env_snr": 5}, True),
    ({"env_ts": TS, "env_rssi": -90, "env_snr": 6}, False),  # snr differs
    ({"env_ts": TS, "env_rssi": -91, "env_snr": 5}, False),  # rssi differs
    ({"env_ts": TS + 1, "env_rssi": -90, "env_snr": 5}, False),  # device time differs
    ({"env_rssi": -90, "env_snr": 5}, False),  # no device time on the second
    ({"env_ts": TS, "env_rssi": -90}, False),  # snr null on one, 5 on the other
])
def test_duplicate_report_rule(tmp_path, second, dup):
    caps = [env_cap(1, P, env_ts=TS, env_rssi=-90, env_snr=5), env_cap(2, P, **second)]
    store, _, _ = run(tmp_path, caps)
    assert outcomes(store)[1] == (2, "duplicate_report" if dup else "reception")


def test_null_equals_null_in_the_duplicate_rule_but_needs_a_device_time(tmp_path):
    store, _, _ = run(tmp_path, [env_cap(1, P, env_ts=TS), env_cap(2, P, env_ts=TS), env_cap(3, P), env_cap(4, P)])
    assert outcomes(store) == [(1, "reception"), (2, "duplicate_report"), (3, "reception"), (4, "reception")]


def test_a_device_time_that_is_not_trusted_does_not_make_a_duplicate(tmp_path):
    store, _, _ = run(tmp_path, [env_cap(1, P, env_ts=5), env_cap(2, P, env_ts=5)])
    assert outcomes(store) == [(1, "reception"), (2, "reception")]


def test_duplicates_are_found_across_batches_and_only_within_packet_source_and_observer(tmp_path):
    store, proc = make(tmp_path)
    src = ListSource([env_cap(1, P, env_ts=TS), env_cap(2, P, env_ts=TS, source="second-broker"),
                      env_cap(3, Q, env_ts=TS), env_cap(4, P, env_ts=TS)])
    for _ in range(4):
        proc.run_pending(src, 1)
    assert outcomes(store) == [(1, "reception"), (2, "reception"), (3, "reception"), (4, "duplicate_report")]


def test_observer_null_receptions_are_kept_but_not_folded(tmp_path):
    caps = [env_cap(1, P, topic="a/obs/packets", env_rssi=-80), env_cap(2, P, env_rssi=-70, at=at(5))]
    store, _, _ = run(tmp_path, caps)
    assert [r["observer_key"] for r in store.receptions()] == [None, "obs-1"]
    assert [(h["observer_key"], h["receptions"]) for h in store.hours()] == [("obs-1", 1)]
    assert store.hours() == store.computed_hours()


def test_a_null_observer_duplicate_is_found(tmp_path):
    store, _, _ = run(tmp_path, [env_cap(1, P, topic="a/obs/packets", env_ts=TS), env_cap(2, P, topic="a/obs/packets", env_ts=TS)])
    assert outcomes(store) == [(1, "reception"), (2, "duplicate_report")]


def test_hours_fold_per_source_observer_and_utc_hour(tmp_path):
    caps = [
        env_cap(1, P, at="2026-01-01T00:59:59.999Z", env_rssi=-90, env_snr=4),
        env_cap(2, P, at="2026-01-01T01:00:00.000Z", env_rssi=-80),
        env_cap(3, P, at="2026-01-01T01:30:00.000Z", env_snr=2.5),
        env_cap(4, P, at="2026-01-01T01:31:00.000Z", env_rssi=0, env_snr=0),  # rssi 0: unmeasured; snr 0: a reading
        env_cap(5, P, at="2026-01-01T01:32:00.000Z", source="second-broker"),
    ]
    store, _, _ = run(tmp_path, caps)
    h = {(x["source"], x["hour"]): x for x in store.hours()}
    assert h[("own-broker", "2026-01-01T00:00:00Z")] == {
        "source": "own-broker", "observer_key": "obs-1", "hour": "2026-01-01T00:00:00Z", "receptions": 1,
        "rssi_sum": -90, "rssi_count": 1, "snr_sum": 4, "snr_count": 1}
    one = h[("own-broker", "2026-01-01T01:00:00Z")]
    assert (one["receptions"], one["rssi_sum"], one["rssi_count"], one["snr_sum"], one["snr_count"]) == (3, -80, 1, 2.5, 2)
    assert h[("second-broker", "2026-01-01T01:00:00Z")]["receptions"] == 1
    assert store.hours() == store.computed_hours() == store.rebuild_hours()


def test_rebuild_restores_a_damaged_aggregate(tmp_path):
    store, _, _ = run(tmp_path, [env_cap(i, P, env_rssi=-i, env_snr=i / 4) for i in range(1, 30)])
    good = store.hours()
    with sqlite3.connect(store.path) as c:
        c.execute("UPDATE hours SET rssi_sum = 0, receptions = 99")
        c.execute("INSERT INTO hours VALUES ('x','y','2026-01-01T00:00:00Z',1,0,0,0,0)")
    assert store.hours() != good
    assert store.rebuild_hours() == good and store.hours() == good


def test_batches_are_bounded_at_500(tmp_path):
    store, proc = make(tmp_path)
    caps = [env_cap(i, P, at=at(i)) for i in range(1, 1201)]
    src = ListSource(caps)
    with pytest.raises(ValueError):
        proc.process_batch(caps[:501])
    assert proc.run_pending(src) == 500 and store.progress() == 500
    assert proc.run_pending(src, 10_000) == 500 and store.progress() == 1000
    assert proc.run_pending(src, 7) == 7 and store.progress() == 1007
    assert proc.drain(src) == 193 and len(store.outcomes()) == 1200
    with pytest.raises(ValueError):
        Processor(store, SOURCES, batch_max=501)


def test_captures_are_taken_in_capture_id_order(tmp_path):
    store, proc = make(tmp_path)
    src = ListSource([env_cap(3, P), env_cap(1, Q), env_cap(2, Q)])
    proc.run_pending(src, 2)
    assert [o["capture_id"] for o in store.outcomes()] == [1, 2]
    assert store.progress() == 2


def all_tables(store):
    return (store.outcomes(), store.packets(), store.receptions(), store.hours(), store.progress())


def test_a_crash_leaves_nothing_of_the_batch_and_a_rerun_equals_one_pass(tmp_path):
    caps = [env_cap(i, P if i % 2 else Q, at=at(i), **({"env_ts": TS} if i % 3 == 0 else {})) for i in range(1, 41)]
    clean, p1 = make(tmp_path, name="clean.sqlite3")
    p1.drain(ListSource(caps))
    store, proc = make(tmp_path, clock=lambda: 1767226000.0)  # a fixed clock: the lag is part of the counters
    src = ListSource(caps)
    proc.run_pending(src, 10)
    before, counters = all_tables(store), proc.counters(src)
    with pytest.raises(InjectedFault):
        proc.run_pending(src, 10, fault=boom_after_writes(store, 20))
    assert all_tables(store) == before and store.progress() == 10
    assert proc.counters(src) == counters  # a crashed batch was never counted
    proc.drain(src)
    assert all_tables(store) == all_tables(clean)


def test_progress_commits_with_its_output_not_before(tmp_path):
    store, proc = make(tmp_path)
    src = ListSource([env_cap(1, P)])
    with pytest.raises(InjectedFault):
        proc.run_pending(src, 1, fault=boom_after_writes(store, 1))
    assert store.progress() == 0 and store.outcomes() == []
    assert proc.run_pending(src, 1) == 1 and store.progress() == 1


def test_reprocessing_committed_captures_adds_nothing(tmp_path):
    caps = [env_cap(1, P), env_cap(2, P, env_ts=TS), env_cap(3, P, env_ts=TS), cap(4, b"x", stub=True)]
    store, proc, src = run(tmp_path, caps, clock=lambda: 1767226000.0)
    before, counters = all_tables(store), proc.counters(src)
    assert proc.process_batch(src.captures) == 0  # handed the same captures again
    assert proc.process_batch(src.captures[:1]) == 0 and store.progress() == 4  # an old one never moves progress back
    with sqlite3.connect(store.path) as c:  # and with the progress mark cleared by hand
        c.execute("DELETE FROM progress")
    store2 = Store(store.path)
    proc2 = Processor(store2, SOURCES)
    assert proc2.drain(src) == 0
    assert all_tables(store2) == before and proc.counters(src) == counters


def test_a_reception_per_capture_id_is_unique_in_the_store(tmp_path):
    store, _, _ = run(tmp_path, [env_cap(1, P)])
    r = store.receptions()[0]
    with pytest.raises(sqlite3.IntegrityError):
        with store.batch() as b:
            b.add_reception(r)
    assert len(store.receptions()) == 1
    with pytest.raises(sqlite3.IntegrityError):
        with store.batch() as b:
            b.add_outcome(1, "skipped", "stub")


def test_the_store_refuses_an_outcome_with_the_wrong_reason_shape(tmp_path):
    store, _, _ = run(tmp_path, [])
    for args in (("reception", "stub"), ("skipped", None), ("maybe", None)):
        with pytest.raises(sqlite3.IntegrityError):
            with store.batch() as b:
                b.add_outcome(1, *args)


def test_counters(tmp_path, schemas):
    now = [1767225600.0 + 10]
    store, proc = make(tmp_path, clock=lambda: now[0])
    src = ListSource([env_cap(1, P, at="2026-01-01T00:00:00.000Z"), cap(2, b"", stub=True, at="2026-01-01T00:00:02.500Z"),
                      env_cap(3, P, env_ts=TS, at="2026-01-01T00:00:05.000Z")])
    c = proc.counters(src)
    assert c == {"processed": 0, "receptions": 0, "skipped": {k: 0 for k in c["skipped"]}, "pending": 3,
                 "oldest_pending_ms": 10000}
    assert schemas["counters"].is_valid(c)
    proc.run_pending(src, 2)
    c = proc.counters(src)
    assert (c["processed"], c["receptions"], c["skipped"]["stub"], c["pending"], c["oldest_pending_ms"]) == (2, 1, 1, 1, 5000)
    proc.drain(src)
    c = proc.counters(src)
    assert c["pending"] == 0 and c["oldest_pending_ms"] is None and c["processed"] == 3
    assert c["processed"] == c["receptions"] + sum(c["skipped"].values())
    assert schemas["counters"].is_valid(c)
    now[0] = 0
    src2 = ListSource([env_cap(9, P, at="2026-01-01T00:00:00.000Z")])
    assert proc.counters(src2)["oldest_pending_ms"] == 0  # never negative


def test_counters_include_duplicates_and_every_reason(tmp_path, schemas):
    caps = [cap(1, b"", stub=True), cap(2, b"{}", retained=True), cap(3, b"{}", topic="a/b/c/s"), cap(4, b"zz"),
            env_cap(5, P, env_origin_id="q"), env_cap(6, "15"), env_cap(7, P, env_ts=TS), env_cap(8, P, env_ts=TS),
            env_cap(9, P, source="nobody")]
    _, proc, src = run(tmp_path, caps)
    c = proc.counters(src)
    assert c["skipped"] == {"retained": 1, "stub": 1, "not_a_packet": 1, "malformed": 1, "origin_mismatch": 1,
                            "unparseable": 1, "duplicate_report": 1, "failed": 1}
    assert c["receptions"] == 1 and c["processed"] == 9 and schemas["counters"].is_valid(c)


def test_an_unknown_adapter_is_a_configuration_error_never_a_fallback(tmp_path):
    store = Store(str(tmp_path / "s.sqlite3"))
    with pytest.raises(ConfigError):
        Processor(store, {"own-broker": "observer_envelop"})
    with pytest.raises(ConfigError):
        Processor(store, {"own-broker": "observer_envelope", "feed": "json"})
    with pytest.raises(ConfigError):
        Processor(store, {})
