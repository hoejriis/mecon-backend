"""MQTT 3.1.1 over paho-mqtt, one fresh client object per session.

A new Client is created for every connection attempt and thrown away when the
session ends. paho keeps unacknowledged publishes (and, while disconnected,
queued ones) inside the client object and resends them on reconnect; creating a
new object each time means nothing from a dead session can be sent again. The
Connector manages reconnection itself, so paho's own is held off.
"""

from __future__ import annotations

import ssl
import threading

import paho.mqtt.client as mqtt

from .config import BrokerConfig, ConfigError, read_secret
from .transport import BrokerCallbacks, ConnectResult, TransportError, Will

_AUTH_RC = {4, 5, 134, 135}  # v3.1.1 bad credentials / not authorised; v5-style codes for safety


class PahoTransport:
    callbacks: BrokerCallbacks

    def __init__(self, client_id: str, keepalive_s: int) -> None:
        self._client_id = client_id
        self._keepalive = keepalive_s
        self._client: mqtt.Client | None = None
        self._session = 0
        self._lock = threading.Lock()
        self._tls_failed = False
        self._connected = False

    def connect(self, broker: BrokerConfig, will: Will, subscriptions: list[tuple[str, int]]) -> int:
        self.disconnect()
        c = self._new_client(self._client_id, broker)
        with self._lock:
            self._session += 1
            session = self._session
        self._tls_failed = False
        self._connected = False
        c.will_set(will.topic, will.payload, will.qos, will.retain)

        def on_connect(cl, _ud, _flags, rc, _props):  # type: ignore[no-untyped-def]
            if session != self._session:
                return
            if rc.is_failure:
                kind = "auth" if rc.value in _AUTH_RC else "refused"
                self.callbacks.on_connected(session, ConnectResult(False, kind))
                return
            for topic, qos in subscriptions:
                cl.subscribe(topic, qos)
            self._connected = True
            self.callbacks.on_connected(session, ConnectResult(True))

        def on_connect_fail(_cl, _ud):  # type: ignore[no-untyped-def]
            if session == self._session:
                self.callbacks.on_connected(session, ConnectResult(False, "tls" if self._tls_failed else "network"))

        def on_disconnect(_cl, _ud, _flags, _rc, _props):  # type: ignore[no-untyped-def]
            if session == self._session and self._connected:
                self._connected = False
                self.callbacks.on_disconnected(session)

        def on_publish(_cl, _ud, mid, _rc, _props):  # type: ignore[no-untyped-def]
            if session == self._session:
                self.callbacks.on_acked(session, mid)

        def on_message(_cl, _ud, msg):  # type: ignore[no-untyped-def]
            if session == self._session:
                self.callbacks.on_message(session, msg.topic, bytes(msg.payload), bool(msg.retain))

        def on_log(_cl, _ud, _level, buf):  # type: ignore[no-untyped-def]
            # Only the failure class is kept; log text is never forwarded.
            if "CERTIFICATE_VERIFY_FAILED" in buf or "certificate verify failed" in buf.lower():
                self._tls_failed = True

        c.on_connect, c.on_connect_fail, c.on_disconnect = on_connect, on_connect_fail, on_disconnect
        c.on_publish, c.on_message, c.on_log = on_publish, on_message, on_log
        self._client = c
        c.connect_async(broker.host, broker.port, self._keepalive)
        c.loop_start()
        return session

    @staticmethod
    def _new_client(client_id: str, broker: BrokerConfig) -> mqtt.Client:
        """A fresh client with the broker's auth and TLS settings. Shared by sessions and probes."""
        pw = None
        if broker.username and broker.password_file:
            # Read before any client exists: a credential that became unreadable after startup is a
            # failed attempt (the bridge counts and logs it), never an exception out of the bridge loop.
            try:
                pw = read_secret(broker.password_file)
            except ConfigError as e:
                raise TransportError(e.problems[0]) from None
        c = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )
        # No library-side retry: the bridge decides when and where to reconnect.
        c.reconnect_delay_set(min_delay=3600, max_delay=3600)
        c.max_inflight_messages_set(64)
        if broker.username:
            c.username_pw_set(broker.username, pw)
        if broker.tls:
            ctx = ssl.create_default_context(cafile=broker.ca_file)
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            c.tls_set_context(ctx)
        return c

    def probe(self, broker: BrokerConfig, timeout_s: float) -> ConnectResult:
        """Can `broker` be reached and does it accept our login? Uses a separate client with its own
        client id (never the live one: the broker would drop the working session) and a clean
        session. It sets no will, subscribes to nothing and publishes nothing."""
        try:
            c = self._new_client(self._client_id + "-probe", broker)
        except TransportError:
            return ConnectResult(False, "auth")
        done = threading.Event()
        out: list[ConnectResult] = []
        tls_failed = [False]

        def finish(r: ConnectResult) -> None:
            if not out:
                out.append(r)
            done.set()

        def on_connect(_cl, _ud, _flags, rc, _props):  # type: ignore[no-untyped-def]
            finish(ConnectResult(True) if not rc.is_failure
                   else ConnectResult(False, "auth" if rc.value in _AUTH_RC else "refused"))

        def on_connect_fail(_cl, _ud):  # type: ignore[no-untyped-def]
            finish(ConnectResult(False, "tls" if tls_failed[0] else "network"))

        def on_log(_cl, _ud, _level, buf):  # type: ignore[no-untyped-def]
            if "CERTIFICATE_VERIFY_FAILED" in buf or "certificate verify failed" in buf.lower():
                tls_failed[0] = True

        c.on_connect, c.on_connect_fail, c.on_log = on_connect, on_connect_fail, on_log
        try:
            c.connect_async(broker.host, broker.port, self._keepalive)
            c.loop_start()
            if not done.wait(timeout_s):
                finish(ConnectResult(False, "timeout"))
        finally:
            self._close(c)
        return out[0]

    @staticmethod
    def _close(c: mqtt.Client) -> None:
        try:
            c.disconnect()
        except Exception:  # noqa: BLE001
            pass
        c.loop_stop()

    def publish(self, topic: str, payload: bytes, qos: int, retain: bool) -> int:
        c = self._client
        if c is None or not self._connected:
            raise TransportError("no live session")
        info = c.publish(topic, payload, qos, retain)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise TransportError(f"publish refused rc={info.rc}")
        return info.mid

    def disconnect(self) -> None:
        with self._lock:
            c, self._client = self._client, None
            self._session += 1  # callbacks of the old client no longer match
        self._connected = False
        if c is not None:
            self._close(c)
