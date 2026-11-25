# Reader core v1 conformance cases

Replayable cases for `../openapi.yaml`. A core that claims to serve it replays every case in its own CI and passes each one; the facade replays them against a stub core over HTTP and against its fake core (`reader-backend/tests/test_core_cases.py`). Every name, origin, token and id here is made up.

The format and the replay rules are the Reader API's, in [`../../../reader-api/v1/cases/README.md`](../../../reader-api/v1/cases/README.md), as session lookup uses them ([`../../../session-lookup/v1/cases/README.md`](../../../session-lookup/v1/cases/README.md)): worlds, requests, expectations, captures and lease checks work the same way. `contracts/validate.mjs` checks these cases against this document: each request body matches its operation's request schema (or is marked `invalid` and must fail it and expect 422), every expected status is declared with that schema, every capture is defined before use, every world action exists with its arguments, and every operation has at least one case.

## Differences from the Reader API's format

- There are no clients, cookies, Origin modes or CSRF tokens: the facade has already resolved the session. A request is the operation's JSON body, written out in the case.
- The caller reference is built in the body from two captures: `issue-session` captures the session's `session_ref`, `user-id` captures the user's `user_id`. A case assumes no id: every id it uses (identities, contacts, channels, conversations, messages, attempts, cursors) is captured from an earlier answer.
- `service_token` on a request is `valid` (default: the deployment's token), `absent` (no `Authorization` header) or `wrong` (a different string).
- `core-degraded` makes the core unable to answer anything until `core-recovered`.

## Replay rules

1. Each case starts from a fresh copy of its world, with both switches on.
2. Steps run in order; the first unmet expectation fails the case.
3. An expectation checks the status, that the status is declared for the operation, the body against the named schema (`null`: no body), each `body` pointer's exact value, each `match` count, and a `lease` check (the token verifies under the listed keys, its payload is a `LeasePayload` for `user_id`, lives at most `max_lifetime_s`, and its identities carry the listed operations).
4. A case or step a core cannot express (for example a core that always offers leases, for `lease_signing: absent`) is reported not applicable with its reason, never passed.

## Files

- `cases.schema.json`: the shape of a case file.
- `worlds.json`: the `two-fleets` world (two users in two fleets, a device and an identity each, a direct-message thread each, one shared channel and one private channel per fleet) and the runner actions.
- `transport.json`, `session.json`, `reads.json`, `send.json`, `events.json`, `leases.json`: the cases.

## What the cases cover

- **Transport:** 401 `service_unauthorized` with the header absent and wrong (nothing recorded behind it); 422 `malformed_request`, fixed body, for a `limit` of 0 or 201, a 513-character cursor, an unknown member, a missing or partial caller, a short login request id, and a `wait_s` above 25 or below 0; 503 `core_unavailable` on every kind of operation, and recovery; the order 401, then 422, then 503, then `session_ended`.
- **Session:** health; a login approved once then `delivered`; the Origin rule (trailing slash, same-origin with no or a foreign Origin, refusals); a login for no account reads like one for an account; logout ends the session and repeats as 204; `session_ended` for a session ended elsewhere, expired, or named with another user's id or an id never issued, before any scope check; logout ends nothing when the user and session do not match.
- **Reads and scope:** devices, identities, channels and contacts per user and fleet; another user's conversation, messages, mark-read and attempt answer exactly as a missing one (404 `not_found`); paging conversations and messages by cursor to a null `next_cursor`; a cursor the list did not issue is 422 `invalid`; mark read moves the owner's mark and refuses an `up_to` from another conversation.
- **Sends:** 201 for a new attempt, 200 and the same attempt for a repeat, 409 for the same id with another request, ids scoped per user, `sending_disabled` with nothing recorded, another user's identity `forbidden`, an out-of-scope target `validation_failed`, the first channel send creating the conversation.
- **Events:** read from now, then the caller's own events after the cursor and never another user's; 410 `cursor_expired` for an aged-out and a never-issued cursor; an empty batch after waiting; `session_ended` for an ended session.
- **Leases:** a lease for the caller that verifies under the served keys, without send operations while sending is off; 404 when leases are not offered; 503 `lease_signing_unavailable` (not retryable) with keys still listed; `session_ended`.

## Not replayable yet

- **The 401 before a malformed body:** a case cannot send a body that breaks the schema and expect anything but 422, so the order "401 first" is proved with well-formed bodies (and while degraded), not with a malformed one.
- **A long poll that ends early:** a read answering as soon as an event arrives during `wait_s` needs a second actor mid-call; the cases prove only the empty answer after the wait and the immediate answer when events are held.
- **Rate limits:** 429 `throttled` with `retry_after_s` is declared but no world action makes a core throttle.
- **The facade's mapping** of these answers to the Reader API (`session_ended` to 401 with the cookie cleared and a `session_revoked` frame on an open stream, `core_unavailable` to 503 `unavailable`) is the facade's own tests'.
