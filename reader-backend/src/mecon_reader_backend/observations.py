"""The authorized observation projection (contracts/observations/v1): three GET operations mounted in the Reader facade.

It shares the facade's session resolution (cookie, cache, revocation feed, fail-closed 503) and error body.
It adds no scope of its own: which observers a caller may see comes from the ObservationScope port and is
handed to the ReceptionStore, which answers only for those observers. The facade never widens or computes it.

Access is read from the resolved session: `capabilities.observations` forbidden is 403 on every operation,
anything but available is 503, and a caller who may observe but sees nothing gets 200 and nothing.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from . import validation as v
from .app import Refusal, error_response
from .ports import Caller, CoreError, Denied, EventBatch, ObservationScope, ReceptionStore
from .sessions import SessionResolver
from .sse import event_stream, frame

log = logging.getLogger("mecon_reader_backend.observations")

PREFIX = "/api/observations/v1/authorized"
NO_STORE = {"Cache-Control": "no-store"}
MAX_CURSOR = 512

# The statuses each operation declares in openapi.yaml (tests/test_observation_guards.py checks it).
DECLARED: dict[str, frozenset[int]] = {
    "listObservers": frozenset({200, 401, 403, 410, 429, 503}),
    "getObservationSnapshot": frozenset({200, 401, 403, 410, 429, 503}),
    "streamObservationEvents": frozenset({200, 401, 403, 410, 429, 503}),
}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def control_frame(kind: str) -> bytes:
    """A control event. Its event_id is not a resume point: it is never a cursor, so resuming from it is a 410."""
    env = {"event_id": "ctl_" + secrets.token_hex(8), "kind": kind, "occurred_at": _now(), "version": 1}
    return frame(env)


def access_revoked_frame(_cursor: str) -> bytes:
    return control_frame("access_revoked")


def resync_required_frame(_cursor: str) -> bytes:
    return control_frame("resync_required")


def require_access(caller: Caller) -> None:
    state = caller.capabilities.get("observations")
    if state == "forbidden":
        raise Refusal(403, "forbidden", "observations are not granted to this session")
    if state != "available":
        raise Refusal(503, "unavailable", "observations are unavailable", retryable=True)


def scope_param(request: Request) -> None:
    if request.query_params.get("scope") != "self":
        raise v.Invalid("query.scope")


def limit_param(raw: str | None) -> int:
    if raw is None:
        return 100
    if not (raw.isascii() and raw.isdigit()) or not 1 <= int(raw) <= 500:
        raise v.Invalid("query.limit")
    return int(raw)


def cursor_param(raw: str | None) -> str | None:
    """No cursor is None (an empty value counts as none). One longer than the schema allows cannot have been
    issued, so it is a gone cursor (410), not a validation error: the operations declare no 422."""
    if raw is None or raw == "":
        return None
    if len(raw) > MAX_CURSOR:
        raise Refusal(410, "cursor_expired", "cursor expired; reload the snapshot")
    return raw


def observation_routes(authenticate: Callable[[Request, str], Awaitable[Caller]], sessions: SessionResolver,
                       scope: ObservationScope, store: ReceptionStore, *, heartbeat_s: float, poll_s: float,
                       core_timeout_s: float, feed_down_close_s: float,
                       cookie_name: str = "__Host-mecon_session") -> list[Route]:
    async def guard(aw: Awaitable[Any]) -> Any:
        try:
            return await asyncio.wait_for(aw, core_timeout_s)
        except CoreError as e:
            if e.kind == "gone":
                raise Refusal(410, "cursor_expired", "cursor expired; reload the snapshot") from None
            if e.kind == "forbidden":
                raise Refusal(403, "forbidden", "observations are not granted to this session") from None
            if e.kind == "throttled":
                headers = {"Retry-After": str(e.retry_after_s)} if e.retry_after_s else None
                raise Refusal(429, "throttled", "too many requests", retryable=True, headers=headers) from None
            raise Refusal(503, "unavailable", "observations are unavailable", retryable=True) from None
        except Exception as exc:  # noqa: BLE001 - a lookup or store failure never becomes an answer
            log.warning("observation lookup failed: %s", type(exc).__name__)
            raise Refusal(503, "unavailable", "observations are unavailable", retryable=True) from None

    def endpoint(op: str, fn: Callable[[Request], Awaitable[Response]]):
        async def handler(request: Request) -> Response:
            rid = "req_" + secrets.token_hex(8)
            try:
                return await fn(request)
            except Refusal as r:
                return error_response(rid, r)
            except v.Invalid as e:
                # The operations declare no 422 or 400; a malformed scope or limit is refused with the Reader
                # API's validation code rather than guessed at.
                return error_response(rid, Refusal(422, "invalid", f"request failed validation at {e.where}"))
            except Exception:  # noqa: BLE001
                log.exception("unhandled error in %s", op)
                return error_response(rid, Refusal(503, "unavailable", "internal error", retryable=True))
        handler.__name__ = op
        return handler

    def ok(body: Any) -> Response:
        return JSONResponse(body, headers=NO_STORE)

    async def list_observers(request: Request) -> Response:
        caller = await authenticate(request, "read")
        require_access(caller)
        scope_param(request)
        cursor = cursor_param(request.query_params.get("cursor"))
        limit = limit_param(request.query_params.get("limit"))
        visible = await guard(scope.visible_observers(caller))
        page = await guard(store.observers(caller, visible, cursor, limit))
        return ok({"items": page.items, "next_cursor": page.next_cursor, "as_of": _now()})

    async def get_snapshot(request: Request) -> Response:
        caller = await authenticate(request, "read")
        require_access(caller)
        scope_param(request)
        since = cursor_param(request.query_params.get("since"))
        limit = limit_param(request.query_params.get("limit"))
        visible = await guard(scope.visible_observers(caller))
        snap = await guard(store.snapshot(caller, visible, since, limit))
        return ok({"items": snap.items, "cursor": snap.cursor, "as_of": _now(), "expires_at": iso(snap.expires_at)})

    async def stream_events(request: Request) -> Response:
        caller = await authenticate(request, "stream")
        require_access(caller)
        scope_param(request)
        header = cursor_param(request.headers.get("last-event-id"))
        cursor = header if header is not None else cursor_param(request.query_params.get("cursor"))
        visible = await guard(scope.visible_observers(caller))
        first: EventBatch = await guard(store.events_after(caller, visible, cursor, 0.0))

        credential = request.cookies.get(cookie_name)

        async def read(c: Caller, cur: str | None, wait_s: float) -> EventBatch:
            # The session and the scope are asked again on every read, so rights withdrawn mid-stream end it with
            # access_revoked, and a rule that narrows the scope stops what is sent. The session read goes through
            # the resolver (purpose read: its short cache), never a stored Caller.
            now = await sessions.resolve(credential, "read") if credential else Denied("unknown")
            if isinstance(now, Denied):
                if now.reason in ("revoked", "expired"):
                    # The session ended, seen here before the revocation feed's event: said once, as a revocation.
                    raise CoreError("forbidden")
                # A lookup that cannot answer (or an unknown session) closes the stream with nothing said; the
                # reconnect answers 503 or 401.
                raise CoreError("unavailable")
            state = now.capabilities.get("observations")
            if state == "forbidden":
                raise CoreError("forbidden")
            if state != "available":
                raise CoreError("unavailable")
            try:
                now_visible = await asyncio.wait_for(scope.visible_observers(now), core_timeout_s)
                return await asyncio.wait_for(store.events_after(now, now_visible, cur, wait_s), core_timeout_s + wait_s)
            except CoreError as e:
                if e.kind == "forbidden":
                    raise CoreError("forbidden") from None  # the core withdrew the caller's rights: access_revoked
                raise CoreError("gone") if e.kind == "gone" else CoreError("unavailable") from None
            except Exception:  # noqa: BLE001
                raise CoreError("unavailable") from None

        gen = event_stream(None, sessions, caller, first, heartbeat_s=heartbeat_s, feed_down_close_s=feed_down_close_s,
                           tick_s=poll_s, read=read, revoked_frame_for=access_revoked_frame,
                           gone_frame_for=resync_required_frame, forbidden_frame_for=access_revoked_frame)
        return StreamingResponse(gen, media_type="text/event-stream", headers=NO_STORE | {"X-Accel-Buffering": "no"})

    table = [
        ("/observers", "listObservers", list_observers),
        ("/snapshot", "getObservationSnapshot", get_snapshot),
        ("/events", "streamObservationEvents", stream_events),
    ]
    return [Route(PREFIX + path, endpoint(op, fn), methods=["GET"], name=op) for path, op, fn in table]
