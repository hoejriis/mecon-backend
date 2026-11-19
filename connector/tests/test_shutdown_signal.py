"""The real entry point, as a subprocess, against a real mosquitto and no serial device: SIGTERM must
publish status offline, close the session and exit 0 well inside the unit's TimeoutStopSec."""

import json
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import time

import pytest

from test_integration_mosquitto import Backendish, Mosq, until

pytestmark = pytest.mark.skipif(shutil.which("mosquitto") is None, reason="mosquitto not installed")

UNIT = pathlib.Path(__file__).resolve().parents[1] / "deploy" / "systemd" / "mecon-connector.service"
SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_signal_releases_the_session_and_exits_cleanly_within_the_stop_timeout(tmp_path, sig):
    m = Mosq(tmp_path).start()
    topic = "test/shutdown"
    cfg = tmp_path / "c.toml"
    cfg.write_text(
        f"""
[device]
mode = "companion"
select = {{ by_id = "usb-NOT_PRESENT-*" }}
[mqtt]
client_id = "shutdown-test"
topic_root = "{topic}"
[[mqtt.brokers]]
name = "l"
host = "127.0.0.1"
port = {m.port}
tls = false
insecure_allow_plain = true
[health]
enabled = false
"""
    )
    obs = Backendish(m.port, f"{topic}/status")
    p = subprocess.Popen(
        [sys.executable, "-m", "mecon_connector", "--config", str(cfg)],
        env={"PYTHONPATH": str(SRC), "PYTHONDONTWRITEBYTECODE": "1", "PATH": "/usr/bin:/bin"},
        stderr=subprocess.PIPE,
    )
    try:
        # no device is plugged in, so the connect-time status is {"online":false}; the clean release below
        # is a second publish of it, which the last will (sent only on an unclean close) could not be
        assert until(lambda: len(obs.on(f"{topic}/status")) == 1)
        t0 = time.monotonic()
        p.send_signal(sig)
        rc = p.wait(timeout=20)
        took = time.monotonic() - t0
        assert rc == 0
        (timeout_s,) = re.findall(r"(?m)^TimeoutStopSec=(\d+)$", UNIT.read_text())
        assert took < int(timeout_s) / 3, f"shutdown took {took:.2f}s of a {timeout_s}s budget"
        assert until(lambda: len(obs.on(f"{topic}/status")) == 2, 5), "no explicit offline status before the session closed"
        assert json.loads(obs.on(f"{topic}/status")[-1][1]) == {"online": False}
    finally:
        if p.poll() is None:
            p.kill()
        obs.close()
        m.stop()
