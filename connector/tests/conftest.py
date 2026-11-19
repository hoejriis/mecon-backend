import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
sys.dont_write_bytecode = True

from mecon_connector.bridge import Bridge  # noqa: E402
from mecon_connector.config import parse  # noqa: E402
from mecon_connector.metrics import Metrics  # noqa: E402

from fakes.fake_broker import FakeNetwork, FakeTransport  # noqa: E402
from fakes.fake_serial import FakeOpener  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "connector" / "v1" / "fixtures"


def make_cfg(mode="companion", brokers=("primary",), **over):
    raw = {
        "device": {"mode": mode, "select": {"by_id": "usb-TEST_synthetic-*"}},
        "mqtt": {
            "client_id": "test-connector",
            "topic_root": "test/dev-0000",
            "brokers": [
                {"name": n, "host": f"{n}.invalid", "tls": False, "insecure_allow_plain": True} for n in brokers
            ],
        },
    }
    for k, v in over.items():
        raw.setdefault(k, {}).update(v)
    return parse(raw)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class Rig:
    """A bridge wired to fakes, a fake clock and no jitter."""

    def __init__(self, cfg=None, brokers=("primary",), plugged=True, enrolment="provisioned", **kw):
        self.cfg = cfg or make_cfg(brokers=brokers, **kw)
        names = [b.name for b in self.cfg.mqtt.brokers]
        self.net = FakeNetwork(*names)
        self.transport = FakeTransport(self.net)
        self.opener = FakeOpener(mode=self.cfg.device.mode, enrolment=enrolment)
        self.dev = self.opener.plug() if plugged else None
        self.clock = Clock()
        self.metrics = Metrics()
        self.bridge = Bridge(
            self.cfg, self.transport, self.opener, self.metrics, clock=self.clock, rng=lambda: 0.5,
            probe_runner=lambda fn: fn(),  # the fake probe is instant: run it inline, deterministically
        )
        self.up = self.cfg.mqtt.topic_up
        self.down = self.cfg.mqtt.topic_down
        self.status = self.cfg.mqtt.topic_status

    def step(self, n=1, dt=0.01):
        for _ in range(n):
            self.bridge.step()
            self.clock.advance(dt)

    def settle(self, n=6):
        self.step(n)

    def pump(self, extra=4):
        """Steps until the fake device has nothing left to deliver, then a few more."""
        guard = 0
        while self.dev is not None and self.dev._chunks and guard < 100000:
            self.step(dt=0.0001)  # about 10 kB/s, like a real UART
            guard += 1
        self.step(extra)

    def published(self, broker="primary"):
        return [r.payload for r in self.net.brokers[broker].on_topic(self.up)]


@pytest.fixture
def rig():
    return Rig()


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text())
