# Reader API contract — v1

This public contract defines the interface between the MECON Reader and an authorized MECON Backend. The machine-readable form is [`contracts/reader-api/v1/openapi.yaml`](../contracts/reader-api/v1/openapi.yaml), version `1.0.0-draft.11`, with replayable conformance cases. It is a **specification**, not an assertion that any Backend from this repository serves it: the hosted Backend serves the session operations the restricted Reader uses, and the public facade in `reader-backend/` passes the cases against fakes and a stub only. MeshCore native device operations remain governed by the firmware contract.

## Transport and authentication

- HTTPS JSON REST under `/api/reader/v1`; server-sent events (SSE) for server-to-Reader notifications. No direct MQTT or Backend database access.
- Use the Backend's authenticated session with secure HttpOnly cookies, same-origin by default, CSRF protection for writes and explicit CORS allowlisting for separate Reader origins. SSE uses the same authenticated session; never put credentials in query strings.
- Every request is scoped by server-side account/identity authorization. Device ownership and administrative role never grant another user's private-message read rights.
- Error format: `{code, message, request_id, retryable}`; 401 unauthenticated, 403 unauthorized, 404 unavailable/not found without existence disclosure, 409 conflict, 422 invalid request, 429 throttled, 503 temporarily unavailable. Unsupported capabilities are explicitly reported, not simulated.
- A Backend that cannot establish who a session is (whatever answers that is unreachable) answers 503 `unavailable`, `retryable: true`, and leaves the cookie alone; never 401, which signs the Reader out. Every operation that resolves a session declares this 503. A Backend may refuse on what it can judge without the session (Origin, request shape) before resolving it; the cases pin no order between CSRF and session resolution.
- When `POST /logout` answers 503 or not at all, the Reader signs out locally and retries the server-side logout later; until then it does not use the session.
- A malformed `limit` or `cursor` on a list is refused with 422 `invalid`, never clamped. History cursors never expire: one the Backend does not recognise as issued for that list is 422, never 410.
- Login (`POST /login`) is throttled silently: over a limit it answers the same 202 and sends no mail, so throttling never reveals which addresses have accounts. It never answers 429.
- Public contract schema uses OpenAPI 3.1 with synthetic, non-sensitive fixtures.

## REST resources

| Method/path | Purpose |
|---|---|
| `GET /health` | Unauthenticated liveness and the deployed commit |
| `POST /login` | Request a magic-link login for an existing account; the same 202 whether or not the account exists |
| `GET /login/{request_id}` | Poll the request; the session cookie is set on the single `approved` answer |
| `POST /logout` | Revoke the current session server-side |
| `GET /session` | Current user, authorized scopes, API capabilities and contract version |
| `GET /devices` | Assigned Companion IDs, role, capability evidence, battery, reachability and freshness |
| `GET /identities` | Authorized messaging identities and assigned device relationships |
| `GET /conversations?cursor=&limit=` | Authorized conversation summaries |
| `GET /conversations/{id}` | One authorized conversation (same shape as a list item); 404 when not visible, never 403 |
| `POST /conversations/{id}/read` | Mark read up to `{up_to: message_id}`; idempotent; emits a `conversation` event with the new unread count |
| `GET /conversations/{id}/messages?cursor=&limit=` | Authorized messages, source provenance and paging |
| `GET /contacts` | Authorized contacts |
| `GET /channels` | Authorized public and private channels, favourites where supported |
| `POST /send-attempts` | Explicit Backend-path send with idempotency key, selected identity, target and content |
| `GET /send-attempts/{id}` | Send attempt and evidenced state |
| `GET /events?cursor=` (or `Last-Event-ID`) | SSE authorized incremental updates |
| `POST /leases`, `GET /leases/keys` | Offline lease issue or renew, and its verification keys (see below) |

All list responses carry `items`, `next_cursor` (nullable) and `as_of`. IDs are opaque strings; timestamps UTC ISO-8601. `/session` advertises capability flags and contract minor version. Contract major version changes require a new prefix.

## Offline lease (M3 draft)

Additive to M1 and M2: `POST /leases` (issue or renew) and `GET /leases/keys` (public verification keys). Nothing in M1 or M2 changes. A Backend that issues no leases answers 404; the Reader then treats offline sending as not permitted.

A **lease** is a Backend-signed token, compact `payload.signature`, both base64url without padding. `payload` is the UTF-8 canonical JSON (keys sorted by code point at every level, no insignificant whitespace) of:

| Field | Meaning |
| --- | --- |
| `lease_id`, `user_id` | Opaque ids. A Reader refuses a lease whose `user_id` is not the account it is unlocked for. |
| `issued_at`, `expires_at` | UTC. `expires_at` is **at most 7 days** after `issued_at`; a verifier refuses a longer lease even when the signature is good. |
| `key_id` | Names the entry of `GET /leases/keys` that verifies it. |
| `contract_version` | `1.x`. |
| `identities[]` | `{identity_id, operations[]}` with operations from `receive`, `send.direct`, `send.channel`. |
| `devices[]` | Ids of devices assigned to the user. A local operation is permitted only on a listed device. |
| `channels[]` | Ids of channels the user may use offline. |

`signature` is Ed25519 over the ASCII bytes `MECON-LEASE-1`, one `0x00` byte, then the decoded payload bytes exactly as received. The verifier checks the signature over those bytes and only then trusts the JSON; it never re-serializes. Ed25519 was chosen for small keys and signatures and deterministic signing, and because WebCrypto can verify it in the browser. A browser without Ed25519 in WebCrypto cannot verify a lease, so the Reader says so and does not permit offline sends there.

What a lease is and is not:

- **The Reader can never mint or extend a lease.** It holds only public keys. A lease changes only when the Backend issues a new one, and the Reader stores a new lease only if it verifies.
- **Offline revocation cannot be faster than expiry.** A disabled user, a reassigned device or a removed channel is learned by a disconnected Reader only when its lease runs out, at most 7 days after the last renewal. The Reader renews silently whenever it is online with messaging available (once half the lifetime has passed). Online, a disabled user loses access at once, as before.
- **Online rights always come from the server.** While connected, every request is authorized by the Backend; the lease is not consulted.
- **A lease carries no secret and no key material:** only ids, scopes and times.

Clock rule. A lease is expired when the effective time reaches `expires_at`, with no grace. The effective time is the latest of the local clock, the newest time the device saw while unlocked, and the lease's own `issued_at`, so setting the clock back does not revive a lease the device has already seen expire. A clock that simply runs slow, with nothing observed to show it, can extend a lease by that much (inside the 7-day maximum); that cannot be detected offline.

Lease states in the Reader: `valid`, `expired`, `missing`, `invalid-signature` (bad signature, unknown or out-of-validity `key_id`, a lifetime over 7 days, another user's lease, a malformed payload) and `unsupported` (no Ed25519). Only `valid` permits anything, and only the identities, operations and devices it lists.

Unlock for the cache that holds a lease is a passkey through the WebAuthn PRF extension only (owner decision, 2026-11-18). There is no PIN: a browser without PRF has no offline cache, and so no stored lease, and works online only.

Fixtures: `lease-issued.json` and `lease-keys.json` are synthetic and signed with a **test-only** keypair (`contracts/reader-api/v1/test-only/lease-test-keypair.json`, regenerate with `contracts/scripts/gen-lease-fixtures.mjs`). That key protects nothing and no Reader or Backend may trust it.


## Message and attempt semantics

- A client creates a stable `client_draft_id`, chooses exactly one path (`ble` or `backend`), and creates a distinct `client_attempt_id` for an actual send. Backend POST requires an `Idempotency-Key` matching the attempt; identical repeats return the same attempt, differing payloads with the same key return 409.
- Backend send request: `{client_draft_id,client_attempt_id,identity_id,target:{kind,id},content:{kind,text}}`. Server validates authorized identity, target and send capability. A BLE attempt is **never** posted to this endpoint merely to reconcile a local message.
- Attempt response: `{id,client_attempt_id,path,identity_id,status,status_evidence,created_at,updated_at}`. Possible statuses: `queued`, `duty_held`, `transmitted`, `acked`, `timed_out`, `failed`, `unknown`; distinguish Backend acceptance from radio evidence. Channel messages do not imply recipient ACK. Direct-message ACK does not imply human read receipt.
- Only a 4xx answer to `POST /send-attempts` (400, 403, 404, 409, 422, and 429 with `Retry-After`) is a definite "not accepted". Any 5xx, 503 included, is ambiguous: the Backend deduplicates on `client_attempt_id`, so re-POSTing the same attempt returns the existing one and never sends twice, and a client never answers it with a new attempt. `acked` never occurs for a channel target. The first send to a channel creates its conversation server-side, idempotently per channel, and a `conversation` event follows.
- Device outcome/inbox buffers may be bounded and lost on reboot. `unknown` or `timed_out` does not prove non-transmission; **never automatically resend** through the same or another path. The user must explicitly authorize a new attempt, with a new attempt ID.
- Messages include `message_id`, `conversation_id`, `identity_id`, `source_path`, `observed_at`, `content`, and optional `attempt_id`; do not invent a cross-source merge when identity cannot be proven.

## Automatic Backend-origin coordination — target

For a user-initiated **Backend-path** P2P/DM, public-channel or private-channel send, Reader chooses the authorized sender identity and destination, **not Repeater Gateway origins**. Backend coordinates an eligible Companion-first, otherwise random-gateway-first RF transmission and observation-driven sequential fallback across gateways. Each subsequent origin is selected only after a 10–15-second window **measured from confirmed actual RF transmission**, if that gateway has neither heard nor transmitted the same native packet. Backend retains one logical send attempt, per-origin outcomes and native packet identity where valid; normal RF repeating continues. Report truthful progress and uncertainty. No automatic fallback from an uncertain **BLE-path** send to Backend; BLE/Backend remain explicit separate paths. See the [decision register](ARCHITECTURE_DECISIONS.md). This is target behavior, not a claim of an implemented endpoint.

## Events and synchronization

SSE event envelope: `{event_id,kind,occurred_at,resource_id,version}`. Kinds include message, conversation, device status, attempt status, authorization changed, resync required and session revoked. Cursor is opaque, scoped to the authenticated user and expires according to server policy. Reconnect with the `Last-Event-ID` header or the `cursor` query parameter (both accepted; the header wins when both are present). `resource_id` is the conversation id for `message` and `conversation`, the server attempt id for `attempt_status` and the device id for `device_status`. On expiration or permission changes, discard cached unauthorized data and reload authorized snapshots. Do not replay private content after revocation. When the stream's own session is revoked or ended on the server, the Backend sends one `session_revoked` envelope (`resource_id` null) and ends the stream; the Reader returns to sign-in as on a 401 and does not reconnect with that session. The Backend sends an SSE comment heartbeat every 25 s while idle; a client treats 50 s without bytes (two intervals) as a dead stream. Heartbeats are transport-only.

## Acceptance

Publish OpenAPI and synthetic fixtures for authorized and forbidden account/fleet/identity cases, direct/channel messages, BLE-only and Backend-only operation, uncertain sends, reconnect, expired cursor and revocation. Replayable conformance cases live in `contracts/reader-api/v1/cases/` (see its README): each names a synthetic world, a sequence of requests and the status, schema, headers and values expected, and `contracts/validate.mjs` checks every case against the OpenAPI document. A Backend serves this API when it passes every case. Contract tests enforce isolation, stable idempotency, correct status evidence, and preservation of existing Reader behavior. Hardware/browser acceptance is tracked separately in the Reader's availability evidence.
