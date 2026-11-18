"""Interfaces the bridge core talks to. Real and fake implementations plug in here."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from .config import BrokerConfig


class SerialGone(Exception):
    """The serial port is no longer there (unplugged, reset, I/O error)."""


class SerialUnavailable(Exception):
    """No port matches the selector (yet). Not an error: the device may not be plugged in."""


class SerialAmbiguous(Exception):
    """More than one port matches the selector. The Connector refuses to guess."""


class SerialLink(Protocol):
    def read(self, max_bytes: int) -> bytes:
        """Bytes that arrived, b'' after the poll timeout. Raises SerialGone."""

    def write(self, data: bytes) -> None:
        """One write. Raises SerialGone. A failure does not prove the device saw nothing."""

    def close(self) -> None: ...


SerialOpener = Callable[[], SerialLink]


class TransportError(Exception):
    """A publish or subscribe that was refused before anything was sent."""


@dataclass(frozen=True)
class ConnectResult:
    ok: bool
    kind: str = "ok"  # ok | network | tls | auth | refused


@dataclass(frozen=True)
class Will:
    topic: str
    payload: bytes
    qos: int
    retain: bool


class BrokerCallbacks(Protocol):
    """Called from any thread. The bridge only queues them; step() acts on them."""

    def on_connected(self, session: int, result: ConnectResult) -> None: ...
    def on_disconnected(self, session: int) -> None: ...
    def on_acked(self, session: int, mid: int) -> None: ...
    def on_message(self, session: int, topic: str, payload: bytes, retain: bool) -> None: ...


class BrokerTransport(Protocol):
    """One broker session at a time.

    connect() starts a NEW session on a fresh client object that carries no state
    from the previous one: nothing queued or in flight before survives. This is
    what stops a library from replaying a half-sent publish after a reconnect.
    """

    callbacks: BrokerCallbacks  # assigned by the bridge before the first connect

    def connect(self, broker: BrokerConfig, will: Will, subscriptions: list[tuple[str, int]]) -> int:
        """Starts a session; returns its number. Callbacks carry that number, and the bridge
        ignores callbacks from any other session."""

    def publish(self, topic: str, payload: bytes, qos: int, retain: bool) -> int:
        """Hands one message to the live session; returns its id. Raises TransportError."""

    def disconnect(self) -> None:
        """Ends the session and discards the client object. Idempotent."""
