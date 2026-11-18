#!/usr/bin/env python3
"""Resource and recovery measurements for the Connector, against a fake serial device and a local mosquitto.

    python scripts/measure.py --seconds 60 --out report.json

What it runs: one child process with the real Bridge and the real paho transport (the same wiring as
`python -m mecon_connector`, with the fake serial device from tests/fakes in place of a port), a
local mosquitto, and an observer in this process. Over the run it records:

  - resident memory (RSS, from /proc) of the child, sampled every second, with the interpreter alone as baseline;
  - CPU of the child (user + system seconds over wall time);
  - reconnect time: the broker is killed and restarted three times (25, 50 and 75 % of the run); the time from the
    broker listening again to the Connector reporting ready (the child's /healthz), and from the kill;
  - upstream latency p50/p95: from the child feeding a frame into the fake serial port to the observer
    receiving the publish (same host, same clock);
  - the counters the Connector keeps (delivered, dropped, uncertain).

IMPORTANT: a result is only as good as its host. Every report states the machine it ran on and a label.
Numbers from a CI runner say "runner, not a Pi". The real target is a Raspberry Pi Zero 2 W (512 MB, four
Cortex-A53 cores); run this script there for those numbers (connector/README.md, "Measuring on a Pi").
The fake serial device removes the UART: real USB serial throughput and byte loss are not measured.

Linux only (reads /proc). Needs mosquitto on PATH and the dev requirements (paho-mqtt).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import platform
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]
sys.dont_write_bytecode = True

TOPIC_ROOT = "measure/dev-0000"
SCHEMA = 1


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# --------------------------------------------------------------------------------------------- child

def child_main(argv: list[str]) -> int:
    """The Connector under test: real Bridge and PahoTransport, fake serial device, health endpoint."""
    mport, hport, rate = int(argv[0]), int(argv[1]), float(argv[2])
    from fakes.fake_serial import FakeOpener
    from mecon_connector.bridge import Bridge
    from mecon_connector.config import parse
    from mecon_connector.health import make_server, serve_in_thread
    from mecon_connector.metrics import Metrics
    from mecon_connector.paho_transport import PahoTransport
    import signal

    cfg = parse({
        "device": {"mode": "companion", "select": {"by_id": "usb-MEASURE-*"}},
        "mqtt": {
            "client_id": "measure-connector",
            "topic_root": TOPIC_ROOT,
            "keepalive_s": 5,
            "brokers": [{"name": "local", "host": "127.0.0.1", "port": mport, "tls": False, "insecure_allow_plain": True}],
        },
        "health": {"enabled": True, "bind": "127.0.0.1", "port": hport},
    })
    metrics = Metrics()
    opener = FakeOpener(enrolment="provisioned")
    dev = opener.plug()
    # A real port blocks in read() for up to its poll timeout (PySerialLink: 0.05 s) and returns at once
    # when bytes arrive. The fake returns immediately, which would make the bridge loop spin and the CPU
    # figure meaningless, so give it the same blocking behaviour.
    arrived = threading.Event()
    fake_read = dev.read

    def blocking_read(n: int) -> bytes:
        data = fake_read(n)
        if not data:
            arrived.wait(0.05)
            arrived.clear()
            data = fake_read(n)
        return data

    dev.read = blocking_read  # type: ignore[method-assign]
    bridge = Bridge(cfg, PahoTransport(cfg.mqtt.client_id, cfg.mqtt.keepalive_s), opener, metrics)
    server = make_server("127.0.0.1", hport, metrics, bridge.snapshot)
    serve_in_thread(server)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    def feeder() -> None:
        n, nxt = 0, time.monotonic()
        while not stop.is_set():
            nxt += 1.0 / rate
            time.sleep(max(0.0, nxt - time.monotonic()))
            n += 1
            # about 180 bytes of JSON, in the shape of a signed event; the send time rides inside it
            msg = json.dumps({"v": 1, "ev": "health", "seq": n, "epoch": 1, "ts": None, "data": {"t_ns": time.time_ns(),
                              "pad": "x" * 60}, "usig_boot": 1, "usig_seq": n, "usig": "U1lOVEhFVElD"}, separators=(",", ":")).encode()
            dev.say(msg)
            arrived.set()

    threading.Thread(target=feeder, daemon=True).start()
    bridge.run(stop)
    server.shutdown()
    return 0


# ------------------------------------------------------------------------------------------- parent

def proc_rss_kb(pid: int) -> int:
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    return 0


def proc_cpu_s(pid: int) -> float:
    with open(f"/proc/{pid}/stat") as f:
        parts = f.read().rsplit(")", 1)[1].split()
    return (int(parts[11]) + int(parts[12])) / os.sysconf("SC_CLK_TCK")


def pct(values: list[float], p: float) -> float:
    s = sorted(values)
    if not s:
        return float("nan")
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def cpu_model() -> str:
    try:
        for line in open("/proc/cpuinfo"):
            if line.lower().startswith(("model name", "hardware", "model\t")):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


def mem_total_mb() -> int | None:
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1.0) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            return None
    except (OSError, ValueError):
        return None


class Mosquitto:
    def __init__(self, tmp: pathlib.Path, port: int) -> None:
        self.port, self.proc = port, None
        self.conf = tmp / "mosquitto.conf"
        self.conf.write_text(f"listener {port} 127.0.0.1\nallow_anonymous true\npersistence false\nlog_dest file {tmp}/mosquitto.log\n")

    def start(self) -> float:
        self.proc = subprocess.Popen(["mosquitto", "-c", str(self.conf)], stderr=subprocess.PIPE)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            if self.proc.poll() is not None:
                raise SystemExit("mosquitto exited: " + self.proc.stderr.read().decode()[:400])
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.2).close()
                return time.monotonic()
            except OSError:
                time.sleep(0.02)
        raise SystemExit("mosquitto did not start")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(5)


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        return child_main(sys.argv[2:])
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--seconds", type=float, default=60.0, help="measurement length in seconds (default 60; use 600 or more on a Pi)")
    ap.add_argument("--rate", type=float, default=5.0, help="device messages per second fed through the Connector (default 5)")
    ap.add_argument("--outage", type=float, default=3.0, help="seconds the broker stays down in the reconnect test (default 3)")
    ap.add_argument("--label", default=None, help='what this host is; default "runner, not a Pi" (set "Raspberry Pi Zero 2 W" on a Pi)')
    ap.add_argument("--out", default="measure-report.json")
    a = ap.parse_args()
    if sys.platform != "linux":
        print("measure.py reads /proc and needs Linux (use the container: see connector/README.md)", file=sys.stderr)
        return 2
    if shutil.which("mosquitto") is None:
        print("mosquitto is not on PATH (apt-get install mosquitto)", file=sys.stderr)
        return 2
    if a.seconds < 30:
        print("--seconds must be at least 30 (the reconnect test needs room)", file=sys.stderr)
        return 2

    import paho.mqtt.client as mqtt

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="mecon-measure-"))
    mport, hport = free_port(), free_port()
    broker = Mosquitto(tmp, mport)
    broker.start()

    lat_ms: list[tuple[float, float]] = []  # (send time in epoch seconds, latency in ms)
    seen = {"n": 0, "dupes": 0, "last_seq": 0}
    lock = threading.Lock()

    def on_message(_c, _u, m) -> None:
        now = time.time_ns()
        try:
            o = json.loads(m.payload)
            ms = (now - o["data"]["t_ns"]) / 1e6
            seq = o["seq"]
        except (ValueError, KeyError, TypeError):
            return
        with lock:
            seen["n"] += 1
            if seq <= seen["last_seq"]:
                seen["dupes"] += 1
            seen["last_seq"] = max(seen["last_seq"], seq)
            lat_ms.append((o['data']['t_ns'] / 1e9, ms))

    obs = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="measure-observer", protocol=mqtt.MQTTv311)
    obs.on_message = on_message
    obs.on_connect = lambda c, *_: c.subscribe(f"{TOPIC_ROOT}/up", 1)
    obs.reconnect_delay_set(min_delay=1, max_delay=2)
    obs.connect_async("127.0.0.1", mport)
    obs.loop_start()

    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=os.pathsep.join([str(ROOT / "src"), str(ROOT / "tests")]))
    # interpreter baseline: the same imports, no bridge
    base = subprocess.run([sys.executable, "-c", "import mecon_connector.bridge, mecon_connector.paho_transport, serial, paho.mqtt.client, time, os; "
                           "print(open('/proc/self/status').read().split('VmRSS:')[1].split()[0])"], env=env, capture_output=True, text=True)
    baseline_kb = int(base.stdout.strip()) if base.returncode == 0 and base.stdout.strip().isdigit() else None

    child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), "--child", str(mport), str(hport), str(a.rate)], env=env,
                             stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)
    start_t = time.monotonic()
    result: dict = {"errors": []}
    rss: list[tuple[float, int]] = []
    try:
        end = time.monotonic() + 30
        while time.monotonic() < end and not (health(hport) or {}).get("ready"):
            if child.poll() is not None:
                raise SystemExit("child exited early: " + child.stderr.read().decode()[-600:])
            time.sleep(0.1)
        else:
            if not (health(hport) or {}).get("ready"):
                raise SystemExit("the Connector did not become ready in 30 s")
        ready_after = time.monotonic() - start_t
        cpu0, wall0 = proc_cpu_s(child.pid), time.monotonic()
        
        run_end = wall0 + a.seconds
        # three broker restarts, at 25 %, 50 % and 75 % of the run
        outage_times = [wall0 + a.seconds * f for f in (0.25, 0.5, 0.75)]
        outages: list[dict] = []
        outage_windows: list[tuple[float, float]] = []  # epoch seconds: broker killed .. Connector ready again
        while time.monotonic() < run_end:
            now = time.monotonic()
            rss.append((now - wall0, proc_rss_kb(child.pid)))
            if outage_times and now >= outage_times[0]:
                outage_times.pop(0)
                killed_epoch, killed = time.time(), time.monotonic()
                broker.stop()
                time.sleep(a.outage)
                not_ready = not (health(hport) or {}).get("ready")
                up_at = broker.start()
                rec = {"broker_down_s": round(up_at - killed, 3), "reported_not_ready_while_down": not_ready,
                       "listening_to_ready_s": None, "kill_to_ready_s": None}
                deadline = up_at + 120
                while time.monotonic() < deadline:
                    if (health(hport) or {}).get("ready"):
                        t = time.monotonic()
                        rec["listening_to_ready_s"] = round(max(0.0, t - up_at), 3)
                        rec["kill_to_ready_s"] = round(t - killed, 3)
                        outage_windows.append((killed_epoch, time.time()))
                        break
                    time.sleep(0.02)
                if rec["listening_to_ready_s"] is None:
                    result["errors"].append("the Connector did not reconnect within 120 s of the broker returning")
                if not not_ready:
                    result["errors"].append("health still said ready while the broker was down")
                outages.append(rec)
                continue
            time.sleep(1.0)
        cpu1, wall1 = proc_cpu_s(child.pid), time.monotonic()
        m = None
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{hport}/metrics", timeout=2) as r:
                m = r.read().decode()
        except OSError:
            result["errors"].append("metrics unavailable at the end")
        # clean shutdown, timed
        t0 = time.monotonic()
        child.terminate()
        try:
            rc = child.wait(20)
        except subprocess.TimeoutExpired:
            child.kill()
            rc = None
        shutdown_s = time.monotonic() - t0
    finally:
        if child.poll() is None:
            child.kill()
        obs.loop_stop()
        broker.stop()
        shutil.rmtree(tmp, ignore_errors=True)

    counters = {}
    for line in (m or "").splitlines():
        if line.startswith("mecon_connector_") and ("_total" in line) and not line.startswith("#"):
            name, _, val = line.rpartition(" ")
            try:
                if float(val):
                    counters[name] = float(val)
            except ValueError:
                pass
    rss_kb = [v for _, v in rss]
    with lock:
        pairs = list(lat_ms)
        received, dupes = seen["n"], seen["dupes"]
    wall = wall1 - wall0
    lats = [ms for _, ms in pairs]
    # Messages sent before the outage, or well after the Connector was ready again, are the steady state.
    # Those sent during it waited in the bounded queue; their latency is the outage, not the transport.
    def near_outage(t: float) -> bool:
        return any(lo - 0.5 <= t <= hi + 1.0 for lo, hi in outage_windows)

    steady = [ms for t, ms in pairs if not near_outage(t)]
    backlog = [ms for t, ms in pairs if near_outage(t)]
    report = {
        "schema": SCHEMA,
        "label": a.label or "runner, not a Pi",
        "note": "Fake serial device and local mosquitto; the numbers describe this host only. Real Pi Zero 2 W figures come from the "
                "pooled owner step in connector/README.md.",
        "host": {
            "machine": platform.machine(),
            "system": f"{platform.system()} {platform.release()}",
            "cpu_model": cpu_model(),
            "cpus": os.cpu_count(),
            "mem_total_mb": mem_total_mb(),
            "python": platform.python_version(),
            "github_actions": os.environ.get("GITHUB_ACTIONS") == "true",
            "runner_image": os.environ.get("ImageOS"),
        },
        "parameters": {"seconds": a.seconds, "rate_msgs_per_s": a.rate, "broker_outage_s": a.outage},
        "startup_to_ready_s": round(ready_after, 3),
        "memory": {
            "interpreter_with_imports_rss_mb": round(baseline_kb / 1024, 1) if baseline_kb else None,
            "rss_mb_min": round(min(rss_kb) / 1024, 1) if rss_kb else None,
            "rss_mb_median": round(statistics.median(rss_kb) / 1024, 1) if rss_kb else None,
            "rss_mb_max": round(max(rss_kb) / 1024, 1) if rss_kb else None,
            "rss_mb_first": round(rss_kb[0] / 1024, 1) if rss_kb else None,
            "rss_mb_last": round(rss_kb[-1] / 1024, 1) if rss_kb else None,
            "samples": len(rss_kb),
        },
        "cpu": {"seconds": round(cpu1 - cpu0, 3), "wall_s": round(wall, 1), "percent_of_one_core": round(100 * (cpu1 - cpu0) / wall, 2) if wall else None},
        "broker_restarts": {
            "meaning": "listening_to_ready_s: broker accepting connections again until /healthz says ready (0 means the Connector's retry landed in the same instant); "
                       "kill_to_ready_s: the whole outage including the broker's down time. Retry backoff is 1 s doubling, so the wait is bounded by the backoff step.",
            "runs": outages,
            "listening_to_ready_s_max": max((o["listening_to_ready_s"] for o in outages if o["listening_to_ready_s"] is not None), default=None),
        },
        "upstream_latency_ms": {
            "meaning": "from the device side writing a message to the observer receiving the publish; steady excludes messages sent during the broker outage",
            "steady": {"p50": round(pct(steady, 0.50), 2), "p95": round(pct(steady, 0.95), 2), "max": round(max(steady), 2) if steady else None, "n": len(steady)},
            "around_outage": {"p50": round(pct(backlog, 0.50), 2), "p95": round(pct(backlog, 0.95), 2), "max": round(max(backlog), 2) if backlog else None, "n": len(backlog)},
        },
        "delivery": {"observer_received": received, "observer_duplicates": dupes},
        "shutdown": {"exit_code": rc, "seconds": round(shutdown_s, 3)},
        "counters": counters,
        "errors": result["errors"],
    }
    pathlib.Path(a.out).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    ok = bool(not report["errors"] and len(outages) == 3 and steady and rc == 0)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
