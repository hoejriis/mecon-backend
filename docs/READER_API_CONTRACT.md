# Reader API contract — target v1

This public contract defines the interface between the MECON Reader and an authorized MECON Backend. It is a **target specification**, not an assertion that endpoints are already available. MeshCore native device operations remain governed by the firmware contract.

## Transport and authentication

- HTTPS JSON REST under `/api/reader/v1`; server-sent events (SSE) for server-to-Reader notifications. No direct MQTT or Backend database access.
- Use the Backend's authenticated session with secure HttpOnly cookies, same-origin by default, CSRF protection for writes and explicit CORS allowlisting for separate Reader origins. SSE uses the same authenticated session; never put credentials in query strings.
- Every request is scoped by server-side account/identity authorization. Device ownership and administrative role never grant another user's private-message read rights.
- Error format: `{code, message, request_id, retryable}`; 401 unauthenticated, 403 unauthorized, 404 unavailable/not found without existence disclosure, 409 conflict, 422 invalid request, 429 throttled, 503 temporarily unavailable. Unsupported capabilities are explicitly reported, not simulated.
- Public contract schema uses OpenAPI 3.1 with synthetic, non-sensitive fixtures.

## REST resources

| Method/path | Purpose |
|---|---|
| `GET /session` | Current user, authorized scopes, API capabilities and contract version |
| `GET /devices` | Assigned Companion IDs, role, capability evidence, battery, reachability and freshness |
| `GET /identities` | Authorized messaging identities and assigned device relationships |
| `GET /conversations?cursor=&limit=` | Authorized conversation summaries |
| `GET /conversations/{id}/messages?cursor=&limit=` | Authorized messages, source provenance and paging |
| `GET /contacts` | Authorized contacts |
| `GET /channels` | Authorized public and private channels, favourites where supported |
| `POST /send-attempts` | Explicit Backend-path send with idempotency key, selected identity, target and content |
| `GET /send-attempts/{id}` | Send attempt and evidenced state |
| `GET /events?cursor=` | SSE authorized incremental updates |

All list responses carry `items`, `next_cursor` (nullable) and `as_of`. IDs are opaque strings; timestamps UTC ISO-8601. `/session` advertises capability flags and contract minor version. Contract major version changes require a new prefix.

## Message and attempt semantics

- A client creates a stable `client_draft_id`, chooses exactly one path (`ble` or `backend`), and creates a distinct `client_attempt_id` for an actual send. Backend POST requires an `Idempotency-Key` matching the attempt; identical repeats return the same attempt, differing payloads with the same key return 409.
- Backend send request: `{client_draft_id,client_attempt_id,identity_id,target:{kind,id},content:{kind,text}}`. Server validates authorized identity, target and send capability. A BLE attempt is **never** posted to this endpoint merely to reconcile a local message.
- Attempt response: `{id,client_attempt_id,path,identity_id,status,status_evidence,created_at,updated_at}`. Possible statuses: `queued`, `duty_held`, `transmitted`, `acked`, `timed_out`, `failed`, `unknown`; distinguish Backend acceptance from radio evidence. Channel messages do not imply recipient ACK. Direct-message ACK does not imply human read receipt.
- Device outcome/inbox buffers may be bounded and lost on reboot. `unknown` or `timed_out` does not prove non-transmission; **never automatically resend** through the same or another path. The user must explicitly authorize a new attempt, with a new attempt ID.
- Messages include `message_id`, `conversation_id`, `identity_id`, `source_path`, `observed_at`, `content`, and optional `attempt_id`; do not invent a cross-source merge when identity cannot be proven.

## Events and synchronization

SSE event envelope: `{event_id,kind,occurred_at,resource_id,version}`. Kinds include message, conversation, device status, attempt status, authorization changed and resync required. Cursor is opaque, scoped to the authenticated user and expires according to server policy. Reconnect with cursor; on expiration or permission changes, discard cached unauthorized data and reload authorized snapshots. Do not replay private content after revocation. Heartbeats are transport-only.

## Acceptance

Publish OpenAPI and synthetic fixtures for authorized and forbidden account/fleet/identity cases, direct/channel messages, BLE-only and Backend-only operation, uncertain sends, reconnect, expired cursor and revocation. Contract tests enforce isolation, stable idempotency, correct status evidence, and preservation of existing Reader behavior. Hardware/browser acceptance is tracked separately in the Reader's availability evidence.
