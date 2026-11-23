"""Integration tests against a real mosquitto, started on a free port by the test.

Skipped, with the reason, unless a `mosquitto` binary is on PATH (CI installs it). The test publishes;
the ingester under test only subscribes.
"""

import base64
import re
import shutil
import socket
import subprocess
import time

import paho.mqtt.client as mqtt
import pytest

from helpers import make_cfg
from mecon_capture.archive import Archive, content_hash
from mecon_capture.ingester import Ingester
from mecon_capture.logutil import Log
from mecon_capture.paho_transport import PahoTransport

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(shutil.which("mosquitto") is None, reason="mosquitto is not installed (the integration tests need a real broker)"),
]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def until(pred, timeout=15.0, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return False


class Mosq:
    def __init__(self, tmp, port=None):
        self.port = port or free_port()
        self.conf = tmp / f"mosq-{self.port}.conf"
        self.conf.write_text(f"listener {self.port} 127.0.0.1\npersistence false\nallow_anonymous true\n"
                             f"log_dest file {tmp}/mosq-{self.port}.log\n")
        self.proc = None

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
def broker(tmp_path):
    b = Mosq(tmp_path).start()
    yield b
    b.stop()


def make_publisher(broker):
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="test-publisher")
    c.connect("127.0.0.1", broker.port)
    c.loop_start()
    return c


def publish(c, topic, payload, retain=False):
    info = c.publish(topic, payload, qos=1, retain=retain)
    info.wait_for_publish(5)
    assert info.is_published()


def profile(port, topics):
    return {"name": "it-source", "host": "127.0.0.1", "port": port, "transport": "tcp",
            "tls": {"enabled": False, "verify": True}, "topics": topics, "adapter": "raw_hex"}


def start_ingester(tmp_path, port, topics=("it/#",), max_payload=1000):
    cfg = make_cfg([profile(port, list(topics))], tmp_path, flush_interval_s=0.05)
    archive = Archive(cfg.archive_path, max_payload)
    ig = Ingester(cfg, archive, lambda _p: PahoTransport(environ={}), log=Log(stream=open("/dev/null", "w")))
    ig.start()
    return ig, archive


def test_normal_retained_and_oversized_messages(broker, tmp_path):
    pub = make_publisher(broker)
    ig = None
    try:
        retained_payload = b"retained \x00\xff payload"
        publish(pub, "it/old", retained_payload, retain=True)  # before the ingester subscribes
        ig, archive = start_ingester(tmp_path, broker.port)
        assert until(lambda: ig.statuses()[0].get("subscribed") == ["it/#"]), ig.statuses()
        st = ig.statuses()[0]
        assert st["state"] == "connected" and st["last_error"] is None and st["refused"] == []
        normal = bytes(range(256))
        big = b"B" * 5000
        publish(pub, "it/live", normal)
        publish(pub, "it/big", big)
        assert until(lambda: len(archive.read_committed()) >= 3), archive.read_committed()
        rows = {r["topic"]: r for r in archive.read_committed()}
        assert len(rows) == 3
        assert rows["it/old"]["retained"] is True and rows["it/old"]["payload"] == retained_payload
        assert rows["it/live"]["retained"] is False and rows["it/live"]["payload"] == normal
        big_row = rows["it/big"]
        assert big_row["stub"] and big_row["payload"] is None and big_row["payload_size"] == 5000
        assert big_row["content_hash"] == content_hash("it/big", big) and not big_row["retained"]
        for r in rows.values():
            assert r["source"] == "it-source"
            assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", r["received_at"])
        ids = [r["capture_id"] for r in archive.read_committed()]
        assert ids == sorted(ids)
        c = archive.counters()
        assert (c["received"], c["committed"], c["stubbed"], c["rejected"], c["dropped"]) == (3, 3, 1, 0, 0)
        # received_at is arrival time: close to now, and not later than the commit
        arrival = time.strptime(rows["it/live"]["received_at"][:19], "%Y-%m-%dT%H:%M:%S")
        assert abs(time.mktime(arrival) - time.mktime(time.gmtime())) < 120
    finally:
        if ig:
            ig.stop()
        pub.loop_stop()
        pub.disconnect()


def test_broker_restart_resubscribes_and_clean_session_client_id(broker, tmp_path):
    ig, archive = start_ingester(tmp_path, broker.port)
    try:
        assert until(lambda: ig.statuses()[0].get("subscribed") == ["it/#"])
        port = broker.port
        broker.stop()
        assert until(lambda: ig.statuses()[0]["state"] in ("disconnected", "error"))
        time.sleep(1.1)  # at least one failed attempt at the 1 s backoff
        broker.proc = None
        b2 = Mosq(tmp_path, port=port)
        b2.conf = broker.conf
        b2.start()
        try:
            assert until(lambda: ig.statuses()[0]["state"] == "connected" and ig.statuses()[0].get("subscribed") == ["it/#"], 30)
            pub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="test-publisher-2")
            pub.connect("127.0.0.1", port)
            pub.loop_start()
            publish(pub, "it/after", b"after restart")
            pub.loop_stop()
            pub.disconnect()
            assert until(lambda: any(r["topic"] == "it/after" for r in archive.read_committed()))
        finally:
            b2.stop()
    finally:
        ig.stop()


def test_ingester_publishes_nothing(broker, tmp_path):
    """A second client subscribed to everything sees no message from the ingester while it runs."""
    seen = []
    spy = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="test-spy")
    spy.on_message = lambda c, u, m: seen.append((m.topic, bytes(m.payload)))
    spy.connect("127.0.0.1", broker.port)
    spy.subscribe("#")
    spy.loop_start()
    ig, archive = start_ingester(tmp_path, broker.port)
    try:
        assert until(lambda: ig.statuses()[0].get("subscribed") == ["it/#"])
        time.sleep(1.0)
        assert seen == []
    finally:
        ig.stop()
        spy.loop_stop()
        spy.disconnect()
