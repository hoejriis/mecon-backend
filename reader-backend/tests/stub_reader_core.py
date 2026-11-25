"""A stub core that serves contracts/reader-core/v1 over the fake world, on a real loopback socket.

Decisions come from `FakeReaderCore` (the same fake the facade's tests use); this module adds only the HTTP shape,
in the contract's order of checks: the service token (401 `service_unauthorized`), the body against the operation's
request schema (422 `malformed_request`, a fixed body), then the fake's answer turned into the contract's status and
body by `dispatch`, which the fake-mode replay calls directly too. It is test code: the service token is made up per
stub and every user, origin and id is synthetic.
"""
from __future__ import annotations

import hmac
import json
import secrets
from datetime import timedelta
from typing import Any

from mecon_reader_backend.fakes import FakeReaderCore, World
from mecon_reader_backend.fakes.world import iso, now
from mecon_reader_backend.ports import Caller, CoreError, EventBatch, LoginPoll, Page
from replay import Contract, REPO
from stub_core import read_body, respond

CORE = Contract("mecon-reader-core", REPO / "contracts" / "reader-core" / "v1",
                ("events", "leases", "reads", "send", "session", "transport"), "",
                ("issue-session", "user-id", "end-session", "expire-session", "approve-login",
                 "exhaust-login-limit", "set-switch",
                 "age-out-events", "core-degraded", "core-recovered"),
                lambda desc: (None, None, None, {}))

MALFORMED = {"code": "malformed_request", "retryable": False}
INVALID = {"code": "invalid", "retryable": False}  # createSendAttempt: a well-formed envelope, a refused `request`
SERVICE_UNAUTHORIZED = {"code": "service_unauthorized"}
KIND_STATUS = {"not_found": 404, "forbidden": 403, "conflict": 409, "unavailable": 503, "invalid": 422,
               "gone": 410, "throttled": 429}


def world_from_core_description(desc: dict) -> World:
    world = World.from_description(desc)
    world.reader_origins = tuple(desc["origin_allow_list"])
    return world


def caller_from(ref: dict) -> Caller:
    """The port's Caller from the contract's caller reference. The core reads only `user_id` and `session_ref`;
    the other fields are placeholders, never consulted."""
    return Caller(session_ref=ref["session_ref"], user_id=ref["user_id"], display_name="", role="user",
                  break_glass=False, capabilities={}, expires_at=now() + timedelta(hours=1))


def page_wire(p: Page) -> dict[str, Any]:
    return {"items": p.items, "next_cursor": p.next_cursor, "as_of": iso(p.as_of)}


def poll_wire(p: LoginPoll) -> dict[str, Any]:
    body: dict[str, Any] = {"state": p.state}
    if p.poll_after_ms is not None:
        body["poll_after_ms"] = p.poll_after_ms
    if p.state == "approved":
        body["credential"] = p.credential
        body["expires_at"] = iso(p.expires_at)
    return body


def error_wire(e: CoreError) -> tuple[int, dict[str, Any]]:
    body: dict[str, Any] = {"code": e.code, "retryable": e.retryable}
    if e.kind == "throttled" and e.retry_after_s:
        body["retry_after_s"] = e.retry_after_s
    return KIND_STATUS[e.kind], body


async def dispatch(core: FakeReaderCore, op: str, body: dict | None) -> tuple[int, Any]:
    """One well-formed call into the fake, as (status, JSON body or None)."""
    b = body or {}
    c = caller_from(b["caller"]) if "caller" in b else None
    try:
        if op == "getHealth":
            return 200, await core.health()
        if op == "startLogin":
            return 202, await core.start_login(b["email"], origin=b["origin"], sec_fetch_site=b["sec_fetch_site"],
                                               client_address=b["client_address"])
        if op == "pollLogin":
            return 200, poll_wire(await core.poll_login(b["request_id"], client_address=b["client_address"]))
        if op == "logout":
            await core.logout(c)
            return 204, None
        if op in ("listDevices", "listConversations", "listContacts"):
            method = {"listDevices": core.list_devices, "listConversations": core.list_conversations,
                      "listContacts": core.list_contacts}[op]
            return 200, page_wire(await method(c, b.get("cursor"), b.get("limit", 50)))
        if op == "listIdentities":
            return 200, page_wire(await core.list_identities(c))
        if op == "listChannels":
            return 200, page_wire(await core.list_channels(c))
        if op == "getConversation":
            return 200, await core.get_conversation(c, b["conversation_id"])
        if op == "markConversationRead":
            await core.mark_read(c, b["conversation_id"], b["up_to"])
            return 204, None
        if op == "listMessages":
            return 200, page_wire(await core.list_messages(c, b["conversation_id"], b.get("cursor"),
                                                           b.get("limit", 50)))
        if op == "createSendAttempt":
            res = await core.create_send_attempt(c, b["request"])
            return (201 if res.created else 200), res.attempt
        if op == "getSendAttempt":
            return 200, await core.get_send_attempt(c, b["attempt_id"])
        if op == "readEvents":
            batch: EventBatch = await core.read_events(c, b["cursor"], float(b["wait_s"]))
            return 200, {"events": batch.events, "cursor": batch.cursor}
        if op == "createLease":
            return 200, await core.create_lease(c)
        if op == "listLeaseKeys":
            return 200, await core.list_lease_keys(c)
    except CoreError as e:
        return error_wire(e)
    raise KeyError(op)


def request_schema(op_id: str) -> str | None:
    """The component name of an operation's request body schema, or None when it takes no body."""
    for item in CORE.openapi["paths"].values():
        for op in item.values():
            if op["operationId"] == op_id:
                ref = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
                return ref.get("$ref", "").split("/")[-1] or None
    raise KeyError(op_id)


class StubReaderCore:
    """Every reader-core operation over a fake World, with a service token."""

    def __init__(self, world: World, token: str | None = None):
        self.world = world
        self.core = FakeReaderCore(world)  # its `unavailable` flag is the 503 toggle
        self.token = token or "synthetic-service-token-" + secrets.token_hex(12)
        self.routes = {(o["method"], o["path"]): op_id for op_id, o in CORE.ops.items()}
        self.validators = {op_id: CORE.schema_validator(name) for op_id in CORE.ops
                           if (name := request_schema(op_id)) is not None}
        self.caller_validator = CORE.schema_validator("CallerRef")
        self.served: list[tuple[str, int]] = []
        self.requests: list[dict[str, Any]] = []  # every routed request: operation, parsed body, token accepted

    def _send_envelope_ok(self, body: Any) -> bool:
        """createSendAttempt's body is `{caller, request}` with a valid caller and an object `request`."""
        return (isinstance(body, dict) and set(body) == {"caller", "request"}
                and isinstance(body["request"], dict) and self.caller_validator.is_valid(body["caller"]))

    def _authorized(self, headers: dict[bytes, bytes]) -> bool:
        got = headers.get(b"authorization")
        return got is not None and hmac.compare_digest(got, ("Bearer " + self.token).encode())

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        raw = await read_body(receive)
        op = self.routes.get((scope["method"], scope["path"]))
        if op is None:
            return await respond(send, 404, json.dumps({"code": "not_found", "retryable": False}).encode())
        authorized = self._authorized(dict(scope["headers"]))
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = _NOT_JSON
        self.requests.append({"operation": op, "body": parsed, "auth_ok": authorized})
        if not authorized:
            self.served.append((op, 401))
            return await respond(send, 401, json.dumps(SERVICE_UNAUTHORIZED).encode())
        body = None
        if op in self.validators:
            try:
                body = json.loads(raw)
            except ValueError:
                body = _NOT_JSON
            if body is _NOT_JSON or not self.validators[op].is_valid(body):
                refusal = INVALID if op == "createSendAttempt" and self._send_envelope_ok(body) else MALFORMED
                self.served.append((op, 422))
                return await respond(send, 422, json.dumps(refusal).encode())
        status, wire = await dispatch(self.core, op, body)
        self.served.append((op, status))
        if wire is None:
            await send({"type": "http.response.start", "status": status, "headers": []})
            return await send({"type": "http.response.body", "body": b""})
        await respond(send, status, json.dumps(wire).encode())


_NOT_JSON = object()
