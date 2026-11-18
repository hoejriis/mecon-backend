"""PahoTransport with a stub client: a new client object per session, stale callbacks ignored."""

import pytest

from conftest import make_cfg
import mecon_connector.paho_transport as pt
from mecon_connector.transport import TransportError, Will


class StubClient:
    instances = []

    def __init__(self, *a, **k):
        self.k = k
        self.calls = []
        self.queued = []  # what a real client would resend on reconnect
        StubClient.instances.append(self)

    def __getattr__(self, name):
        def f(*a, **k):
            self.calls.append(name)
        return f

    def publish(self, topic, payload, qos, retain):
        self.queued.append(payload)
        return type("I", (), {"rc": 0, "mid": len(self.queued)})()


class Rec:
    def __init__(self):
        self.ev = []

    def on_connected(self, s, r): self.ev.append(("c", s, r))
    def on_disconnected(self, s): self.ev.append(("d", s))
    def on_acked(self, s, m): self.ev.append(("a", s, m))
    def on_message(self, s, t, p, r): self.ev.append(("m", s, t, p, r))


@pytest.fixture
def tr(monkeypatch):
    StubClient.instances = []
    monkeypatch.setattr(pt.mqtt, "Client", StubClient)
    t = pt.PahoTransport("cid", 30)
    t.callbacks = Rec()
    return t


BROKER = make_cfg().mqtt.brokers[0]
WILL = Will("t/s", b"x", 1, True)


def test_each_session_gets_a_fresh_client_and_the_old_one_is_stopped(tr):
    s1 = tr.connect(BROKER, WILL, [])
    first = StubClient.instances[-1]
    tr._connected = True
    tr.publish("t/up", b"in-doubt", 1, False)
    s2 = tr.connect(BROKER, WILL, [])
    second = StubClient.instances[-1]
    assert s2 != s1 and second is not first and len(StubClient.instances) == 2
    assert "loop_stop" in first.calls and "disconnect" in first.calls
    # what the first client still held is not reachable from the new session
    assert second.queued == []


def test_callbacks_of_a_dead_session_are_ignored(tr):
    s1 = tr.connect(BROKER, WILL, [])
    first = StubClient.instances[-1]
    tr.connect(BROKER, WILL, [])
    on_msg = first.on_message
    on_msg(None, None, type("M", (), {"topic": "t", "payload": b"late", "retain": False})())
    first.on_publish(None, None, 1, None, None)
    assert tr.callbacks.ev == []
    assert s1 != tr._session


def test_publish_without_a_live_session_is_refused_not_queued(tr):
    with pytest.raises(TransportError):
        tr.publish("t/up", b"x", 1, False)
    tr.connect(BROKER, WILL, [])
    with pytest.raises(TransportError):
        tr.publish("t/up", b"x", 1, False)  # connecting is not connected
    assert StubClient.instances[-1].queued == []


def test_library_reconnect_is_held_off_and_clean_session_set(tr):
    tr.connect(BROKER, WILL, [])
    c = StubClient.instances[-1]
    assert c.k["clean_session"] is True and c.k["protocol"] == pt.mqtt.MQTTv311
    assert "reconnect_delay_set" in c.calls
