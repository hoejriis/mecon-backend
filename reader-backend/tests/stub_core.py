"""A stub core that serves contracts/session-lookup/v1 over the fake world, on a real loopback socket.

Decisions come from `fakes/lookup.py` (the same fake the facade's tests use); this module adds only the HTTP
shape: the service token check (401 `service_unauthorized`), 200 `Caller`, 403 `Denied`, 503 while the fake
cannot answer, and `GET /revocations` as server-sent events with a heartbeat comment. It is test code: the
service token is made up per stub and every user, origin and id is synthetic.

`serve(app)` runs any ASGI app under uvicorn on 127.0.0.1 with a free port, in the running event loop, so
the adapter is driven over real HTTP (streaming, timeouts and redirects behave as they would against a core).
"""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import secrets
from typing import Any

import uvicorn

from mecon_reader_backend.fakes import FakeSessionLookup, World
from mecon_reader_backend.fakes.world import iso
from mecon_reader_backend.ports import Caller, Denied, Revocation, Subscribed

HEARTBEAT = b": heartbeat\n\n"


def world_from_lookup_description(desc: dict) -> World:
    """The fake World for a session-lookup world (worlds.json): its users and its origin allow-list."""
    users = {name: {"email": f"{name}@example.test", "display_name": u["display_name"], "fleet": "fleet_basic",
                    "role": u.get("role", "user")} for name, u in desc["users"].items()}
    world = World.from_description({"fleets": ["fleet_basic"], "users": users})
    world.reader_origins = tuple(desc["origin_allow_list"])
    return world


def caller_wire(c: Caller) -> dict[str, Any]:
    body = {"user_id": c.user_id, "session_ref": c.session_ref, "role": c.role, "break_glass": c.break_glass,
            "display_name": c.display_name, "capabilities": dict(c.capabilities), "expires_at": iso(c.expires_at)}
    if c.csrf_token is not None:
        body["csrf_token"] = c.csrf_token
    return body


def answer_wire(answer: Caller | Denied) -> tuple[int, dict[str, Any]]:
    """A port answer as the contract's status and body."""
    if isinstance(answer, Caller):
        return 200, caller_wire(answer)
    if answer.reason == "core_unavailable":
        return 503, {"reason": "core_unavailable", "retryable": True}
    return 403, {"reason": answer.reason, "retryable": False}


def item_wire(item: Subscribed | Revocation) -> dict[str, Any]:
    if isinstance(item, Subscribed):
        return {"type": "subscribed"}
    return {"type": "revocation", "session_ref": item.session_ref, "reason": item.reason}


def sse(obj: dict) -> bytes:
    return b"data: " + json.dumps(obj, separators=(",", ":")).encode() + b"\n\n"


async def read_body(receive) -> bytes:
    body = bytearray()
    while True:
        msg = await receive()
        if msg["type"] == "http.disconnect":
            break
        body.extend(msg.get("body", b""))
        if not msg.get("more_body", False):
            break
    return bytes(body)


async def respond(send, status: int, body: bytes = b"", content_type: str = "application/json",
                  extra: list[tuple[bytes, bytes]] | None = None) -> None:
    headers = [(b"content-type", content_type.encode()), (b"content-length", str(len(body)).encode())]
    await send({"type": "http.response.start", "status": status, "headers": headers + (extra or [])})
    await send({"type": "http.response.body", "body": body})


async def stream_until_disconnect(receive, send, next_chunk, *, heartbeat_s: float | None) -> None:
    """Send an event stream: each chunk `next_chunk()` gives, a heartbeat after `heartbeat_s` of quiet (None: no
    heartbeat, the stream goes silent), until the client disconnects."""
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"text/event-stream"), (b"cache-control", b"no-store")]})
    gone_evt = asyncio.Event()

    async def watch():
        while True:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                gone_evt.set()
                return
    watcher = asyncio.ensure_future(watch())
    try:
        while not gone_evt.is_set():
            getter = asyncio.ensure_future(next_chunk())
            stop = asyncio.ensure_future(gone_evt.wait())
            done, _ = await asyncio.wait({getter, stop}, timeout=heartbeat_s, return_when=asyncio.FIRST_COMPLETED)
            stop.cancel()
            if getter in done:
                chunk = getter.result()
                if chunk is None:
                    break  # the server ends the stream
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
                continue
            getter.cancel()
            if gone_evt.is_set():
                break
            if heartbeat_s is not None:
                await send({"type": "http.response.body", "body": HEARTBEAT, "more_body": True})
        if not gone_evt.is_set():
            await send({"type": "http.response.body", "body": b"", "more_body": False})
    finally:
        watcher.cancel()


class StubCore:
    """POST /lookup and GET /revocations over a fake World, with a service token."""

    def __init__(self, world: World, token: str | None = None, *, heartbeat_s: float = 0.5):
        self.world = world
        self.token = token or "synthetic-service-token-" + secrets.token_hex(12)
        self.lookup = FakeSessionLookup(world)  # its `unavailable` flag is the 503 toggle
        self.heartbeat_s = heartbeat_s
        self.requests: list[dict[str, Any]] = []  # path, the Authorization header's presence and match, the body
        self.served: list[tuple[str, int]] = []

    def _authorized(self, headers: dict[bytes, bytes]) -> tuple[bool, bool]:
        got = headers.get(b"authorization")
        want = ("Bearer " + self.token).encode()
        return got is not None, got is not None and hmac.compare_digest(got, want)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        headers = dict(scope["headers"])
        present, ok = self._authorized(headers)
        path, method = scope["path"], scope["method"]
        body = await read_body(receive) if method == "POST" else b""
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = body
        self.requests.append({"path": path, "method": method, "auth_present": present, "auth_ok": ok,
                              "body": parsed})
        if (method, path) not in (("POST", "/lookup"), ("GET", "/revocations")):
            self.served.append((path, 404))
            return await respond(send, 404, b'{"code":"not_found"}')
        if not ok:
            self.served.append((path, 401))
            return await respond(send, 401, b'{"code":"service_unauthorized"}')
        if path == "/lookup":
            return await self._lookup(parsed, send)
        return await self._revocations(receive, send)

    async def _lookup(self, req: Any, send) -> None:
        if not isinstance(req, dict) or not isinstance(req.get("credential"), str) or "purpose" not in req:
            self.served.append(("/lookup", 422))
            return await respond(send, 422, b'{"code":"invalid"}')
        answer = await self.lookup.resolve(req["credential"], req["purpose"], csrf_token=req.get("csrf_token"),
                                           origin=req.get("origin"), sec_fetch_site=req.get("sec_fetch_site"))
        status, wire = answer_wire(answer)
        self.served.append(("/lookup", status))
        await respond(send, status, json.dumps(wire).encode())

    async def _revocations(self, receive, send) -> None:
        self.served.append(("/revocations", 200))
        q: asyncio.Queue = asyncio.Queue()
        self.world.revocation_queues.append(q)
        first = [sse(item_wire(Subscribed())), HEARTBEAT]  # subscribed, then caught up

        async def next_chunk():
            if first:
                return first.pop(0)
            return sse(item_wire(await q.get()))
        try:
            await stream_until_disconnect(receive, send, next_chunk, heartbeat_s=self.heartbeat_s)
        finally:
            self.world.revocation_queues.remove(q)


@contextlib.asynccontextmanager
async def serve(app):
    """Run `app` on 127.0.0.1 (a free port) in this event loop; yields its base URL."""
    config = uvicorn.Config(app, host="127.0.0.1", port=0, lifespan="off", log_level="warning", access_log=False,
                            timeout_graceful_shutdown=1, loop="asyncio", http="h11", ws="none")
    server = uvicorn.Server(config)
    task = asyncio.ensure_future(server.serve())
    for _ in range(500):
        if server.started or task.done():
            break
        await asyncio.sleep(0.01)
    if not server.started:
        task.cancel()
        raise RuntimeError("the stub server did not start")
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
