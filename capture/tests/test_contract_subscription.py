"""Replays every contracts/observation-subscription/v1 fixture against the real ingester."""

import pytest

from conftest import SUB_FIXTURES, sub_fixture
from helpers import Clock, make_ingester
from mecon_capture.config import validate_profile


def replay(tmp_path, schemas, fx=None):
    fx = fx or sub_fixture("C")
    clock = Clock()
    ig, _archive, transports, _log = make_ingester([fx["profile"]], tmp_path, clock=clock)
    session, tr = ig.sessions[0], transports[fx["profile"]["name"]]
    results = []
    for step in fx["steps"]:
        ev = step["event"]
        if "at" in step:
            clock.set(step["at"])
        if ev == "start":
            session.start()
        elif ev == "connack":
            session.on_connack(step["code"])
        elif ev == "suback":
            session.on_suback(step["granted"], step["refused"])
        elif ev == "disconnect":
            session.on_disconnect()
        elif ev == "stop":
            session.stop()
        results.append((step, tr.take_actions(), session.status()))
    return fx, tr, results


def check_profiles(tmp_path, schemas, name, fx):
    assert fx["expect"] in ("valid", "invalid") and fx["cases"], name
    for case in fx["cases"]:
        ok = fx["expect"] == "valid"
        assert schemas["profile"].is_valid(case["value"]) == ok, case["note"]
        assert (validate_profile(case["value"]) == []) == ok, case["note"]


def check_sequence(tmp_path, schemas, name, fx):
    fx, tr, results = replay(tmp_path, schemas, fx)
    for step, actions, status in results:
        assert actions == step["actions"], step["event"]
        assert status == step["status"], step["event"]
        assert schemas["status"].is_valid(status)


def check_ingester(tmp_path, schemas, name, fx):
    """Replay a message or an append's answer against the real buffer and flusher, and compare the counters
    after each event with the fixture's, key by key as far as it gives them."""
    lim = fx["limits"]
    prof = sub_fixture("A")["cases"][2]["value"]
    clock = Clock()
    ig, archive, _t, _l = make_ingester([prof], tmp_path, clock=clock, buffer_max=lim["buffer_bound"],
                                        max_receive_bytes=lim["max_receive_bytes"])
    answer = {"storage": None}

    def fake_append(batch_id, captures):  # the archive's answer is the fixture's; no file is touched
        if answer["storage"] == "unavailable":
            return {"batch_id": batch_id, "storage": "unavailable", "committed": 0, "rejected": [], "stubbed": []}
        return {"batch_id": batch_id, "storage": "available", "committed": len(captures), "rejected": [], "stubbed": []}

    archive.append = fake_append
    assert fx["events"], name
    for i, ev in enumerate(fx["events"]):
        if ev["event"] == "message":
            ig.sessions[0].on_message("packets/obs-1", b"x" * ev["size"], False)
        elif ev["event"] == "append":
            answer["storage"] = ev["storage"]
            assert ig.flush_once() == (ev["storage"] == "available"), (name, i)
        else:
            pytest.fail(f"{name}: unknown ingester event {ev['event']!r}; teach this test to replay it")
        got = ig.buffer.counters(clock())
        assert schemas["ingester"].is_valid(got), (name, i)
        for key, want in ev["expect"].items():
            assert got[key] == want, (name, i, key)
        assert got["received"] == got["handed_on"] + got["buffered"] + got["shed"], (name, i)
        assert (got["oldest_buffered_ms"] is None) == (got["buffered"] == 0), (name, i)


@pytest.mark.parametrize("name,fx", SUB_FIXTURES, ids=[n for n, _ in SUB_FIXTURES])
def test_every_subscription_fixture(tmp_path, schemas, name, fx):
    """Every file in contracts/observation-subscription/v1/fixtures, dispatched on its kind. An unknown kind fails."""
    kind = fx.get("kind")
    if kind == "profiles":
        check_profiles(tmp_path, schemas, name, fx)
    elif kind == "sequence":
        check_sequence(tmp_path, schemas, name, fx)
    elif kind == "ingester":
        check_ingester(tmp_path, schemas, name, fx)
    else:
        pytest.fail(f"{name}: unknown fixture kind {kind!r}; teach this test to replay it")


def test_the_fixture_directory_has_the_known_kinds():
    assert {fx["kind"] for _, fx in SUB_FIXTURES} >= {"profiles", "sequence", "ingester"}


def test_fixture_c_rules(tmp_path, schemas):
    fx, tr, results = replay(tmp_path, schemas)
    assert len(results) == 6
    for step, actions, status in results:
        assert actions == step["actions"], step["event"]
        assert status == step["status"], step["event"]
        assert schemas["status"].is_valid(status)
    assert tr.disconnects == 0  # nothing but subscribes was asked of the transport
    # section 6 rules, checked on the replay itself
    topics = fx["profile"]["topics"]
    for step, actions, _ in results:
        if step["event"] == "connack" and step["code"] == 0:
            assert [a["subscribe"] for a in actions] == topics and all(a["qos"] == 0 for a in actions)
        else:
            assert actions == []
    connected_at = [s["last_connected_at"] for _, _, s in results]
    assert connected_at == [None, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
                            "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:06.000Z"]
    for _, _, s in results:
        assert (s["last_error"] is not None) == (s["state"] == "error")


def test_resubscribes_after_every_successful_connack(tmp_path):
    prof = sub_fixture("A")["cases"][1]["value"]
    ig, _a, tr, _l = make_ingester([prof], tmp_path)
    s, t = ig.sessions[0], tr["feed-wss"]
    for _ in range(3):
        s.on_connack(0)
        assert t.take_actions() == [{"subscribe": x, "qos": 0} for x in prof["topics"]]
        s.on_disconnect()
    s.on_connack(3)
    assert t.take_actions() == []  # a refused connect subscribes to nothing


def test_status_error_text_is_the_brokers_reason(tmp_path):
    prof = sub_fixture("A")["cases"][2]["value"]
    ig, _a, tr, _l = make_ingester([prof], tmp_path)
    s = ig.sessions[0]
    s.on_connack(4)
    assert s.status()["last_error"] == "bad user name or password"
    s.on_connack(5)
    assert s.status()["last_error"] == "not authorised"
    s.on_disconnect()  # the library's close after a refusal must not hide the reason
    assert s.status()["state"] == "error"
    s.on_connect_failed("network error")
    assert s.status()["last_connected_at"] is None
    s.on_connack(0)
    st = s.status()
    assert st["state"] == "connected" and st["last_error"] is None and st["last_connected_at"]


def test_failed_connect_never_moves_last_connected_at(tmp_path):
    prof = sub_fixture("A")["cases"][2]["value"]
    clock = Clock()
    ig, _a, _t, _l = make_ingester([prof], tmp_path, clock=clock)
    s = ig.sessions[0]
    s.on_connack(0)
    first = s.status()["last_connected_at"]
    clock.advance_ms(5000)
    s.on_disconnect()
    s.on_connect_failed("tls verification failed")
    s.on_connack(5)
    s.on_disconnect()
    assert s.status()["last_connected_at"] == first


def test_refused_topics_are_reported_not_replaced(tmp_path):
    prof = sub_fixture("C")["profile"]
    ig, _a, tr, _l = make_ingester([prof], tmp_path)
    s = ig.sessions[0]
    s.on_connack(0)
    s.on_suback(["meshcore/+/+/internal"], [])  # SUBACKs may arrive one per topic
    s.on_suback([], ["meshcore/#"])
    st = s.status()
    assert st["subscribed"] == ["meshcore/+/+/internal"] and st["refused"] == ["meshcore/#"]
    assert [a["subscribe"] for a in tr["own-broker"].actions] == prof["topics"]  # no substitute topic
    s.on_connack(0)  # a new session starts from nothing
    assert "subscribed" not in s.status()
