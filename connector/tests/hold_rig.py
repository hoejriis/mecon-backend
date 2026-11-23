"""A HoldBridge wired to the fake serial device, a fake Backend hold endpoint on loopback, and a fake clock.

Network I/O is real (loopback), time is fake: `wait()` steps the bridge with tiny clock increments while the
socket does its work; `jump()` moves the clock by a chosen amount for backoffs and timeouts.
"""

from __future__ import annotations

import io
import time

from conftest import Clock
from fakes.fake_hold_server import TOKEN, FakeHoldServer
from fakes.fake_serial import FakeOpener
from mecon_connector.config import parse
from mecon_connector.hold import HoldBridge
from mecon_connector.hold_transport import WebsocketsTransport
from mecon_connector.logutil import Log
from mecon_connector.metrics import Metrics


def hold_cfg(server_url, token_file, mode="companion", presentation="header", dfu=None, **hold):
    raw = {
        "transport": "hold",
        "device": {"mode": mode, "select": {"by_id": "usb-TEST_synthetic-*"}},
        "hold": {
            "base_url": server_url,
            "insecure_allow_plain": server_url.startswith("http://"),
            "token_file": str(token_file),
            "token_presentation": presentation,
            "ping_interval_s": 0,
            "connect_timeout_s": 3,
            **hold,
        },
    }
    if dfu is not None:
        raw["dfu"] = dfu
    return parse(raw)


class HoldRig:
    def __init__(self, tmp_path, server=None, mode="companion", presentation="header", enrolment="provisioned",
                 plugged=True, token=TOKEN, dfu=None, bridge_kw=None, **hold):
        self.server = server or FakeHoldServer()
        self.own_server = server is None
        self.token_file = tmp_path / "hold-token"
        self.token_file.write_text(token + "\n")
        self.token_file.chmod(0o600)
        self.cfg = hold_cfg(self.server.url, self.token_file, mode, presentation, dfu, **hold)
        self.opener = FakeOpener(mode=mode, enrolment=enrolment)
        self.dev = self.opener.plug() if plugged else None
        if self.dev is not None:
            self.dev.answers_hello = True
        self.clock = Clock()
        self.metrics = Metrics(hold=True)
        self.logbuf = io.StringIO()
        self.transport = WebsocketsTransport(self.cfg.hold)
        self.bridge = HoldBridge(self.cfg, self.transport, self.opener, self.metrics, Log(self.logbuf), self.clock,
                                 **(bridge_kw or {}))
        self.mode = mode

    # -- driving ---------------------------------------------------------------------------

    def step(self, n=1, dt=0.001):
        for _ in range(n):
            self.bridge.step()
            self.clock.advance(dt)

    def wait(self, cond, timeout=6.0, dt=0.001):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.step(dt=dt)
            if cond():
                return
            time.sleep(0.001)
        raise AssertionError(f"timed out; log:\n{self.logbuf.getvalue()[-1500:]}")

    def jump(self, dt):
        """Moves the clock by dt in one go, then steps once."""
        self.clock.advance(dt)
        self.step()

    def settle(self, n=40):
        for _ in range(n):
            self.step()
            time.sleep(0.001)

    def up(self):
        """Runs until the hold is open and the Connector has declared and said hello. Returns the server-side Conn."""
        self.wait(lambda: self.bridge._state == "connected")
        conn = self.server.current()
        self.wait(lambda: len(conn.frames) >= 2)
        return conn

    def serve_replies(self, replies):
        """The device answers a relayed request with replies(message) -> bytes | None."""
        self.dev.reply_hook = replies

    def m(self, name, label=None):
        return self.metrics.get(name, label)

    def close(self):
        self.bridge.stop()
        if self.own_server:
            self.server.shutdown()
