"""An in-process MQTT broker stand-in for unit tests.

A FakeNetwork holds one FakeBrokerState per broker profile name; FakeTransport
is the BrokerTransport the bridge uses. It models what matters for safety: a
session that dies after the broker received a publish but before the PUBACK, a
refused login, a broker that is down, and the last will.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from mecon_connector.config import BrokerConfig
from mecon_connector.transport import ConnectResult, TransportError, Will


@dataclass
class Received:
    topic: str
    payload: bytes
    qos: int
    retain: bool
    session: int


@dataclass
class FakeBrokerState:
    name: str
    up: bool = True
    accept: str = "ok"  # ok | auth | refused | tls
    received: list[Received] = field(default_factory=list)
    retained: dict[str, bytes] = field(default_factory=dict)
    connects: int = 0
    # How the next publish ends: ack | die_before_receive | die_after_receive | hold
    next_publish: list[str] = field(default_factory=list)

    def on_topic(self, topic: str) -> list[Received]:
        return [r for r in self.received if r.topic == topic]


class FakeNetwork:
    def __init__(self, *names: str) -> None:
        self.brokers = {n: FakeBrokerState(n) for n in names}


class FakeTransport:
    def __init__(self, network: FakeNetwork) -> None:
        self.net = network
        self.callbacks = None  # set by Bridge
        self._session = 0
        self._broker: FakeBrokerState | None = None
        self._will: Will | None = None
        self._subs: list[tuple[str, int]] = []
        self.live = False
        self.connect_calls: list[str] = []
        self.pending_acks: list[int] = []
        self._mid = 0

    # BrokerTransport
    def connect(self, broker: BrokerConfig, will: Will, subscriptions):  # type: ignore[no-untyped-def]
        self.disconnect()
        self._session += 1
        s = self._session
        self.connect_calls.append(broker.name)
        b = self.net.brokers[broker.name]
        self._broker, self._will, self._subs = b, will, list(subscriptions)
        b.connects += 1
        if not b.up:
            self.callbacks.on_connected(s, ConnectResult(False, "network"))
        elif b.accept != "ok":
            self.callbacks.on_connected(s, ConnectResult(False, b.accept))
        else:
            self.live = True
            self.callbacks.on_connected(s, ConnectResult(True))
        return s

    def publish(self, topic: str, payload: bytes, qos: int, retain: bool) -> int:
        if not self.live or self._broker is None:
            raise TransportError("no live session")
        b = self._broker
        mode = b.next_publish.pop(0) if b.next_publish else "ack"
        self._mid += 1
        mid = self._mid
        if mode == "die_before_receive":
            self.drop_session()
            return mid
        b.received.append(Received(topic, bytes(payload), qos, retain, self._session))
        if retain:
            b.retained[topic] = bytes(payload)
        if mode == "die_after_receive":
            self.drop_session()
        elif mode == "hold":
            self.pending_acks.append(mid)
        elif qos == 1:
            self.callbacks.on_acked(self._session, mid)
        return mid

    def disconnect(self) -> None:
        if self.live and self._broker is not None:
            pass  # graceful: the will is not published
        self.live = False
        self._broker = None

    # test controls
    def drop_session(self) -> None:
        """The connection dies without a DISCONNECT: the broker publishes the will."""
        if not self.live or self._broker is None:
            return
        s = self._session
        if self._will is not None:
            self._broker.retained[self._will.topic] = self._will.payload
        self.live = False
        self.callbacks.on_disconnected(s)

    def ack(self, mid: int) -> None:
        self.pending_acks.remove(mid)
        self.callbacks.on_acked(self._session, mid)

    def deliver(self, topic: str, payload: bytes, retain: bool = False) -> None:
        """A message from the broker to the Connector (the Backend publishing a command)."""
        assert self.live
        self.callbacks.on_message(self._session, topic, payload, retain)
