#!/usr/bin/env python3
"""C3 harness end to end WITHOUT hardware: the real Connector (Bridge + PahoTransport) with the FAKE serial
device from tests/fakes, against the Dockerized Mosquitto with the device-login ACL (c3_broker.sh), driven
by the harness's own c3_observer.py and c3_standin.py. It touches no serial port and no host but the local
broker. Run it through c3_fake_e2e.sh (which starts the broker and runs this in the test image).

Phases: A an enrolled fake device (events, the two stand-in reads, digests compared byte for byte);
B an unenrolled fake device (requests refused and counted while the gate is closed, nothing written);
C the ACL shape and the retained status with its last will.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import socket
import subprocess
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "src"), str(HERE.parent / "tests")]

import paho.mqtt.client as mqtt  # noqa: E402

from fakes.fake_serial import FakeOpener  # noqa: E402
from mecon_connector.bridge import Bridge  # noqa: E402
from mecon_connector.config import parse  # noqa: E402
from mecon_connector.metrics import Metrics  # noqa: E402
from mecon_connector.paho_transport import PahoTransport  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""), flush=True)


def until(pred, timeout=20.0, step=0.05):  # type: ignore[no-untyped-def]
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return False


class Run:
    """The real Connector on its own thread, with a fake device behind it."""

    def __init__(self, a, enrolment: str) -> None:  # type: ignore[no-untyped-def]
        cfg = parse({
            "device": {"mode": "companion", "select": {"path": "/dev/bench/fake"}},
            "mqtt": {
                "client_id": a.user, "topic_root": a.root, "keepalive_s": 10, "connect_timeout_s": 5.0,
                "backoff": {"base_s": 2.0, "max_s": 4.0, "jitter": 0.0},
                "brokers": [{"name": "local", "host": a.host, "port": a.port, "tls": False, "insecure_allow_plain": True,
                             "username": a.user, "password_file": str(pathlib.Path(a.secrets) / "connector.pw")}],
            },
            "downlink": {"gate": {"retry_s": 5, "recheck_s": 30, "timeout_s": 3}},
        })
        self.cfg = cfg
        self.metrics = Metrics()
        self.transport = PahoTransport(cfg.mqtt.client_id, cfg.mqtt.keepalive_s)
        self.opener = FakeOpener(enrolment=enrolment)
        self.dev = self.opener.plug()
        self.sent: list[bytes] = []  # exactly the bytes the fake device sent upstream (events and answers), in order
        orig_say = self.dev.say

        def recording_say(message, mode="whole"):  # type: ignore[no-untyped-def]
            self.sent.append(bytes(message))
            orig_say(message, mode)

        self.dev.say = recording_say  # also records the device's own deployment.get answers
        self.bridge = Bridge(cfg, self.transport, self.opener, self.metrics)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.bridge.run, args=(self.stop,), daemon=True)
        self.seen_written = 0
        self.responder_stop = threading.Event()
        self.responder = threading.Thread(target=self._respond, daemon=True)

    def start(self) -> None:
        self.thread.start()
        self.responder.start()

    def close(self) -> None:
        self.responder_stop.set()
        self.stop.set()
        self.thread.join(10)

    def say(self, message: bytes) -> None:
        self.dev.say(message)

    def event(self, name: str) -> bytes:
        return self.dev.event(ev=name, signed=True)

    def _respond(self) -> None:
        """The fake device answers requests the Connector wrote to it (anything but its own deployment.get)."""
        while not self.responder_stop.is_set():
            while self.seen_written < len(self.dev.written):
                raw = self.dev.written[self.seen_written]
                self.seen_written += 1
                try:
                    req = json.loads(self.dev._decode(raw) or b"")
                except ValueError:
                    continue
                if not isinstance(req, dict) or "id" not in req:
                    continue
                ans = {"v": 1, "id": req["id"], "status": "ok", "result": {"op": req.get("op")},
                       "usig_boot": self.dev.epoch, "usig_seq": self.dev._next_seq(), "usig": "U1lOVEhFVElD"}
                self.say(json.dumps(ans, separators=(",", ":")).encode())
            time.sleep(0.02)


def sh(args: list[str]) -> subprocess.Popen:
    return subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def tool(name: str, a, *extra: str) -> list[str]:  # type: ignore[no-untyped-def]
    pw = {"c3_observer.py": "observer.pw", "c3_standin.py": "standin.pw"}[name]
    user = {"c3_observer.py": "c3-observer", "c3_standin.py": "c3-standin"}[name]
    return [sys.executable, str(HERE / name), "--host", a.host, "--port", str(a.port), "--root", a.root, "--user", user,
            "--password-file", str(pathlib.Path(a.secrets) / pw), *extra]


class Probe:
    """A plain paho client under a harness login, for the negative checks only (never used for phase A)."""

    def __init__(self, a, user: str, pwfile: str, subscribe: str | None = None) -> None:  # type: ignore[no-untyped-def]
        self.msgs: list[tuple[str, bytes, bool]] = []
        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"probe-{user}-{time.time_ns()}")
        self.c.username_pw_set(user, pathlib.Path(a.secrets, pwfile).read_text().strip())
        self.connected = threading.Event()

        def on_connect(cl, _u, _f, rc, _p):  # type: ignore[no-untyped-def]
            if subscribe:
                cl.subscribe(subscribe, 1)
            self.connected.set()

        self.c.on_connect = on_connect
        self.c.on_message = lambda _c, _u, m: self.msgs.append((m.topic, bytes(m.payload), bool(m.retain)))
        self.c.connect(a.host, a.port, 30)
        self.c.loop_start()
        self.connected.wait(10)

    def close(self) -> None:
        self.c.loop_stop()
        self.c.disconnect()


def phase_a(a) -> None:  # type: ignore[no-untyped-def]
    print("\nPhase A: enrolled fake device, observer and stand-in as separate processes")
    out = pathlib.Path(a.out_dir) / "observer.json"
    obs = sh(tool("c3_observer.py", a, "--duration", "18", "--expect-answers", "--min-events", "3", "--json-out", str(out)))
    time.sleep(1.5)
    run = Run(a, "provisioned")
    run.start()
    try:
        check("the gate opens (deployment.get answered provisioned)", until(lambda: run.bridge.snapshot()["downlink"] == "open"),
              f"probes provisioned={run.metrics.get('downlink_gate_probes_total', 'provisioned')}")
        check("nothing was written to the device before the gate opened except its own deployment.get",
              len(run.dev.probe_writes) >= 1 and run.metrics.get("downlink_received_total") == 0 and run.dev.written == [],
              f"probe writes={len(run.dev.probe_writes)} other writes={len(run.dev.written)}")
        for name in ("inventory", "health", "radio"):
            run.say(run.event(name))
            time.sleep(0.2)
        st = sh(tool("c3_standin.py", a, "--gap", "1.5"))
        st_out = st.communicate(timeout=30)[0]
        check("the stand-in published exactly two requests", st_out.count("published ") == 2, st_out.strip().replace("\n", " | "))
        # the fake device keeps deployment.get apart (probe_writes) because it answers it itself, like the real one
        def standin_dg() -> int:
            return sum(1 for w in run.dev.probe_writes if b"c3-dg-1" in (run.dev._decode(w) or b""))

        check("both requests reached the device exactly once each (the Connector's own probes are separate)",
              until(lambda: len(run.dev.written) == 1 and standin_dg() == 1) and b"c3-hello-1" in run.dev._decode(run.dev.written[0]),
              f"hello writes={len(run.dev.written)} stand-in deployment.get writes={standin_dg()} "
              f"Connector probes={len(run.dev.probe_writes) - standin_dg()}")
        time.sleep(0.5)
        run.say(run.event("health"))
        time.sleep(2)
        own = [b for b in run.sent if json.loads(b).get("id", "").startswith("cg-")]  # answers to the Connector's own probes
        sent_digests = [hashlib.sha256(b).hexdigest()[:12] for b in run.sent if b not in own]
        m = run.metrics
        check("downlink: 2 received, 2 written, none refused", (m.get("downlink_received_total"), m.get("downlink_written_total"),
              m.get("downlink_closed_total")) == (2, 2, 0),
              f"received={m.get('downlink_received_total')} written={m.get('downlink_written_total')} closed={m.get('downlink_closed_total')}")
        text = obs.communicate(timeout=40)[0]
        print("    --- observer output (counts and kinds only) ---")
        print("\n".join("    " + line for line in text.splitlines()))
        rec = json.loads(out.read_text())
        s = rec["summary"]
        check("observer checklist all PASS", all(ok for _t, ok in rec["checklist"]), f"{sum(ok for _t, ok in rec['checklist'])}/{len(rec['checklist'])}")
        check("uplink arrived byte-identical on the right topics, in order (SHA-256 of what the device sent == what the broker delivered)",
              s["digests"] == sent_digests, f"sent={len(sent_digests)} delivered={len(s['digests'])}")
        check("events went to ev/<name> and answers to resp",
              s["by_class"].get("ev/inventory") == 1 and s["by_class"].get("ev/health") == 2 and s["by_class"].get("ev/radio") == 1
              and s["by_class"].get("resp") == 2, str(sorted(s["by_class"].items())))
        check("the answers to the Connector's own deployment.get were not published upstream (the stand-in's was)",
              own and m.get("upstream_published_total") == len(sent_digests) and m.get("downlink_gate_probes_total", "provisioned") >= 1,
              f"published={m.get('upstream_published_total')} device sent={len(run.sent)} of which {len(own)} answered the Connector itself")
        check("no unroutable drop, accounting gap 0", m.get("upstream_dropped_total", "unroutable") == 0 and run.bridge.accounting_gap() == 0)
    finally:
        run.close()


def phase_b(a) -> None:  # type: ignore[no-untyped-def]
    print("\nPhase B: unenrolled fake device, gate closed")
    obs = Probe(a, "c3-observer", "observer.pw", subscribe=a.root + "/#")
    run = Run(a, "none")
    run.start()
    try:
        check("gate stays closed on state none", until(lambda: run.metrics.get("downlink_gate_probes_total", "none") >= 1)
              and run.bridge.snapshot()["downlink"] == "closed")
        # Negative test only: a non-read request published straight to req with the stand-in's login (the stand-in
        # itself cannot build one). A closed gate must refuse both it and a read.
        neg = Probe(a, "c3-standin", "standin.pw")
        for body in (b'{"v":1,"id":"c3-neg-1","op":"channel.put"}', b'{"v":1,"id":"c3-neg-2","op":"hello"}'):
            neg.c.publish(a.root + "/req", body, qos=0).wait_for_publish(5)
        neg.close()
        check("both requests refused and counted while the gate is closed",
              until(lambda: run.metrics.get("downlink_closed_total") == 2), f"closed={run.metrics.get('downlink_closed_total')}")
        time.sleep(0.5)
        check("nothing written to the device (only its own deployment.get)", run.dev.written == [] and len(run.dev.probe_writes) >= 1,
              f"written={len(run.dev.written)}")
        check("no answer appeared on resp", not [m for m in obs.msgs if m[0].endswith("/resp")])
        run.say(run.event("health"))
        check("uplink still flows while the gate is closed (uplink-only for an unenrolled device)",
              until(lambda: [m for m in obs.msgs if m[0] == a.root + "/ev/health"]))
    finally:
        run.close()
        obs.close()


def phase_c(a) -> None:  # type: ignore[no-untyped-def]
    print("\nPhase C: ACL shape, retained status, last will")
    obs = Probe(a, "c3-observer", "observer.pw", subscribe=a.root + "/#")
    dev = Probe(a, a.user, "connector.pw")  # the device login itself, publishing by hand
    for t in ("resp", "status", "ev/health", "ev/rf", "up", "connector/status", "ev/a/b", "req", "other"):
        dev.c.publish(f"{a.root}/{t}", b'{"acl":"probe"}', qos=0)
    dev.c.publish(a.root + "x/resp", b'{"acl":"probe"}', qos=0)  # a different device root
    time.sleep(1.5)
    got = sorted({m[0][len(a.root):] for m in obs.msgs if m[1] == b'{"acl":"probe"}'})
    check("the device login can publish only resp, status and ev/+", got == ["/ev/health", "/ev/rf", "/resp", "/status"], str(got))
    dev.close()
    obs.close()
    # clear what the probe left on the retained status topic
    clear = Probe(a, a.user, "connector.pw")
    clear.c.publish(a.root + "/status", b"", qos=0, retain=True).wait_for_publish(5)
    clear.close()

    run = Run(a, "provisioned")
    run.start()
    try:
        check("online status published retained", until(lambda: run.bridge.snapshot()["ready"]))
        late = Probe(a, "c3-observer", "observer.pw", subscribe=a.root + "/status")
        check("a late subscriber is handed {\"online\":true} as a retained message",
              until(lambda: late.msgs == [(a.root + "/status", b'{"online":true}', True)]), str(late.msgs))
        late.close()
        # sever the TCP connection with no DISCONNECT: the broker publishes the will
        run.transport._client._sock.shutdown(socket.SHUT_RDWR)
        w = Probe(a, "c3-observer", "observer.pw", subscribe=a.root + "/status")
        check("after an abrupt loss the retained status is the will {\"online\":false}",
              until(lambda: (a.root + "/status", b'{"online":false}', True) in w.msgs, 10), str(w.msgs))
        w.close()
    finally:
        run.close()
    z = Probe(a, "c3-observer", "observer.pw", subscribe=a.root + "/status")
    check("a clean stop leaves {\"online\":false} retained", until(lambda: z.msgs and z.msgs[-1] == (a.root + "/status", b'{"online":false}', True)), str(z.msgs))
    z.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="mecon-c3-broker")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--root", required=True)
    ap.add_argument("--user", required=True, help="the device login's name")
    ap.add_argument("--secrets", required=True, help="the directory with connector.pw, observer.pw, standin.pw")
    ap.add_argument("--out-dir", default="/tmp")
    a = ap.parse_args()
    phase_a(a)
    phase_b(a)
    phase_c(a)
    ok = sum(1 for _n, o, _d in RESULTS if o)
    print(f"\n{ok}/{len(RESULTS)} checks passed")
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
