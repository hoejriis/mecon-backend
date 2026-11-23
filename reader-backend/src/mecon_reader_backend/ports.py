"""The two ports the facade calls: session lookup and the Reader core.

The facade owns HTTP: cookies, Origin and CSRF plumbing, request validation, status mapping,
error bodies, caching headers and the event stream framing. Everything about who a caller is and
what that caller may see belongs behind these ports. Every core call carries the resolved
`Caller`; the core decides what that caller sees.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator, Literal, Mapping, Protocol, Union, runtime_checkable

Purpose = Literal["read", "write", "stream"]
CapabilityState = Literal["available", "unavailable", "forbidden"]
CAPABILITY_NAMES = ("devices", "messaging", "send", "events", "observations")
CAPABILITY_STATES = ("available", "unavailable", "forbidden")
Role = Literal["instance_admin", "user"]

# Denial reasons. The first three mean "no valid session" (401, cookie cleared); core_unavailable
# means the lookup could not answer (503, retryable, cookie kept); the last two are write checks
# the lookup makes for the facade (403).
DENIAL_REASONS = ("expired", "revoked", "unknown", "core_unavailable", "csrf_failed", "origin_rejected")


@dataclass(frozen=True)
class Caller:
    """A resolved session. Scope is not here: it stays in the core, which every call reaches with this."""

    session_ref: str  # the core's stored session reference (a hash), never the cookie value; revocations name it
    user_id: str  # opaque
    display_name: str
    role: Role
    break_glass: bool
    capabilities: Mapping[str, str]
    expires_at: datetime  # timezone-aware
    csrf_token: str  # derived by the lookup; returned by GET /session only


@dataclass(frozen=True)
class Denied:
    reason: str  # one of DENIAL_REASONS


@dataclass(frozen=True)
class Revocation:
    session_ref: str
    reason: str = "revoked"


@dataclass(frozen=True)
class Subscribed:
    """The first item of a revocation feed: the core has confirmed the subscription."""


@runtime_checkable
class SessionLookup(Protocol):
    async def resolve(self, credential: str, purpose: Purpose, *, csrf_token: str | None = None,
                      origin: str | None = None) -> Union[Caller, Denied]:
        """Resolve the raw session cookie value.

        For purpose="write" the facade passes the request's X-CSRF-Token and Origin values (None when
        absent) and the lookup checks both, answering Denied("csrf_failed") or Denied("origin_rejected").
        """
        ...

    def revocations(self) -> AsyncIterator[Union[Subscribed, Revocation]]:
        """The revocation feed.

        It first yields one `Subscribed` once the core has confirmed the subscription, then one
        `Revocation` per revoked session, as they happen. A user-wide revocation (a disabled user, a
        removed grant) arrives as one `Revocation` per `session_ref` of that user. Ending or raising
        means the feed is down; until the next `Subscribed` the facade caches nothing.
        """
        ...


# ---- core ----

CoreErrorKind = Literal["not_found", "forbidden", "conflict", "unavailable", "invalid", "gone", "throttled"]
DEFAULT_CODES = {"not_found": "not_found", "forbidden": "forbidden", "conflict": "conflict",
                 "unavailable": "unavailable", "invalid": "validation_failed", "gone": "cursor_expired",
                 "throttled": "throttled"}
DEFAULT_RETRYABLE = {"unavailable": True, "throttled": True}


class CoreError(Exception):
    """A typed refusal from the core. The facade maps `kind` to a status and keeps `code`."""

    def __init__(self, kind: CoreErrorKind, code: str | None = None, message: str | None = None,
                 retryable: bool | None = None, retry_after_s: int | None = None):
        self.kind = kind
        self.code = code or DEFAULT_CODES[kind]
        self.message = message or self.code.replace("_", " ")
        self.retryable = DEFAULT_RETRYABLE.get(kind, False) if retryable is None else retryable
        self.retry_after_s = retry_after_s
        super().__init__(f"{kind}:{self.code}")


@dataclass(frozen=True)
class LoginPoll:
    state: Literal["pending", "approved", "delivered", "expired"]
    poll_after_ms: int | None = None
    credential: str | None = None  # only with state "approved": the new session's cookie value
    expires_at: datetime | None = None  # the new session's expiry, with the credential


@dataclass(frozen=True)
class Page:
    items: list[dict[str, Any]]
    next_cursor: str | None
    as_of: datetime


@dataclass(frozen=True)
class SendResult:
    attempt: dict[str, Any]
    created: bool  # False: an idempotent repeat of an existing attempt


@dataclass(frozen=True)
class EventBatch:
    events: list[dict[str, Any]] = field(default_factory=list)  # EventEnvelope dicts, oldest first
    cursor: str = ""  # where the next read continues; event_id of an envelope is also a cursor


@runtime_checkable
class ReaderCore(Protocol):
    async def health(self) -> dict[str, Any]: ...

    async def start_login(self, email: str, *, origin: str | None, sec_fetch_site: str | None) -> dict[str, Any]:
        """Start a magic-link login. The core checks `origin` (and `Sec-Fetch-Site`, when sent) against
        its own allow-list and refuses with CoreError("forbidden", "origin_rejected"); None means absent."""
        ...

    async def poll_login(self, request_id: str) -> LoginPoll: ...

    async def logout(self, caller: Caller) -> None: ...

    async def list_devices(self, caller: Caller, cursor: str | None, limit: int) -> Page: ...

    async def list_identities(self, caller: Caller) -> Page: ...

    async def list_conversations(self, caller: Caller, cursor: str | None, limit: int) -> Page: ...

    async def get_conversation(self, caller: Caller, conversation_id: str) -> dict[str, Any]: ...

    async def mark_read(self, caller: Caller, conversation_id: str, up_to: str) -> None: ...

    async def list_messages(self, caller: Caller, conversation_id: str, cursor: str | None, limit: int) -> Page: ...

    async def list_contacts(self, caller: Caller, cursor: str | None, limit: int) -> Page: ...

    async def list_channels(self, caller: Caller) -> Page: ...

    async def create_send_attempt(self, caller: Caller, request: dict[str, Any]) -> SendResult:
        """Idempotent by `client_attempt_id`: same body returns the existing attempt, a different one is conflict."""
        ...

    async def get_send_attempt(self, caller: Caller, attempt_id: str) -> dict[str, Any]: ...

    async def read_events(self, caller: Caller, cursor: str | None, wait_s: float) -> EventBatch:
        """Events after `cursor` (None: from now) the caller may see.

        Returns at once when any are held, else waits up to `wait_s` for one. An expired or unknown
        cursor raises CoreError("gone").
        """
        ...

    async def create_lease(self, caller: Caller) -> dict[str, Any]: ...

    async def list_lease_keys(self, caller: Caller) -> dict[str, Any]: ...
