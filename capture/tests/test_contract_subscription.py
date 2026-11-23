"""Replays contracts/observation-subscription/v1 fixture C against the ingester over a fake transport."""

import pytest

from conftest import sub_fixture
from helpers import Clock, make_ingester


def replay(tmp_path, schemas):
    fx = sub_fixture("C")
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


def test_fixture_c(tmp_path, schemas):
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
