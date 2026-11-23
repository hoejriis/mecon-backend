"""The seam between the ingester and an MQTT client library. Receive only.

This interface has no publish. A transport that grows one is a defect, and the tests and the mutation
script check for it.
"""

from __future__ import annotations

from typing import Protocol

from .config import Profile


class TransportError(Exception):
    """The connection could not even be started (for example a credential variable is not set)."""


class TransportCallbacks(Protocol):
    """Called from the transport's own thread."""

    def on_connack(self, code: int) -> None:
        """The broker's CONNACK return code: 0 accepted, 1 to 5 the MQTT 3.1.1 refusals."""

    def on_suback(self, granted: list[str], refused: list[str]) -> None:
        """The outcome of subscribe requests, by topic filter."""

    def on_disconnect(self) -> None: ...

    def on_connect_failed(self, reason: str) -> None:
        """No CONNACK arrived: the network or TLS failed. `reason` carries no secret."""

    def on_message(self, topic: str, payload: bytes, retain: bool) -> None: ...


class Transport(Protocol):
    callbacks: TransportCallbacks  # assigned by the ingester before connect

    def connect(self, profile: Profile, client_id: str) -> None:
        """Connect with a clean session and keep reconnecting with backoff until disconnect()."""

    def subscribe(self, topic: str, qos: int) -> None:
        """One subscription request. Valid after a successful CONNACK."""

    def disconnect(self) -> None:
        """Stop receiving and close. Idempotent."""


CONNACK_TEXT = {
    1: "unacceptable protocol version",
    2: "client identifier rejected",
    3: "server unavailable",
    4: "bad user name or password",
    5: "not authorised",
}
