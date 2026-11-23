"""PahoTransport driven through a stand-in for paho's Client: no network, every call recorded."""

import ssl
import types

import pytest

from conftest import sub_fixture
from mecon_capture import config as C
from mecon_capture.paho_transport import BACKOFF_MAX_S, BACKOFF_MIN_S, PahoTransport
from mecon_capture.transport import TransportError

TCP_TLS = C.profile_from_dict(sub_fixture("A")["cases"][0]["value"])
WSS = C.profile_from_dict(sub_fixture("A")["cases"][1]["value"])
PLAIN = C.profile_from_dict(sub_fixture("A")["cases"][2]["value"])
ENV = {"OBSERVER_USERNAME": "user-one", "OBSERVER_PASSWORD": "hunter2-synthetic"}


class Rc:
    def __init__(self, value):
        self.value, self.is_failure = value, value >= 128 or False


class FakeClient:
    instances = []

    def __init__(self, api, **kw):
        self.kw, self.calls, self.mid = kw, [], 0
        FakeClient.instances.append(self)

    def __getattr__(self, name):
        if name == "publish":
            raise AssertionError("publish must never be reachable")

        def rec(*a, **k):
            self.calls.append((name, a, k))
            if name == "subscribe":
                self.mid += 1
                return 0, self.mid
        return rec


@pytest.fixture(autouse=True)
def fresh():
    FakeClient.instances = []


class Cb:
    def __init__(self):
        self.ev = []

    def on_connack(self, code): self.ev.append(("connack", code))
    def on_suback(self, g, r): self.ev.append(("suback", g, r))
    def on_disconnect(self): self.ev.append(("disconnect",))
    def on_connect_failed(self, why): self.ev.append(("failed", why))
    def on_message(self, t, p, r): self.ev.append(("message", t, p, r))


def make(profile=TCP_TLS, env=ENV):
    t = PahoTransport(client_factory=FakeClient, environ=dict(env))
    t.callbacks = Cb()
    t.connect(profile, "cid-1")
    return t, FakeClient.instances[-1]


def names(c):
    return [x[0] for x in c.calls]


def test_clean_session_v311_and_reconnect_backoff():
    t, c = make()
    assert c.kw["client_id"] == "cid-1" and c.kw["clean_session"] is True and c.kw["protocol"] == 4  # MQTTv311
    assert [x for x in c.calls if x[0] == "reconnect_delay_set"][0][2] == {"min_delay": BACKOFF_MIN_S, "max_delay": BACKOFF_MAX_S}
    assert (BACKOFF_MIN_S, BACKOFF_MAX_S) == (1, 120)
    assert names(c)[-2:] == ["connect_async", "loop_start"]


def test_tls_verifies_certificates_and_host():
    t, c = make(TCP_TLS)
    ctx = [x for x in c.calls if x[0] == "tls_set_context"][0][1][0]
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True
    t2, c2 = make(PLAIN, {})
    assert "tls_set_context" not in names(c2)


def test_websockets_path_and_transport():
    _t, c = make(WSS, {})
    assert c.kw["transport"] == "websockets"
    assert [x for x in c.calls if x[0] == "ws_set_options"][0][2] == {"path": "/mqtt"}


def test_credentials_are_read_at_connect_and_before_each_attempt():
    env = dict(ENV)
    t = PahoTransport(client_factory=FakeClient, environ=env)
    t.callbacks = Cb()
    t.connect(TCP_TLS, "cid")
    c = FakeClient.instances[-1]
    assert [x for x in c.calls if x[0] == "username_pw_set"][-1][1] == ("user-one", "hunter2-synthetic")
    env["OBSERVER_PASSWORD"] = "rotated-synthetic"
    c.on_pre_connect(c, None)
    assert [x for x in c.calls if x[0] == "username_pw_set"][-1][1] == ("user-one", "rotated-synthetic")
    del env["OBSERVER_PASSWORD"]
    c.on_pre_connect(c, None)  # a missing variable at a retry does not raise out of the library thread


def test_missing_credential_variable_refuses_to_connect():
    t = PahoTransport(client_factory=FakeClient, environ={})
    t.callbacks = Cb()
    with pytest.raises(TransportError) as e:
        t.connect(TCP_TLS, "cid")
    assert "OBSERVER_USERNAME" in str(e.value) and FakeClient.instances == []


def test_connack_subscribe_suback_message_flow():
    t, c = make()
    c.on_connect(c, None, {}, Rc(0), None)
    t.subscribe("a/#", 0)
    t.subscribe("b/+", 0)
    subs = [x for x in c.calls if x[0] == "subscribe"]
    assert [(s[1][0], s[1][1]) for s in subs] == [("a/#", 0), ("b/+", 0)]
    c.on_subscribe(c, None, 1, [Rc(0)], None)
    c.on_subscribe(c, None, 2, [Rc(128)], None)
    c.on_subscribe(c, None, 99, [Rc(0)], None)  # an id we never sent: ignored
    class M: topic, payload, retain = "a/x", bytearray(b"\x00\x01"), 1
    c.on_message(c, None, M())
    c.on_disconnect(c, None, None, Rc(0), None)
    c.on_connect(c, None, {}, Rc(5), None)
    c.on_connect_fail(c, None)
    assert t.callbacks.ev == [("connack", 0), ("suback", ["a/#"], []), ("suback", [], ["b/+"]),
                              ("message", "a/x", b"\x00\x01", True), ("disconnect",), ("connack", 5),
                              ("failed", "network error")]
    t.disconnect()
    t.disconnect()  # idempotent
    assert names(c).count("loop_stop") == 1


def test_tls_failure_reason():
    t, c = make()
    c.on_log(c, None, 0, "SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
    c.on_connect_fail(c, None)
    assert t.callbacks.ev == [("failed", "tls verification failed")]


def test_no_publish_capability_is_exposed():
    t, c = make()
    assert not hasattr(t, "publish")
    public = {n for n in dir(t) if not n.startswith("_")}
    assert public == {"callbacks", "connect", "subscribe", "disconnect"}
    # drive every callback: the client's publish is never reached (FakeClient raises if it is)
    c.on_connect(c, None, {}, Rc(0), None)
    t.subscribe("a", 0)
    c.on_subscribe(c, None, 1, [Rc(0)], None)
    class M: topic, payload, retain = "a", b"x", 0
    c.on_message(c, None, M())
    c.on_disconnect(c, None, None, Rc(0), None)
    assert "publish" not in names(c)


def test_subscribe_before_connect_is_refused():
    t = PahoTransport(client_factory=FakeClient, environ=ENV)
    with pytest.raises(TransportError):
        t.subscribe("a", 0)
