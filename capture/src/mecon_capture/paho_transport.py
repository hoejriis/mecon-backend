"""MQTT 3.1.1 over paho-mqtt, receive only.

One client per profile, a clean session, TLS with certificate and host-name verification always on.
paho reconnects by itself with exponential backoff (1 s doubling to 120 s); every reconnect fires the
connect callback again, which is where the ingester subscribes. Credentials are read from the named
environment variables before every connection attempt and never logged.
"""

from __future__ import annotations

import ssl
import threading
from typing import Any, Callable

import paho.mqtt.client as mqtt

from .config import Profile, CredentialError, read_credentials
from .transport import TransportCallbacks, TransportError

BACKOFF_MIN_S = 1
BACKOFF_MAX_S = 120
KEEPALIVE_S = 60


class PahoTransport:
    callbacks: TransportCallbacks

    def __init__(self, client_factory: Callable[..., Any] | None = None, environ: dict[str, str] | None = None) -> None:
        self._factory = client_factory or mqtt.Client
        self._environ = environ
        self._client: Any = None
        self._profile: Profile | None = None
        self._mids: dict[int, str] = {}
        self._lock = threading.Lock()
        self._tls_failed = False

    def connect(self, profile: Profile, client_id: str) -> None:
        self.disconnect()
        self._profile = profile
        try:
            self._apply_credentials(None, profile)  # fail now if a named variable is missing
        except CredentialError as e:
            raise TransportError(str(e)) from None
        kw: dict[str, Any] = {"client_id": client_id, "protocol": mqtt.MQTTv311, "clean_session": True}
        if profile.transport == "websockets":
            kw["transport"] = "websockets"
        c = self._factory(mqtt.CallbackAPIVersion.VERSION2, **kw)
        c.reconnect_delay_set(min_delay=BACKOFF_MIN_S, max_delay=BACKOFF_MAX_S)
        if profile.transport == "websockets":
            c.ws_set_options(path=profile.ws_path)
        if profile.tls_enabled:
            ctx = ssl.create_default_context()
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            c.tls_set_context(ctx)
        self._apply_credentials(c, profile)
        self._tls_failed = False
        self._mids = {}

        def on_pre_connect(cl: Any, _ud: Any) -> None:
            try:
                self._apply_credentials(cl, profile)  # re-read at every attempt
            except CredentialError:
                pass  # keep the last values; the broker's answer reports a stale credential

        def on_connect(cl: Any, _ud: Any, _flags: Any, rc: Any, _props: Any) -> None:
            self._mids = {}
            self.callbacks.on_connack(int(rc.value))

        def on_connect_fail(_cl: Any, _ud: Any) -> None:
            self.callbacks.on_connect_failed("tls verification failed" if self._tls_failed else "network error")

        def on_disconnect(_cl: Any, _ud: Any, _flags: Any, _rc: Any, _props: Any) -> None:
            self.callbacks.on_disconnect()

        def on_subscribe(_cl: Any, _ud: Any, mid: int, codes: Any, _props: Any) -> None:
            with self._lock:
                topic = self._mids.pop(mid, None)
            if topic is None:
                return
            failed = any(getattr(rc, "is_failure", False) for rc in codes)
            self.callbacks.on_suback([] if failed else [topic], [topic] if failed else [])

        def on_message(_cl: Any, _ud: Any, msg: Any) -> None:
            self.callbacks.on_message(msg.topic, bytes(msg.payload), bool(msg.retain))

        def on_log(_cl: Any, _ud: Any, _level: Any, buf: str) -> None:
            if "certificate verify failed" in buf.lower():  # only the failure class is kept, never the text
                self._tls_failed = True

        c.on_pre_connect, c.on_connect, c.on_connect_fail = on_pre_connect, on_connect, on_connect_fail
        c.on_disconnect, c.on_subscribe, c.on_message, c.on_log = on_disconnect, on_subscribe, on_message, on_log
        self._client = c
        c.connect_async(profile.host, profile.port, KEEPALIVE_S)
        c.loop_start()

    def _apply_credentials(self, client: Any, profile: Profile) -> None:
        user, pw = read_credentials(profile, self._environ)
        if client is not None and user is not None:
            client.username_pw_set(user, pw)

    def subscribe(self, topic: str, qos: int) -> None:
        c = self._client
        if c is None:
            raise TransportError("not connected")
        with self._lock:
            result, mid = c.subscribe(topic, qos)
            if result == mqtt.MQTT_ERR_SUCCESS:
                self._mids[mid] = topic
        if result != mqtt.MQTT_ERR_SUCCESS:
            raise TransportError(f"subscribe refused rc={result}")

    def disconnect(self) -> None:
        c, self._client = self._client, None
        if c is not None:
            try:
                c.disconnect()
            except Exception:  # noqa: BLE001
                pass
            c.loop_stop()
