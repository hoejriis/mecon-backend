"""The two ports the facade calls: session lookup and the Reader core.

The facade owns HTTP: cookies, Origin and CSRF plumbing, request validation, status mapping,
error bodies, caching headers and the event stream framing. Everything about who a caller is and
what that caller may see belongs behind these ports. Every core call carries the resolved
`Caller`; the core decides what that caller sees.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator, Literal, Mapping, Protocol, Sequence, Union, runtime_checkable

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
    csrf_token: str | None = None  # derived by the core; only on a lookup with include_csrf (GET /session)


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
                      origin: str | None = None, sec_fetch_site: str | None = None,
                      include_csrf: bool = False) -> Union[Caller, Denied]:
        """Resolve the raw session cookie value.

        For purpose="write" the facade passes the request's X-CSRF-Token, Origin and Sec-Fetch-Site values
        (None when absent). The lookup checks them: the Origin rule (an allow-listed Origin, trailing "/"
        stripped, or Sec-Fetch-Site "same-origin") and the CSRF token, answering Denied("origin_rejected")
        or Denied("csrf_failed"). `include_csrf` asks for the session's CSRF token in the Caller; the facade
        asks only on the lookup behind GET /session, and the Caller carries none otherwise.
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


# ---- observations (contracts/observations/v1) ----

Provenance = Literal["own_fleet", "shared_fleet", "approved_public_source"]


@dataclass(frozen=True)
class ScopedObserver:
    """One observer a caller may see, as the core decides it. The facade never computes or widens this."""

    observer_id: str  # the opaque id the API reports for this observer
    provenance: Provenance  # which rule made it visible
    location_precision_m: float | None  # None: the location is withheld; else the radius it may be shown at


@dataclass(frozen=True)
class ObserverPage:
    items: list[dict[str, Any]]  # Observer dicts
    next_cursor: str | None


@dataclass(frozen=True)
class SnapshotResult:
    items: list[dict[str, Any]]  # Reception dicts, oldest first
    cursor: str  # hand to the event stream or to a later `since`
    expires_at: datetime  # when the cursor stops being accepted


@runtime_checkable
class ObservationScope(Protocol):
    """The core's call: which observers this caller may see, and how each location may be shown.

    A caller whose rules match nothing gets an empty list, never an error. An answer the core cannot give
    raises CoreError("unavailable"). The facade passes the answer to the ReceptionStore unchanged.
    """

    async def visible_observers(self, caller: Caller) -> Sequence[ScopedObserver]: ...


@runtime_checkable
class ReceptionStore(Protocol):
    """Observers and receptions. Every method answers only for the observers in `scope`, and nothing else.

    A cursor that is malformed, was not issued to this caller, or is outside retention raises
    CoreError("gone"); a store that cannot answer raises CoreError("unavailable").
    """

    async def observers(self, caller: Caller, scope: Sequence[ScopedObserver], cursor: str | None,
                        limit: int) -> ObserverPage: ...

    async def snapshot(self, caller: Caller, scope: Sequence[ScopedObserver], since: str | None,
                       limit: int) -> SnapshotResult: ...

    async def events_after(self, caller: Caller, scope: Sequence[ScopedObserver], cursor: str | None,
                           wait_s: float) -> EventBatch:
        """ObservationEvent dicts (kind `reception`) after `cursor` (None: from now), oldest first; waits up to
        `wait_s` for one when none is held. `EventBatch.cursor` is where the next read continues."""
        ...
