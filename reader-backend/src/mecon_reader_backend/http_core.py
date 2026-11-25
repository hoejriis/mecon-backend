"""A ReaderCore adapter that speaks contracts/reader-core/v1 to a core over HTTP.

One port method is one operation of the contract: a `POST {base}/reader/...` whose JSON body carries the
`caller` reference (`{user_id, session_ref}`) and the arguments, or `GET {base}/reader/health`. Every request
carries the per-deployment service token as a bearer header. The token is read from its file by path, again
whenever the file changes, and is never logged or shown in a repr.

Every answer is checked against the contract's schema for its operation and status before it is used. A refusal
becomes the `CoreError` the fake core raises for the same refusal (kind from the status, the contract's `code`,
`retryable`, and `retry_after_s` on a 429), so the facade maps both the same way. Anything else becomes
`CoreError("unavailable", "core_unavailable")`, which the facade answers 503 `unavailable` and never as a
sign-out: a 503, a 401 `service_unauthorized`, a status the operation does not declare, a redirect (never
followed), a body that is not JSON or breaks the schema, a refusal code the status does not carry, a timeout or a
connection error. A 422 `malformed_request` means this adapter sent a body the contract refuses, a bug here and
never an answer about the caller: it is logged at ERROR once per operation and answered `core_unavailable` too.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import httpx

from .core_schema import valid
from .http_lookup import parse_date_time
from .ports import Caller, CoreError, EventBatch, LoginPoll, Page, SendResult
from .reader_core_schemas import OPERATIONS

log = logging.getLogger("mecon_reader_backend.http_core")

MAX_ANSWER_BYTES = 8 * 1024 * 1024  # a page of 200 items is far below this; a larger answer is malformed
MAX_WAIT_S = 25.0  # EventsRequest.wait_s maximum
MAX_ORIGIN, MAX_SEC_FETCH_SITE = 2048, 32  # LoginStartRequest bounds

# A refusal's status gives the CoreError kind; the contract's code is kept.
STATUS_KIND = {403: "forbidden", 404: "not_found", 409: "conflict", 410: "gone", 422: "invalid", 429: "throttled",
               503: "unavailable"}
# The codes each refusal status carries (the operation's response descriptions); a code a status does not carry
# is a malformed answer. Overrides per operation, else the status's own code.
STATUS_CODES = {403: {"session_ended"}, 404: {"not_found"}, 409: {"conflict"}, 410: {"cursor_expired"},
                422: {"malformed_request"}, 429: {"throttled"}, 503: {"core_unavailable"}}
_PAGED_422 = {"malformed_request", "invalid"}
OPERATION_CODES: dict[tuple[str, int], set[str]] = {
    ("startLogin", 403): {"origin_rejected"},
    ("startLogin", 429): {"rate_limited"},
    ("pollLogin", 429): {"rate_limited"},
    ("listDevices", 422): _PAGED_422,
    ("listConversations", 422): _PAGED_422,
    ("listMessages", 422): _PAGED_422,
    ("listContacts", 422): _PAGED_422,
    ("markConversationRead", 422): {"malformed_request", "validation_failed"},
    ("createSendAttempt", 403): {"session_ended", "sending_disabled"},
    ("createSendAttempt", 422): {"malformed_request", "invalid"},
    ("createLease", 503): {"core_unavailable", "lease_signing_unavailable"},
}


def refusal_codes(op: str, status: int) -> set[str]:
    return OPERATION_CODES.get((op, status), STATUS_CODES.get(status, set()))


class _Malformed(Exception):
    pass


def _unavailable() -> CoreError:
    return CoreError("unavailable", "core_unavailable", "the core cannot answer now")


def caller_ref(c: Caller) -> dict[str, str]:
    return {"user_id": c.user_id, "session_ref": c.session_ref}


class HttpReaderCore:
    """The ReaderCore port over HTTP, as contracts/reader-core/v1 describes it.

    `base_url` is the core on the deployment's private network, including any path prefix in front of `/reader/`.
    `token_file` is the mode-600 service token file. `timeout_s` bounds each call; `read_events` is bounded by its
    `wait_s` plus `events_margin_s`. `client` is for tests; without one the adapter makes its own, which ignores
    proxy settings from the environment.
    """

    def __init__(self, base_url: str, token_file: str | os.PathLike, *, timeout_s: float = 5.0,
                 events_margin_s: float = 5.0, client: httpx.AsyncClient | None = None):
        self.base_url = base_url.rstrip("/")
        self._token_file = os.fspath(token_file)
        self.timeout_s = timeout_s
        self.events_margin_s = events_margin_s
        self._own_client = client is None
        self._client = client or httpx.AsyncClient(follow_redirects=False, trust_env=False)
        self._token_key: tuple | None = None
        self._token_value: str | None = None
        self.token_refused = False  # the core answered 401 service_unauthorized and has not answered since
        self._malformed_logged: set[str] = set()

    def __repr__(self) -> str:
        return f"HttpReaderCore({self.base_url!r}, token_file={self._token_file!r})"

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()

    # ---- the service token ----

    def _token(self) -> str:
        """The token, re-read whenever the file's identity, size or modification time changes."""
        st = os.stat(self._token_file)
        key = (st.st_ino, st.st_size, st.st_mtime_ns)
        if key != self._token_key or self._token_value is None:
            with open(self._token_file, encoding="utf-8") as f:
                value = f.read().strip()
            if not value or any(c.isspace() for c in value):
                raise ValueError("the service token file holds no usable token")
            self._token_key, self._token_value = key, value
        return self._token_value

    def _set_refused(self, refused: bool) -> None:
        if refused and not self.token_refused:
            log.error("the core refuses this facade's service token (401 service_unauthorized): check the token "
                      "file; every core call answers core_unavailable until it is fixed")
        elif not refused and self.token_refused:
            log.error("the core accepts this facade's service token again")
        self.token_refused = refused

    # ---- one call ----

    async def _call(self, op: str, body: dict[str, Any] | None, timeout_s: float | None = None) -> tuple[int, Any]:
        """(status, parsed body) of a 2xx answer that matches the contract; every other answer raises CoreError."""
        timeout_s = self.timeout_s if timeout_s is None else timeout_s
        spec = OPERATIONS[op]
        try:
            headers = {"Accept": "application/json", "Authorization": "Bearer " + self._token()}
            req = self._client.build_request(spec["method"], self.base_url + spec["path"], json=body, headers=headers,
                                             timeout=httpx.Timeout(timeout_s))
            status, raw = await asyncio.wait_for(self._send(req), timeout_s)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a timeout, a refused connection, an unreadable token file
            log.warning("reader core %s failed: %s", op, type(exc).__name__)
            raise _unavailable() from None
        return self._answer(op, status, raw)

    async def _send(self, req: httpx.Request) -> tuple[int, bytes]:
        resp = await self._client.send(req, stream=True, follow_redirects=False)
        try:
            raw = bytearray()
            async for chunk in resp.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > MAX_ANSWER_BYTES:
                    raise _Malformed("answer too large")
            return resp.status_code, bytes(raw)
        finally:
            await resp.aclose()

    def _answer(self, op: str, status: int, raw: bytes) -> tuple[int, Any]:
        responses = OPERATIONS[op]["responses"]
        if status == 401:
            self._set_refused(True)  # our own token was refused: a configuration fault, never the caller's
            raise _unavailable()
        if status not in responses:
            log.warning("reader core %s answered %s, which the operation does not declare", op, status)
            raise _unavailable()
        schema = responses[status]
        if 200 <= status < 300:
            if schema is None:
                self._set_refused(False)
                return status, None
            body = _json(raw)
            if body is _NOT_JSON or not valid(schema, body):
                log.warning("reader core %s answered %s with a body that breaks %s", op, status, schema)
                raise _unavailable()
            self._set_refused(False)
            return status, body
        body = _json(raw)
        if schema is None or body is _NOT_JSON or not valid(schema, body) \
                or body["code"] not in refusal_codes(op, status):
            log.warning("reader core %s answered %s with a refusal the contract does not declare there", op, status)
            raise _unavailable()
        self._set_refused(False)
        code = body["code"]
        if code == "malformed_request":
            # This adapter sent a body the contract refuses: our bug, never an answer about the caller.
            if op not in self._malformed_logged:
                self._malformed_logged.add(op)
                log.error("reader core refused this adapter's %s request as malformed_request: an adapter bug", op)
            raise _unavailable()
        if code == "core_unavailable":
            raise _unavailable()
        if code == "session_ended":
            # The facade's session-ended path: 401 with the cookie cleared, session_revoked on an open stream.
            raise CoreError("forbidden", "session_ended", retryable=False)
        raise CoreError(STATUS_KIND[status], code, retryable=body["retryable"],
                        retry_after_s=body.get("retry_after_s"))

    # ---- the port ----

    async def health(self) -> dict[str, Any]:
        return (await self._call("getHealth", None))[1]

    async def start_login(self, email: str, *, origin: str | None, sec_fetch_site: str | None,
                          client_address: str) -> dict[str, Any]:
        # A header past its schema bound goes as absent: absent is never on the allow-list, never "same-origin".
        body = {"email": email,
                "origin": origin if origin is None or len(origin) <= MAX_ORIGIN else None,
                "sec_fetch_site": sec_fetch_site if sec_fetch_site is None
                or len(sec_fetch_site) <= MAX_SEC_FETCH_SITE else None,
                "client_address": client_address}
        return (await self._call("startLogin", body))[1]

    async def poll_login(self, request_id: str, *, client_address: str) -> LoginPoll:
        _, b = await self._call("pollLogin", {"request_id": request_id, "client_address": client_address})
        return LoginPoll(b["state"], poll_after_ms=b.get("poll_after_ms"), credential=b.get("credential"),
                         expires_at=parse_date_time(b["expires_at"]) if "expires_at" in b else None)

    async def logout(self, caller: Caller) -> None:
        await self._call("logout", {"caller": caller_ref(caller)})

    @staticmethod
    def _paged(caller: Caller, cursor: str | None, limit: int, **extra: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"caller": caller_ref(caller), **extra, "limit": limit}
        if cursor is not None:
            body["cursor"] = cursor
        return body

    @staticmethod
    def _page(b: dict[str, Any]) -> Page:
        return Page(items=b["items"], next_cursor=b["next_cursor"], as_of=parse_date_time(b["as_of"]))

    async def list_devices(self, caller: Caller, cursor: str | None, limit: int) -> Page:
        return self._page((await self._call("listDevices", self._paged(caller, cursor, limit)))[1])

    async def list_identities(self, caller: Caller) -> Page:
        return self._page((await self._call("listIdentities", {"caller": caller_ref(caller)}))[1])

    async def list_conversations(self, caller: Caller, cursor: str | None, limit: int) -> Page:
        return self._page((await self._call("listConversations", self._paged(caller, cursor, limit)))[1])

    async def get_conversation(self, caller: Caller, conversation_id: str) -> dict[str, Any]:
        body = {"caller": caller_ref(caller), "conversation_id": conversation_id}
        return (await self._call("getConversation", body))[1]

    async def mark_read(self, caller: Caller, conversation_id: str, up_to: str) -> None:
        body = {"caller": caller_ref(caller), "conversation_id": conversation_id, "up_to": up_to}
        await self._call("markConversationRead", body)

    async def list_messages(self, caller: Caller, conversation_id: str, cursor: str | None, limit: int) -> Page:
        body = self._paged(caller, cursor, limit, conversation_id=conversation_id)
        return self._page((await self._call("listMessages", body))[1])

    async def list_contacts(self, caller: Caller, cursor: str | None, limit: int) -> Page:
        return self._page((await self._call("listContacts", self._paged(caller, cursor, limit)))[1])

    async def list_channels(self, caller: Caller) -> Page:
        return self._page((await self._call("listChannels", {"caller": caller_ref(caller)}))[1])

    async def create_send_attempt(self, caller: Caller, request: dict[str, Any]) -> SendResult:
        status, b = await self._call("createSendAttempt", {"caller": caller_ref(caller), "request": request})
        return SendResult(attempt=b, created=status == 201)

    async def get_send_attempt(self, caller: Caller, attempt_id: str) -> dict[str, Any]:
        return (await self._call("getSendAttempt", {"caller": caller_ref(caller), "attempt_id": attempt_id}))[1]

    async def read_events(self, caller: Caller, cursor: str | None, wait_s: float) -> EventBatch:
        wait = min(max(float(wait_s), 0.0), MAX_WAIT_S)
        body = {"caller": caller_ref(caller), "cursor": cursor, "wait_s": wait}
        _, b = await self._call("readEvents", body, timeout_s=wait + self.events_margin_s)
        if any(e["kind"] == "session_revoked" for e in b["events"]):
            # The contract: the core never sends it; the facade frames it. One in a batch would sign the user out.
            log.warning("reader core readEvents answered a session_revoked envelope, which the contract forbids")
            raise _unavailable()
        return EventBatch(events=b["events"], cursor=b["cursor"])

    async def create_lease(self, caller: Caller) -> dict[str, Any]:
        return (await self._call("createLease", {"caller": caller_ref(caller)}))[1]

    async def list_lease_keys(self, caller: Caller) -> dict[str, Any]:
        return (await self._call("listLeaseKeys", {"caller": caller_ref(caller)}))[1]


_NOT_JSON = object()


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return _NOT_JSON
