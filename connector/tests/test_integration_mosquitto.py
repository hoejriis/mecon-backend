"""Integration tests against a real mosquitto.

Skipped unless a `mosquitto` binary is on PATH (CI installs it; the Docker test stage has it).
The serial side is still the fake device: no hardware is involved.
"""

import json
import shutil
import socket
import subprocess
import threading
import time

import paho.mqtt.client as mqtt
import pytest

from conftest import make_cfg
from fakes.fake_serial import FakeOpener
from mecon_connector.bridge import Bridge
from mecon_connector.framing import encode_mecon_frames, encode_serial_frame
from mecon_connector.metrics import Metrics
from mecon_connector.paho_transport import PahoTransport

pytestmark = pytest.mark.skipif(shutil.which("mosquitto") is None, reason="mosquitto not installed")

ROOT = "test/dev-0000"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wire(msg, xid=1):
    return b"".join(encode_serial_frame(f, 0x3E) for f in encode_mecon_frames(xid, msg))


def until(pred, timeout=15.0, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return False


class Mosq:
    """A mosquitto process with its own port, config and log."""

    def __init__(self, tmp, tls=None, password=None):
        self.tmp, self.port, self.tls, self.proc = tmp, free_port(), tls, None
        conf = [f"listener {self.port} 127.0.0.1", "persistence false", f"log_dest file {tmp}/mosq-{self.port}.log"]
        if tls:
            conf += [f"cafile {tls['ca']}", f"certfile {tls['cert']}", f"keyfile {tls['key']}"]
        if password:
            pwfile = tmp / f"pw-{self.port}"
            subprocess.run(["mosquitto_passwd", "-b", "-c", str(pwfile), "syn-user", password], check=True, capture_output=True)
            conf += ["allow_anonymous false", f"password_file {pwfile}"]
        else:
            conf += ["allow_anonymous true"]
        self.conf = tmp / f"mosq-{self.port}.conf"
        self.conf.write_text("\n".join(conf) + "\n")

    def start(self):
        self.proc = subprocess.Popen(["mosquitto", "-c", str(self.conf)], stderr=subprocess.PIPE)
        end = time.time() + 10
        while time.time() < end:
            if self.proc.poll() is not None:
                raise RuntimeError("mosquitto exited: " + self.proc.stderr.read().decode()[:400])
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.2).close()
                return self
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("mosquitto did not start")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(5)


@pytest.fixture
def tmp(tmp_path):
    return tmp_path


@pytest.fixture
def procs():
    started = []
    yield started
    for p in started:
        p.stop()


def mk_tls(tmp, name="ca"):
    """Synthetic, test-only CA and server certificate for 127.0.0.1 / localhost."""
    if shutil.which("openssl") is None:
        pytest.skip("openssl missing")
    d = tmp / name
    d.mkdir()
    sh = lambda *a: subprocess.run(a, cwd=d, check=True, capture_output=True)  # noqa: E731
    sh("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
       "-subj", f"/CN=synthetic-test-ca-{name}")
    sh("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost")
    (d / "ext").write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\n")
    sh("openssl", "x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem",
       "-days", "2", "-extfile", "ext")
    return {"ca": str(d / "ca.pem"), "cert": str(d / "srv.pem"), "key": str(d / "srv.key")}


class Backendish:
    """A paho client playing the part of whoever is on the other side of the broker."""

    def __init__(self, port, *topics):
        self.msgs = []
        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="syn-observer", protocol=mqtt.MQTTv311)
        self.c.on_message = lambda _c, _u, m: self.msgs.append((m.topic, bytes(m.payload), m.qos, m.retain))
        self.c.connect("127.0.0.1", port)
        self.c.loop_start()
        for t in topics:
            self.c.subscribe(t, 1)
        time.sleep(0.3)

    def on(self, topic):
        return [m for m in list(self.msgs) if m[0] == topic]

    def publish(self, topic, payload, retain=False):
        self.c.publish(topic, payload, 1, retain).wait_for_publish(5)

    def close(self):
        self.c.loop_stop()
        self.c.disconnect()


class Live:
    """The real Bridge with the real PahoTransport on its own thread, fake serial."""

    def __init__(self, brokers, **over):
        over.setdefault("mqtt", {})["brokers"] = brokers
        base = {"backoff": {"base_s": 0.2, "max_s": 1.0, "jitter": 0.0, "stable_after_s": 5, "hold_down_s": 3}}
        over["mqtt"].update(base and {"backoff": base["backoff"], "connect_timeout_s": 3.0, "keepalive_s": 5})
        cfg = make_cfg(**over)
        self.metrics = Metrics()
        self.transport = PahoTransport(cfg.mqtt.client_id, cfg.mqtt.keepalive_s)
        self.opener = FakeOpener()
        self.dev = self.opener.plug()
        self.bridge = Bridge(cfg, self.transport, self.opener, self.metrics)
        self.cfg = cfg
        self.stop = threading.Event()
        self.t = threading.Thread(target=self.bridge.run, args=(self.stop,), daemon=True)
        self.t.start()

    def feed(self, data):
        self.dev.feed_bytes(data)

    def close(self):
        self.stop.set()
        self.t.join(10)


def plain(port, name="local"):
    return {"name": name, "host": "127.0.0.1", "port": port, "tls": False, "insecure_allow_plain": True}


def test_roundtrip_and_retained_status(tmp, procs):
    m = Mosq(tmp).start()
    procs.append(m)
    obs = Backendish(m.port, f"{ROOT}/#")
    live = Live([plain(m.port)])
    try:
        assert until(lambda: live.bridge.snapshot()["ready"])
        msg = b'{"v":1,"id":"syn-it-1","op":"hello","pad":"\xc3\xa6 "}'
        live.feed(wire(msg))
        assert until(lambda: obs.on(f"{ROOT}/up"))
        (t, payload, qos, retain) = obs.on(f"{ROOT}/up")[0]
        assert payload == msg and retain is False and qos == 1
        assert until(lambda: live.metrics.get("upstream_acked_total") == 1)
        # status is retained: a late subscriber still sees it
        late = Backendish(m.port, f"{ROOT}/connector/status")
        assert until(lambda: late.on(f"{ROOT}/connector/status"))
        st = late.on(f"{ROOT}/connector/status")[0]
        assert st[3] is True and json.loads(st[1]) == {"v": 1, "connector": "online", "serial": "up"}
        late.close()
        # downlink: broker to serial, byte for byte, once
        cmd = b'{"v":1,"id":"syn-cmd-1","op":"clock.get"}'
        obs.publish(f"{ROOT}/down", cmd)
        assert until(lambda: live.dev.written)
        time.sleep(0.5)
        assert live.dev.written_bytes == encode_serial_frame(encode_mecon_frames(1, cmd)[0], 0x3C)
        # A command left retained on the broker comes back at every (re)subscribe. The Connector must
        # refuse it: the broker flags it retained exactly then.
        obs.publish(f"{ROOT}/down", cmd, retain=True)  # delivered live (not flagged), so it runs once
        assert until(lambda: len(live.dev.written) == 2)
        live.transport._client._sock.close()
        assert until(lambda: live.metrics.get("downlink_dropped_total", "retained") == 1, 20)
        time.sleep(0.5)
        assert len(live.dev.written) == 2  # the redelivered retained copy was not written
        obs.publish(f"{ROOT}/down", b"", retain=True)  # clear it
    finally:
        live.close()
        obs.close()


def test_abrupt_loss_leaves_will_then_reconnects(tmp, procs):
    m = Mosq(tmp).start()
    procs.append(m)
    obs = Backendish(m.port, f"{ROOT}/connector/status")
    live = Live([plain(m.port)])
    try:
        assert until(lambda: live.bridge.snapshot()["ready"])
        assert until(lambda: obs.on(f"{ROOT}/connector/status"))
        n = len(obs.msgs)
        live.transport._client._sock.close()  # drop the TCP connection with no MQTT DISCONNECT
        assert until(lambda: any(json.loads(p)["connector"] == "offline" for _t, p, _q, _r in obs.msgs[n:]), 10)
        assert until(lambda: live.bridge.snapshot()["ready"], 15)
        assert until(lambda: json.loads(obs.msgs[-1][1])["connector"] == "online", 10)
    finally:
        live.close()
        obs.close()


def test_broker_restart_never_duplicates_and_accounts_for_every_envelope(tmp, procs):
    m = Mosq(tmp).start()
    procs.append(m)
    obs = Backendish(m.port, f"{ROOT}/up")
    live = Live([plain(m.port)])
    sent = []
    try:
        assert until(lambda: live.bridge.snapshot()["ready"])
        for i in range(5):
            sent.append(b'{"id":"pre-%d"}' % i)
            live.feed(wire(sent[-1], i))
        assert until(lambda: len(obs.on(f"{ROOT}/up")) == 5)
        obs.close()
        m.stop()
        for i in range(5, 12):
            sent.append(b'{"id":"mid-%d"}' % i)
            live.feed(wire(sent[-1], i))
            time.sleep(0.05)
        assert until(lambda: live.metrics.get("broker_connected") == 0)
        m.start()
        procs.append(m)
        obs = Backendish(m.port, f"{ROOT}/up")
        assert until(lambda: live.bridge.snapshot()["ready"], 20)
        assert until(lambda: live.metrics.get("upstream_queue_depth") == 0 and live.metrics.get("upstream_inflight") == 0, 20)
        time.sleep(1.0)
        got = [p for _t, p, _q, _r in obs.on(f"{ROOT}/up")]
        assert len(got) == len(set(got)), "a payload was published twice"
        assert set(got) <= set(sent)
        # Every envelope is either on the broker or counted as lost-in-doubt or dropped: none vanishes quietly.
        missing_after_restart = len(set(sent[5:]) - set(got))
        accounted = live.metrics.get("upstream_uncertain_total") + live.metrics.total("upstream_dropped_total")
        assert missing_after_restart <= accounted
        assert live.bridge.accounting_gap() == 0
    finally:
        live.close()
        obs.close()


def test_failover_to_second_broker(tmp, procs):
    m = Mosq(tmp).start()
    procs.append(m)
    dead = free_port()
    obs = Backendish(m.port, f"{ROOT}/up")
    live = Live([plain(dead, "primary"), plain(m.port, "backup")])
    try:
        assert until(lambda: live.bridge.snapshot()["broker_name"] == "backup", 20)
        live.feed(wire(b'{"id":"via-backup"}'))
        assert until(lambda: obs.on(f"{ROOT}/up"))
        assert live.metrics.get("broker_connect_attempts_total", "network") >= 1
    finally:
        live.close()
        obs.close()


def test_tls_with_password_ok_and_wrong_ca_or_password_fail_closed(tmp, procs):
    good, other = mk_tls(tmp, "good"), mk_tls(tmp, "other")
    pwfile = tmp / "client-pw"
    pwfile.write_text("synthetic-test-password\n")
    m = Mosq(tmp, tls=good, password="synthetic-test-password").start()
    procs.append(m)
    obs = Backendish_tls(m, good["ca"], f"{ROOT}/up")

    def tls_broker(ca, pw_file):
        return {"name": "t", "host": "localhost", "port": m.port, "tls": True, "ca_file": ca, "username": "syn-user", "password_file": str(pw_file)}

    # 1. correct CA and password: connects and forwards
    live = Live([tls_broker(good["ca"], pwfile)])
    try:
        assert until(lambda: live.bridge.snapshot()["ready"], 20)
        live.feed(wire(b'{"id":"tls-ok"}'))
        assert until(lambda: obs.on(f"{ROOT}/up"))
    finally:
        live.close()
    n_ok = len(obs.on(f"{ROOT}/up"))
    # 2. a CA that did not sign the broker certificate: never connects, never publishes
    live = Live([tls_broker(other["ca"], pwfile)])
    try:
        live.feed(wire(b'{"id":"must-not-leave"}'))
        time.sleep(4)
        assert not live.bridge.snapshot()["ready"] and live.metrics.get("broker_connected") == 0
        assert live.metrics.total("broker_connect_attempts_total") >= 1
        assert live.metrics.get("broker_connect_attempts_total", "ok") == 0
    finally:
        live.close()
    # 3. right CA, wrong password: refused, fail closed
    bad = tmp / "bad-pw"
    bad.write_text("not-the-password\n")
    live = Live([tls_broker(good["ca"], bad)])
    try:
        live.feed(wire(b'{"id":"must-not-leave-2"}'))
        time.sleep(3)
        assert not live.bridge.snapshot()["ready"]
        assert live.metrics.get("broker_connect_attempts_total", "auth") >= 1
    finally:
        live.close()
    time.sleep(0.5)
    assert len(obs.on(f"{ROOT}/up")) == n_ok
    obs.close()


class Backendish_tls(Backendish):
    def __init__(self, m, ca, *topics):
        self.msgs = []
        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="syn-observer-tls", protocol=mqtt.MQTTv311)
        self.c.on_message = lambda _c, _u, mm: self.msgs.append((mm.topic, bytes(mm.payload), mm.qos, mm.retain))
        self.c.username_pw_set("syn-user", "synthetic-test-password")
        self.c.tls_set(ca_certs=ca)
        self.c.connect("localhost", m.port)
        self.c.loop_start()
        for t in topics:
            self.c.subscribe(t, 1)
        time.sleep(0.3)
