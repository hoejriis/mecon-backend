"""The WebSocket client for the hold (contracts/connector-hold/v1), on the `websockets` sync client.

One session at a time. A session is one connection: a thread opens it, then reads frames and reports
them to the bridge through callbacks (which only queue them; the bridge acts in step()). Sending is done
from the bridge's thread. Nothing here looks inside a frame.

The token is read from its file when the session starts, held only in a local variable for the handshake,
and never logged, put in an exception message or kept on the object. The `websockets` library logs to a
logger that is silenced here, because its debug output includes handshake headers.
"""

from __future__ import annotations

import contextlib
import logging
import ssl
import threading
from typing import Callable, Protocol

from .config import HoldConfig, ConfigError, read_token
from .transport import TransportError

SUBPROTOCOL = "mecon-bridge"
CLOSE_POLICY = 1008

_silent = logging.getLogger("mecon_connector.websockets")
_silent.addHandler(logging.NullHandler())
_silent.propagate = False
_silent.setLevel(logging.CRITICAL + 1)


class HoldCallbacks(Protocol):
    """Called from the session thread. The bridge only queues them."""

    def on_open(self, session: int, subprotocol: str | None) -> None: ...
    def on_frame(self, session: int, frame: str | bytes) -> None: ...
    def on_failed(self, session: int, kind: str) -> None:
        """The connection never opened. kind: network | tls | timeout | http | bad_token."""

    def on_closed(self, session: int, code: int, reason: str) -> None:
        """An open connection ended. code is 1006 when no close frame arrived."""


class HoldTransport(Protocol):
    callbacks: HoldCallbacks

    def connect(self) -> int:
        """Starts a session; returns its number. Raises TransportError when the credential cannot be read."""

    def send(self, text: str) -> None:
        """One text frame on the live session. Raises TransportError."""

    def close(self, code: int = 1000, reason: str = "stopped") -> None:
        """Closes the live session with a close frame (bounded wait) and forgets it. Idempotent."""


class WebsocketsTransport:
    def __init__(self, cfg: HoldConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._session = 0
        self._ws = None  # the live connection
        self.callbacks: HoldCallbacks = None  # type: ignore[assignment]  # set by the bridge

    def connect(self) -> int:
        c = self.cfg
        try:
            token = read_token(c.token_file, c.token_presentation)
        except ConfigError as e:
            raise TransportError(e.problems[0]) from None
        with self._lock:
            self._session += 1
            session = self._session
        threading.Thread(target=self._run, args=(session, token), name=f"hold-{session}", daemon=True).start()
        return session

    def _run(self, session: int, token: str) -> None:
        from websockets.exceptions import ConnectionClosed, InvalidStatus
        from websockets.sync.client import connect

        c = self.cfg
        kw: dict = {}
        if c.token_presentation == "subprotocol":
            kw["subprotocols"] = [SUBPROTOCOL, f"bearer.{token}"]
        else:
            kw["additional_headers"] = {"Authorization": f"Bearer {token}"}
        if c.ws_url.startswith("wss://"):
            kw["ssl"] = ssl.create_default_context(cafile=c.ca_file)
        del token  # the handshake arguments hold the only remaining copy
        stack = contextlib.ExitStack()
        try:
            ws = stack.enter_context(connect(
                c.ws_url,
                compression=None,
                proxy=None,  # a hold goes where it was configured to go, never through an environment proxy
                open_timeout=c.connect_timeout_s,
                ping_interval=c.ping_interval_s or None,
                ping_timeout=c.ping_interval_s or None,
                close_timeout=3,
                max_size=64 * 1024,
                logger=_silent,
                user_agent_header="mecon-connector",
                **kw,
            ))
        except InvalidStatus as e:
            # 401 and 403 are a token the Backend does not accept; any other status is a Backend or path problem.
            self.callbacks.on_failed(session, "bad_token" if e.response.status_code in (401, 403) else "http")
            return
        except ssl.SSLError:
            self.callbacks.on_failed(session, "tls")
            return
        except TimeoutError:
            self.callbacks.on_failed(session, "timeout")
            return
        except Exception:  # noqa: BLE001  a failed attempt is counted by class, never by message
            self.callbacks.on_failed(session, "network")
            return
        finally:
            kw.clear()
        with self._lock:
            if session != self._session:  # superseded while connecting
                stack.close()
                return
            self._ws = ws
        self.callbacks.on_open(session, ws.subprotocol)
        try:
            while True:
                self.callbacks.on_frame(session, ws.recv())
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001  anything else ends the session as a lost connection
            pass
        finally:
            code, reason = 1006, ""
            if ws.protocol.close_rcvd is not None:
                code, reason = ws.protocol.close_rcvd.code, ws.protocol.close_rcvd.reason
            with self._lock:
                if self._ws is ws:
                    self._ws = None
            stack.close()
            self.callbacks.on_closed(session, code, reason)

    def send(self, text: str) -> None:
        with self._lock:
            ws = self._ws
        if ws is None:
            raise TransportError("no hold")
        try:
            ws.send(text)
        except Exception as e:  # noqa: BLE001
            raise TransportError(type(e).__name__) from None

    def close(self, code: int = 1000, reason: str = "stopped") -> None:
        with self._lock:
            ws, self._ws = self._ws, None
            self._session += 1  # callbacks of the session being closed are ignored by the bridge
        if ws is not None:
            try:
                ws.close(code, reason)
            except Exception:  # noqa: BLE001  closing a dead connection must not raise
                pass
