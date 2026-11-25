"""An in-process, pure-Python stand-in for a Backend's hold endpoint (contracts/connector-hold/v1).

It listens on loopback only, speaks real WebSocket (the `websockets` sync server), and plays the Backend's
side of the contract: it checks the token in either presentation, selects `mecon-bridge` and never echoes the
token entry, answers a bad token with an HTTP 403 or with an accepted socket closed 1008, refuses a second
agent for the same device with `refused` and close 1008, and can send any frame or close at any time.
It records everything it receives, so tests can assert on the exact text the agent put on the wire.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from http import HTTPStatus

from websockets.sync.server import serve

TOKEN = "canary-hold-token-0123456789abcdef"  # synthetic; tests search every output for it


class Conn:
    def __init__(self, ws, request) -> None:
        self.ws = ws
        self.headers = {k.lower(): v for k, v in request.headers.raw_items()}
        self.offered = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if p.strip()]
        self.path = request.path
        self.selected = ws.subprotocol
        self.frames: list[str] = []  # text frames received, in order
        self.close_code: int | None = None  # the code the agent closed with
        self.close_reason = ""
        self.closed = threading.Event()
        self.accepted = False  # the agent was let in (not rejected, not refused)

    def send(self, text: str | dict) -> None:
        self.ws.send(text if isinstance(text, str) else json.dumps(text, separators=(",", ":")))

    def close(self, code: int = 1000, reason: str = "") -> None:
        self.ws.close(code, reason)

    def drop(self) -> None:
        """Ends the TCP connection with no close frame: the agent sees 1006, as on a network loss."""
        try:
            self.ws.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def parsed(self) -> list[dict]:
        return [json.loads(f) for f in self.frames]

    def of_type(self, typ: str) -> list[dict]:
        return [f for f in self.parsed() if f.get("type") == typ]


class FakeHoldServer:
    def __init__(self, token: str = TOKEN, reject_style: str = "http", enforce_single: bool = True, ssl_context=None) -> None:
        self.token = token
        self.reject_style = reject_style  # how a bad token is refused: "http" (403 before accept) or "close" (1008 after)
        self.enforce_single = enforce_single
        self.http_status: int | None = None  # when set, every handshake is answered with this status
        self.on_connect = None  # callable(Conn), run in the handler thread once the socket is accepted
        # A Backend that has not yet noticed the agent's previous socket close: the next refuse_next accepted
        # sockets get `refused` with refuse_reason, then close 1008 (each one counted in refusals).
        self.refuse_next = 0
        self.refuse_reason = "another agent holds this device"
        self.refusals = 0
        self.conns: list[Conn] = []
        self.handshakes = 0  # connection attempts, including rejected ones
        self.handshake_times: list[float] = []
        # the DFU package route (GET /gateway/dfu-package/{job}); served only with the right token
        self.packages: dict[str, bytes] = {}
        self.package_requests: list[tuple[str, dict]] = []  # (path, headers) of every package GET
        self.package_status: int | None = None  # when set, every package GET is answered with this status
        self._lock = threading.Lock()
        self._server = serve(
            self._handler,
            "127.0.0.1",
            0,
            subprotocols=None,
            select_subprotocol=self._select,
            process_request=self._process_request,
            compression=None,
            ssl=ssl_context,
            logger=_NullLogger(),
        )
        self.port = self._server.socket.getsockname()[1]
        self.url = f"{'https' if ssl_context else 'http'}://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    # -- handshake -------------------------------------------------------------------------

    def _select(self, connection, subprotocols):
        return "mecon-bridge" if "mecon-bridge" in subprotocols else None

    def _authorized(self, request) -> bool:
        auth = request.headers.get("Authorization")
        if auth is not None:
            return auth == f"Bearer {self.token}"
        offered = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",")]
        return "mecon-bridge" in offered and f"bearer.{self.token}" in offered

    def _process_request(self, connection, request):
        if request.path.startswith("/gateway/dfu-package/"):
            return self._package(connection, request)  # plain HTTP, not a hold handshake
        with self._lock:
            self.handshakes += 1
            self.handshake_times.append(time.monotonic())
        if self.http_status is not None:
            return connection.respond(HTTPStatus(self.http_status), "synthetic\n")
        if not self._authorized(request) and self.reject_style == "http":
            return connection.respond(HTTPStatus.FORBIDDEN, "forbidden\n")
        return None

    def _package(self, connection, request):
        """The Backend's package route: the zip of an open job of the token's device, else 404 (not told apart)."""
        with self._lock:
            self.package_requests.append((request.path, {k.lower(): v for k, v in request.headers.raw_items()}))
        if self.package_status is not None:
            return connection.respond(HTTPStatus(self.package_status), "synthetic\n")
        job = request.path[len("/gateway/dfu-package/"):]
        data = self.packages.get(job)
        if request.headers.get("Authorization") != f"Bearer {self.token}" or data is None:
            return connection.respond(HTTPStatus.NOT_FOUND, "not found\n")
        resp = connection.respond(HTTPStatus.OK, "")
        resp.body = data
        for name, value in (("Content-Length", str(len(data))), ("Content-Type", "application/zip")):
            del resp.headers[name]
            resp.headers[name] = value
        return resp

    # -- the accepted socket -----------------------------------------------------------------

    def _handler(self, ws) -> None:
        conn = Conn(ws, ws.request)
        with self._lock:
            held = self.enforce_single and any(not c.closed.is_set() and c.accepted for c in self.conns)
            self.conns.append(conn)
        try:
            if not self._authorized(ws.request):
                ws.close(1008, "")
                return
            with self._lock:
                stale = self.refuse_next > 0
                if stale:
                    self.refuse_next -= 1
            if held or stale:
                with self._lock:
                    self.refusals += 1
                conn.send({"type": "refused", "reason": "another agent holds this device" if held else self.refuse_reason})
                ws.close(1008, "")
                return
            conn.accepted = True
            if self.on_connect is not None:
                self.on_connect(conn)
            for msg in ws:
                conn.frames.append(msg if isinstance(msg, str) else msg.decode("latin-1"))
        except Exception:  # noqa: BLE001  the agent went away mid-frame
            pass
        finally:
            rcvd = ws.protocol.close_rcvd
            if rcvd is not None:
                conn.close_code, conn.close_reason = rcvd.code, rcvd.reason
            conn.accepted = False
            conn.closed.set()

    # -- test helpers --------------------------------------------------------------------------

    def current(self, timeout: float = 5.0) -> Conn:
        """The newest accepted, still open connection."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self._lock:
                for c in reversed(self.conns):
                    if c.accepted and not c.closed.is_set():
                        return c
            time.sleep(0.002)
        raise AssertionError("no open hold")

    def shutdown(self) -> None:
        self._server.shutdown()
        self._thread.join(timeout=3)


class _NullLogger:
    """websockets logs through logging.LoggerAdapter-like objects; tests want silence."""

    def __getattr__(self, name):
        if name in ("debug", "info", "warning", "error", "critical", "exception", "log"):
            return lambda *a, **k: None
        if name == "isEnabledFor":
            return lambda *_: False
        raise AttributeError(name)
