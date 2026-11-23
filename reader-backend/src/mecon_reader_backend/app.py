"""The Reader API facade: a Starlette app over the SessionLookup and ReaderCore ports."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from . import validation as v
from .ports import Caller, CoreError, Denied, Page, ReaderCore, SessionLookup
from .sessions import SessionResolver
from .sse import event_stream

log = logging.getLogger("mecon_reader_backend")

PREFIX = "/api/reader/v1"
COOKIE = "__Host-mecon_session"
CONTRACT_VERSION = "1.0"

KIND_STATUS = {"not_found": 404, "forbidden": 403, "conflict": 409, "unavailable": 503, "invalid": 422,
               "gone": 410, "throttled": 429}

# The statuses each operation declares in openapi.yaml (tests/test_guards.py checks this table
# against the document). A core answer whose status an operation does not declare is not passed on.
DECLARED: dict[str, frozenset[int]] = {
    "getHealth": frozenset({200}),
    "startLogin": frozenset({202, 403, 422}),
    "pollLogin": frozenset({200}),
    "getSession": frozenset({200, 401}),
    "logout": frozenset({204, 401, 403}),
    "listDevices": frozenset({200, 401}),
    "listIdentities": frozenset({200, 401}),
    "listConversations": frozenset({200, 401}),
    "getConversation": frozenset({200, 401, 404}),
    "markConversationRead": frozenset({204, 401, 403, 404, 422}),
    "listMessages": frozenset({200, 401, 404}),
    "listContacts": frozenset({200, 401}),
    "listChannels": frozenset({200, 401}),
    "createSendAttempt": frozenset({200, 201, 401, 403, 409, 422, 429, 503}),
    "getSendAttempt": frozenset({200, 401, 404}),
    "streamEvents": frozenset({200, 401, 410}),
    "createLease": frozenset({200, 401, 403, 404, 422, 429, 503}),
    "listLeaseKeys": frozenset({200, 401, 404}),
}


@dataclass
class FacadeConfig:
    reader_origins: tuple[str, ...] = ("https://reader.example.test",)  # login Origin allow-list (the core's list)
    login_origin_precheck: bool = True  # the core checks the login Origin on its own either way
    contract_version: str = CONTRACT_VERSION
    heartbeat_s: float = 25.0
    lookup_cache_s: float = 5.0
    lookup_cache_max: int = 10_000
    lookup_timeout_s: float = 2.0
    core_timeout_s: float = 10.0
    feed_down_close_s: float = 30.0  # open streams close once the revocation feed is down this long
    feed_retry_s: float = 1.0
    cookie_secure: bool = True  # never off outside a local test
    extra: dict[str, Any] = field(default_factory=dict)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Refusal(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False,
                 clear_cookie: bool = False, headers: dict[str, str] | None = None):
        self.status, self.code, self.message, self.retryable = status, code, message, retryable
        self.clear_cookie, self.headers = clear_cookie, headers or {}


def _base_headers() -> dict[str, str]:
    # Every answer is private or per-request: none may be stored by a cache.
    return {"Cache-Control": "no-store"}


def error_response(request_id: str, r: Refusal) -> Response:
    body = {"code": r.code, "message": r.message, "request_id": request_id, "retryable": r.retryable}
    headers = _base_headers() | r.headers
    resp = JSONResponse(body, status_code=r.status, headers=headers)
    if r.clear_cookie:
        _clear_cookie(resp)
    return resp


def _set_cookie(resp: Response, credential: str, expires_at: datetime | None, secure: bool) -> None:
    max_age = None
    if expires_at is not None:
        max_age = max(0, int((expires_at - datetime.now(timezone.utc)).total_seconds()))
    # Host-only: no Domain attribute. __Host- requires Secure and Path=/.
    resp.set_cookie(COOKIE, credential, max_age=max_age, path="/", secure=secure, httponly=True, samesite="strict")


def _clear_cookie(resp: Response) -> None:
    resp.set_cookie(COOKIE, "", max_age=0, expires=0, path="/", secure=True, httponly=True, samesite="strict")


def login_origin_allowed(origin: str | None, sec_fetch_site: str | None, allow: tuple[str, ...]) -> bool:
    """The core's login Origin rule, mirrored so the pre-check never refuses what the core accepts:
    the Origin (any trailing "/" stripped) is on the allow-list, OR Sec-Fetch-Site is "same-origin"."""
    return (origin is not None and origin.rstrip("/") in allow) or sec_fetch_site == "same-origin"


def _page(p: Page) -> dict[str, Any]:
    return {"items": p.items, "next_cursor": p.next_cursor, "as_of": iso(p.as_of)}


def create_app(lookup: SessionLookup, core: ReaderCore, config: FacadeConfig | None = None) -> Starlette:
    cfg = config or FacadeConfig()
    sessions = SessionResolver(lookup, cache_s=cfg.lookup_cache_s, cache_max=cfg.lookup_cache_max, timeout_s=cfg.lookup_timeout_s,
                               feed_retry_s=cfg.feed_retry_s)

    def refuse_denial(d: Denied) -> Refusal:
        if d.reason in ("expired", "revoked", "unknown"):
            return Refusal(401, "unauthenticated", "no valid session", clear_cookie=True)
        if d.reason == "csrf_failed":
            return Refusal(403, "csrf_failed", "missing or wrong CSRF token")
        if d.reason == "origin_rejected":
            return Refusal(403, "origin_rejected", "origin not allowed")
        # core_unavailable, and anything unexpected: never serve on a lookup error.
        return Refusal(503, "unavailable", "session lookup unavailable", retryable=True)

    async def authenticate(request: Request, purpose: str) -> Caller:
        credential = request.cookies.get(COOKIE)
        if not credential:
            raise Refusal(401, "unauthenticated", "no session")
        if purpose == "write":
            answer = await sessions.resolve(credential, "write",
                                            csrf_token=request.headers.get("x-csrf-token"),
                                            origin=request.headers.get("origin"))
        else:
            answer = await sessions.resolve(credential, purpose)
        if isinstance(answer, Denied):
            raise refuse_denial(answer)
        return answer

    async def json_body(request: Request) -> Any:
        raw = await request.body()
        try:
            return json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise v.Invalid("body") from None

    async def call_core(op: str, fn: Awaitable[Any]) -> Any:
        try:
            return await asyncio.wait_for(fn, cfg.core_timeout_s)
        except CoreError as e:
            status = KIND_STATUS[e.kind]
            if status not in DECLARED[op]:
                if e.kind in ("forbidden", "not_found") and 404 in DECLARED[op]:
                    status, code = 404, "not_found"  # never an existence oracle
                    raise Refusal(404, code, "not found") from None
                log.warning("core answered %s for %s, which does not declare it", e.kind, op)
                raise Refusal(503, "unavailable", "temporarily unavailable", retryable=True) from None
            headers = {"Retry-After": str(e.retry_after_s)} if e.kind == "throttled" and e.retry_after_s else None
            raise Refusal(status, e.code, e.message, e.retryable, headers=headers) from None
        except (asyncio.TimeoutError, ConnectionError, OSError):
            raise Refusal(503, "unavailable", "core unavailable", retryable=True) from None

    def endpoint(op: str, fn: Callable[[Request], Awaitable[Response]]):
        async def handler(request: Request) -> Response:
            rid = "req_" + secrets.token_hex(8)
            request.state.request_id = rid
            try:
                resp = await fn(request)
            except Refusal as r:
                return error_response(rid, r)
            except v.Invalid as e:
                return error_response(rid, Refusal(422, "invalid", f"request failed validation at {e.where}"))
            except Exception:  # noqa: BLE001
                log.exception("unhandled error in %s", op)
                return error_response(rid, Refusal(503, "unavailable", "internal error", retryable=True))
            for k, val in _base_headers().items():
                resp.headers.setdefault(k, val)
            return resp
        handler.__name__ = op
        return handler

    def ok(body: Any, status: int = 200) -> Response:
        return JSONResponse(body, status_code=status)

    # ---- session ----

    async def get_health(request: Request) -> Response:
        try:
            h = await asyncio.wait_for(core.health(), cfg.core_timeout_s)
            body = {"status": h.get("status", "degraded"), "commit": h.get("commit")}
            if body["status"] not in ("ok", "degraded"):
                body["status"] = "degraded"
        except Exception:  # noqa: BLE001 - the facade is up; the core is not
            body = {"status": "degraded", "commit": None}
        return ok(body)

    async def start_login(request: Request) -> Response:
        # Pre-session, so no lookup: the core checks the Origin against its own allow-list. The facade's
        # pre-check only refuses early, before the core is reached.
        if cfg.login_origin_precheck and not login_origin_allowed(
                request.headers.get("origin"), request.headers.get("sec-fetch-site"), cfg.reader_origins):
            raise Refusal(403, "origin_rejected", "origin not allowed")
        body = v.login_request(await json_body(request))
        started = await call_core("startLogin", core.start_login(
            body["email"], origin=request.headers.get("origin"), sec_fetch_site=request.headers.get("sec-fetch-site")))
        return ok(started, 202)

    async def poll_login(request: Request) -> Response:
        rid = request.path_params["request_id"]
        if not v.login_request_id(rid):
            return ok({"state": "expired"})  # malformed ids read expired at once
        poll = await call_core("pollLogin", core.poll_login(rid))
        body: dict[str, Any] = {"state": poll.state}
        if poll.poll_after_ms is not None:
            body["poll_after_ms"] = poll.poll_after_ms
        resp = ok(body)
        if poll.state == "approved":
            if not poll.credential:
                raise Refusal(503, "unavailable", "login could not complete", retryable=True)
            _set_cookie(resp, poll.credential, poll.expires_at, cfg.cookie_secure)
        return resp

    async def get_session(request: Request) -> Response:
        c = await authenticate(request, "read")
        return ok({"user": {"id": c.user_id, "display_name": c.display_name},
                   "capabilities": dict(c.capabilities), "contract_version": cfg.contract_version,
                   "csrf_token": c.csrf_token, "expires_at": iso(c.expires_at)})

    async def logout(request: Request) -> Response:
        c = await authenticate(request, "write")
        await call_core("logout", core.logout(c))
        sessions.revoke_local(c.session_ref)
        resp = Response(status_code=204)
        _clear_cookie(resp)
        return resp

    # ---- reads ----

    def paged(op: str, method: str):
        async def h(request: Request) -> Response:
            c = await authenticate(request, "read")
            cursor = v.cursor_param(request.query_params.get("cursor"))
            limit = v.limit_param(request.query_params.get("limit"))
            return ok(_page(await call_core(op, getattr(core, method)(c, cursor, limit))))
        return h

    def whole(op: str, method: str):
        async def h(request: Request) -> Response:
            c = await authenticate(request, "read")
            return ok(_page(await call_core(op, getattr(core, method)(c))))
        return h

    async def get_conversation(request: Request) -> Response:
        c = await authenticate(request, "read")
        cid = v.opaque_id(request.path_params["conversation_id"], "path.conversation_id")
        return ok(await call_core("getConversation", core.get_conversation(c, cid)))

    async def list_messages(request: Request) -> Response:
        c = await authenticate(request, "read")
        cid = v.opaque_id(request.path_params["conversation_id"], "path.conversation_id")
        cursor = v.cursor_param(request.query_params.get("cursor"))
        limit = v.limit_param(request.query_params.get("limit"))
        return ok(_page(await call_core("listMessages", core.list_messages(c, cid, cursor, limit))))

    async def mark_read(request: Request) -> Response:
        c = await authenticate(request, "write")
        cid = v.opaque_id(request.path_params["conversation_id"], "path.conversation_id")
        body = v.read_request(await json_body(request))
        await call_core("markConversationRead", core.mark_read(c, cid, body["up_to"]))
        return Response(status_code=204)

    # ---- sends ----

    async def create_send(request: Request) -> Response:
        c = await authenticate(request, "write")
        body = v.send_request(await json_body(request))
        key = request.headers.get("idempotency-key")
        if key is None:
            raise v.Invalid("header.Idempotency-Key")
        v.opaque_id(key, "header.Idempotency-Key")
        if key != body["client_attempt_id"]:
            raise v.Invalid("header.Idempotency-Key (must equal client_attempt_id)")
        res = await call_core("createSendAttempt", core.create_send_attempt(c, body))
        return ok(res.attempt, 201 if res.created else 200)

    async def get_send(request: Request) -> Response:
        c = await authenticate(request, "read")
        aid = v.opaque_id(request.path_params["attempt_id"], "path.attempt_id")
        return ok(await call_core("getSendAttempt", core.get_send_attempt(c, aid)))

    # ---- events ----

    async def stream_events(request: Request) -> Response:
        c = await authenticate(request, "stream")
        header = request.headers.get("last-event-id")
        cursor = header if header is not None else request.query_params.get("cursor")
        v.cursor_param(cursor)
        first = await call_core("streamEvents", core.read_events(c, cursor, 0.0))
        gen = event_stream(core, sessions, c, first, heartbeat_s=cfg.heartbeat_s,
                           feed_down_close_s=cfg.feed_down_close_s)
        return StreamingResponse(gen, media_type="text/event-stream",
                                 headers=_base_headers() | {"X-Accel-Buffering": "no"})

    # ---- leases ----

    async def create_lease(request: Request) -> Response:
        c = await authenticate(request, "write")
        if await request.body():
            raise Refusal(422, "invalid", "a lease request has no body")
        return ok(await call_core("createLease", core.create_lease(c)))

    async def list_lease_keys(request: Request) -> Response:
        c = await authenticate(request, "read")
        return ok(await call_core("listLeaseKeys", core.list_lease_keys(c)))

    table = [
        ("/health", "GET", "getHealth", get_health),
        ("/login", "POST", "startLogin", start_login),
        ("/login/{request_id}", "GET", "pollLogin", poll_login),
        ("/session", "GET", "getSession", get_session),
        ("/logout", "POST", "logout", logout),
        ("/devices", "GET", "listDevices", paged("listDevices", "list_devices")),
        ("/identities", "GET", "listIdentities", whole("listIdentities", "list_identities")),
        ("/conversations", "GET", "listConversations", paged("listConversations", "list_conversations")),
        ("/conversations/{conversation_id}", "GET", "getConversation", get_conversation),
        ("/conversations/{conversation_id}/read", "POST", "markConversationRead", mark_read),
        ("/conversations/{conversation_id}/messages", "GET", "listMessages", list_messages),
        ("/contacts", "GET", "listContacts", paged("listContacts", "list_contacts")),
        ("/channels", "GET", "listChannels", whole("listChannels", "list_channels")),
        ("/send-attempts", "POST", "createSendAttempt", create_send),
        ("/send-attempts/{attempt_id}", "GET", "getSendAttempt", get_send),
        ("/events", "GET", "streamEvents", stream_events),
        ("/leases", "POST", "createLease", create_lease),
        ("/leases/keys", "GET", "listLeaseKeys", list_lease_keys),
    ]
    routes = [Route(PREFIX + path, endpoint(op, fn), methods=[method], name=op) for path, method, op, fn in table]

    async def not_found(request: Request, exc: Exception) -> Response:
        status = getattr(exc, "status_code", 404)
        code = "not_found" if status == 404 else "invalid"
        return error_response("req_" + secrets.token_hex(8), Refusal(status, code, "no such operation"))

    app = Starlette(routes=routes, exception_handlers={404: not_found, 405: not_found})
    app.state.sessions = sessions
    app.state.config = cfg
    app.state.operations = {op: (method, PREFIX + path) for path, method, op, _ in table}
    return app
