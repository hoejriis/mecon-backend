"""A SessionLookup adapter that speaks contracts/session-lookup/v1 to a core over HTTP.

`POST {core}/lookup` resolves a session cookie; `GET {core}/revocations` is the revocation feed (SSE). Both
carry the per-deployment service token as a bearer header. The token is read from its file by path, again
whenever the file changes, and is never logged or shown in a repr.

Every answer that is not a valid `Caller` (200) or a valid session or write `Denied` (403) becomes
`Denied("core_unavailable")`: a 503, a 401 `service_unauthorized`, any other status, a redirect, a timeout,
a connection error, a body that is not JSON or that breaks the schema. A core that cannot answer never
signs anyone out. Redirects are never followed.

The answer is checked by hand against the contract's `Caller` and `Denied` schemas (no extra members, every
required one present), so the running facade needs no schema engine; `tests/test_http_lookup.py` checks
the hand-written checks against the document with a real JSON Schema validator.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime
from typing import Any, AsyncIterator, Union

import httpx

from .ports import CAPABILITY_NAMES, CAPABILITY_STATES, Caller, Denied, Revocation, Subscribed

log = logging.getLogger("mecon_reader_backend.http_lookup")

# The reasons a 403 may carry (the contract's Denied schema). core_unavailable is a 503, never a 403.
DENIED_403 = ("expired", "revoked", "unknown", "csrf_failed", "origin_rejected")
CALLER_REQUIRED = frozenset(("user_id", "session_ref", "role", "break_glass", "display_name", "capabilities",
                             "expires_at"))
CALLER_FIELDS = CALLER_REQUIRED | {"csrf_token"}
ROLES = ("instance_admin", "user")
# RFC 3339 date-time, as the schema's `format: date-time` means it: a full date, a time and an offset.
_DATE_TIME = re.compile(r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})")

# Request bounds from LookupRequest. A value past its bound is never sent; see _lookup_body.
MAX_CREDENTIAL, MAX_ORIGIN, MAX_SEC_FETCH_SITE, MAX_CSRF = 4096, 2048, 32, 512
MAX_ANSWER_BYTES = 64 * 1024  # a lookup answer is a few hundred bytes; a larger one is malformed
MAX_FEED_LINE = 64 * 1024  # one SSE line; a longer one ends the feed

_UNAVAILABLE = Denied("core_unavailable")


class _Malformed(Exception):
    pass


def _is_str(v: Any, min_len: int = 0) -> bool:
    return type(v) is str and len(v) >= min_len


def parse_date_time(v: Any) -> datetime | None:
    if not _is_str(v) or not _DATE_TIME.fullmatch(v):
        return None
    try:
        dt = datetime.fromisoformat(v.upper().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else None


def parse_caller(obj: Any) -> Caller | None:
    """The contract's Caller schema, by hand: exactly the documented members, each of its type. None if not."""
    if not isinstance(obj, dict):
        return None
    if set(obj) - CALLER_FIELDS:
        return None
    if not CALLER_REQUIRED <= set(obj):
        return None
    caps = obj["capabilities"]
    if not isinstance(caps, dict) or set(caps) != set(CAPABILITY_NAMES):
        return None
    if not all(_is_str(s) and s in CAPABILITY_STATES for s in caps.values()):
        return None
    if not (_is_str(obj["user_id"], 1) and _is_str(obj["session_ref"], 1) and _is_str(obj["display_name"])
            and _is_str(obj["role"]) and obj["role"] in ROLES and type(obj["break_glass"]) is bool):
        return None
    if "csrf_token" in obj and not _is_str(obj["csrf_token"], 1):
        return None
    expires_at = parse_date_time(obj["expires_at"])
    if expires_at is None:
        return None
    return Caller(session_ref=obj["session_ref"], user_id=obj["user_id"], display_name=obj["display_name"],
                  role=obj["role"], break_glass=obj["break_glass"], capabilities=dict(caps),
                  expires_at=expires_at, csrf_token=obj.get("csrf_token"))


def parse_denied(obj: Any) -> Denied | None:
    """The contract's Denied schema (a 403 body): one of the five reasons, retryable false, nothing else."""
    if not isinstance(obj, dict) or set(obj) != {"reason", "retryable"}:
        return None
    if obj["retryable"] is not False:
        return None
    if not _is_str(obj["reason"]) or obj["reason"] not in DENIED_403:
        return None
    return Denied(obj["reason"])


def parse_revocation_item(obj: Any) -> Union[Subscribed, Revocation, None]:
    """One feed item. None: a type this version does not know, ignored. A malformed known item raises."""
    if not isinstance(obj, dict) or not _is_str(obj.get("type")):
        raise _Malformed("feed item")
    if obj["type"] == "subscribed":
        return Subscribed()
    if obj["type"] == "revocation":
        ref, reason = obj.get("session_ref"), obj.get("reason")
        if not _is_str(ref, 1) or not _is_str(reason):
            raise _Malformed("revocation item")
        # A reason outside expired/revoked still ends that session here: dropping a cached caller is the safe side.
        return Revocation(ref, reason)
    return None


class HttpSessionLookup:
    """The SessionLookup port over HTTP, as contracts/session-lookup/v1 describes it.

    `base_url` is the core on the deployment's private network (plain HTTP there, never through the public
    proxy). `token_file` is the mode-600 service token file. `timeout_s` bounds a whole lookup;
    `feed_silence_s` is how long the revocation feed may send no bytes (heartbeats included) before it
    counts as down. `client` is for tests; without one the adapter makes its own, which ignores proxy
    settings from the environment.
    """

    def __init__(self, base_url: str, token_file: str | os.PathLike, *, timeout_s: float,
                 feed_silence_s: float = 50.0, client: httpx.AsyncClient | None = None):
        self.base_url = base_url.rstrip("/")
        self._token_file = os.fspath(token_file)
        self.timeout_s = timeout_s
        self.feed_silence_s = feed_silence_s
        self._timeout = httpx.Timeout(timeout_s)
        self._feed_timeout = httpx.Timeout(timeout_s, read=None)  # the feed's silence bound is ours, below
        self._own_client = client is None
        self._client = client or httpx.AsyncClient(timeout=self._timeout, follow_redirects=False, trust_env=False)
        self._token_key: tuple | None = None
        self._token_value: str | None = None

    def __repr__(self) -> str:
        return f"HttpSessionLookup({self.base_url!r}, token_file={self._token_file!r})"

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

    def _headers(self, accept: str) -> dict[str, str]:
        return {"Accept": accept, "Authorization": "Bearer " + self._token()}

    # ---- lookup ----

    @staticmethod
    def _lookup_body(credential: str, purpose: str, csrf_token: str | None, origin: str | None,
                     sec_fetch_site: str | None) -> dict[str, Any]:
        # A value past its schema bound is never sent. An over-long Origin or Sec-Fetch-Site is sent as absent:
        # no allow-listed origin is that long and absent is never "same-origin", so this never accepts what the
        # core would refuse. An over-long CSRF token is left out, which the core answers with csrf_failed.
        body: dict[str, Any] = {
            "credential": credential, "purpose": purpose,
            "origin": origin if origin is None or len(origin) <= MAX_ORIGIN else None,
            "sec_fetch_site": sec_fetch_site if sec_fetch_site is None or len(sec_fetch_site) <= MAX_SEC_FETCH_SITE
            else None,
        }
        if purpose == "write" and csrf_token and len(csrf_token) <= MAX_CSRF:
            body["csrf_token"] = csrf_token
        return body

    async def resolve(self, credential: str, purpose: str, *, csrf_token: str | None = None,
                      origin: str | None = None, sec_fetch_site: str | None = None) -> Union[Caller, Denied]:
        if not credential or len(credential) > MAX_CREDENTIAL:
            return Denied("unknown")  # no session cookie has that form: nothing to ask the core
        try:
            body = self._lookup_body(credential, purpose, csrf_token, origin, sec_fetch_site)
            status, raw = await asyncio.wait_for(self._post_lookup(body), self.timeout_s)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a timeout, a refused connection, an unreadable token file
            log.warning("session lookup failed: %s", type(exc).__name__)
            return _UNAVAILABLE
        if status == 200:
            caller = parse_caller(_json(raw))
            if caller is None:
                log.warning("session lookup answered 200 with a body that is not a valid Caller")
                return _UNAVAILABLE
            return caller
        if status == 403:
            denied = parse_denied(_json(raw))
            if denied is None:
                log.warning("session lookup answered 403 with a body that is not a valid Denied")
                return _UNAVAILABLE
            return denied
        log.warning("session lookup answered %s", status)  # 503, 401 service_unauthorized, a redirect, anything else
        return _UNAVAILABLE

    async def _post_lookup(self, body: dict[str, Any]) -> tuple[int, bytes]:
        req = self._client.build_request("POST", self.base_url + "/lookup", json=body,
                                         headers=self._headers("application/json"), timeout=self._timeout)
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

    # ---- revocations ----

    async def revocations(self) -> AsyncIterator[Union[Subscribed, Revocation]]:
        """The feed. It ends (the facade then counts it down) on silence past `feed_silence_s`, on a refused
        token, on any status but 200, on a malformed item, and on any transport error."""
        try:
            req = self._client.build_request("GET", self.base_url + "/revocations",
                                             headers=self._headers("text/event-stream"), timeout=self._feed_timeout)
            resp = await asyncio.wait_for(self._client.send(req, stream=True, follow_redirects=False),
                                          self.timeout_s)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("revocation feed could not connect: %s", type(exc).__name__)
            return
        try:
            if resp.status_code != 200:
                log.warning("revocation feed answered %s", resp.status_code)
                return
            if not resp.headers.get("content-type", "").startswith("text/event-stream"):
                log.warning("revocation feed is not an event stream")
                return
            async for item in self._items(resp):
                yield item
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("revocation feed failed: %s", type(exc).__name__)
        finally:
            await resp.aclose()

    async def _items(self, resp: httpx.Response) -> AsyncIterator[Union[Subscribed, Revocation]]:
        chunks = resp.aiter_bytes()
        buf = b""
        data: list[str] = []
        while True:
            try:
                chunk = await asyncio.wait_for(chunks.__anext__(), self.feed_silence_s)
            except StopAsyncIteration:
                log.warning("revocation feed ended by the core")
                return
            except asyncio.TimeoutError:
                log.warning("revocation feed silent for %ss: down", self.feed_silence_s)
                return
            buf += chunk
            while True:
                nl = buf.find(b"\n")
                if nl < 0:
                    break
                line, buf = buf[:nl].rstrip(b"\r").decode("utf-8"), buf[nl + 1:]
                if line == "":
                    if data:
                        item = parse_revocation_item(_json("\n".join(data).encode(), strict=True))
                        data = []
                        if item is not None:
                            yield item
                elif line.startswith(":"):
                    continue  # a comment: the heartbeat
                elif line.startswith("data:"):
                    data.append(line[5:].removeprefix(" "))
                # event:, id: and retry: lines carry nothing this feed uses
            if len(buf) > MAX_FEED_LINE:
                raise _Malformed("feed line too long")


def _json(raw: bytes, *, strict: bool = False) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        if strict:
            raise _Malformed("not JSON") from None
        return None
