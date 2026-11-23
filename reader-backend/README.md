# MECON Reader backend (facade)

A public implementation of the Reader API ([`contracts/reader-api/v1`](../contracts/reader-api/v1/openapi.yaml)): a Starlette app that serves the HTTP side of the contract and hands everything else to a core through two ports. It is groundwork. There are no real adapters yet, it is not deployed anywhere, and nothing in production depends on it.

## What the facade owns

- The host-only session cookie `__Host-mecon_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`): set on the single `approved` login poll, cleared on logout and whenever a presented session is refused.
- Passing every write's `X-CSRF-Token` and `Origin` to the session lookup, which checks them. Writes never use the cache.
- Passing the `Origin` and `Sec-Fetch-Site` of `POST /login` to the core, which checks them against its own allow-list before a session exists. The facade may also refuse a foreign Origin early (`login_origin_precheck`), but the core's check holds without it.
- The `Idempotency-Key` rule: the header is required on `POST /send-attempts` and must equal `client_attempt_id`.
- Validating request bodies, path and query parameters (422 `invalid`). A lease request with a body is refused.
- Error bodies `{code, message, request_id, retryable}` and mapping each core error to a status the operation declares. A core error whose status the operation does not declare is never passed on: it becomes 404 where the operation has one (forbidden or not found), else 503.
- `Cache-Control: no-store` on every answer.
- The event stream: SSE framing (one `id:` and one `data:` line per `EventEnvelope`), `Last-Event-ID` winning over `?cursor=`, 410 `cursor_expired` before the stream starts, a `: heartbeat` comment right after the backlog and then while idle, and closing the stream when its session is revoked.
- Failing closed on the session lookup. `expired`, `revoked` and `unknown` give 401 and clear the cookie. `core_unavailable`, a timeout, an adapter error or a malformed answer give 503 `unavailable` (retryable) and keep the cookie. A caller whose `expires_at` has passed is refused even when the lookup returned it.

## Ports

[`ports.py`](src/mecon_reader_backend/ports.py) defines both ports as `typing.Protocol`s.

- **`SessionLookup.resolve(credential, purpose, csrf_token=, origin=)`** returns a `Caller` or a `Denied`. `purpose` is `read`, `write` or `stream`. On a write the lookup checks the CSRF token and the Origin and may deny with `csrf_failed` or `origin_rejected` (both 403). A `Caller` carries:
  - `session_ref` (the core's stored session reference, a hash, never the cookie value), `user_id` and `display_name`;
  - `role` (`instance_admin` or `user`) and `break_glass`;
  - `capabilities`, which the facade passes through as `GET /session` reports them;
  - `expires_at`;
  - `csrf_token`, which the lookup derives and `GET /session` returns.
  It has no scope: scope stays in the core.
- **`SessionLookup.revocations()`** first yields `Subscribed` once the core has confirmed the subscription, then one `Revocation(session_ref)` per revoked session. A user-wide revocation arrives as one `Revocation` per session of that user. The facade drops any cached caller for that session and closes its open streams. The feed counts as up only from `Subscribed`. Before that, and after any end or error until the next `Subscribed`, nothing is cached, and open streams close once it has been down for `feed_down_close_s`.
- **`ReaderCore`** has one method per core-owned capability:
  - health;
  - login start (with the request's `Origin` and `Sec-Fetch-Site`), poll and logout;
  - devices, identities, conversations (list and one), read marks, messages, contacts and channels;
  - send attempts (create, idempotent by `client_attempt_id`, and get);
  - the event feed (`read_events(caller, cursor, wait_s)`);
  - lease issue and lease keys.

  Every call carries the `Caller`, and the core decides what that caller sees. Refusals are typed `CoreError`s: `not_found`, `forbidden`, `conflict`, `unavailable`, `invalid`, `gone` and `throttled`.

Read answers are cached for at most `lookup_cache_s` (5 s), never past the caller's expiry, never across a revocation the facade has heard of, and only while the revocation feed is up. An answer is not cached if a revocation arrived while its lookup ran. The cache holds at most `lookup_cache_max` entries (10,000): an insert drops expired entries, then the oldest. Logout drops the entry at once.

## Fake adapters

[`fakes/`](src/mecon_reader_backend/fakes/) builds an in-memory world from a `worlds.json` description and implements both ports over it: users, fleets, devices, identities, contacts, channels, messages, read marks, the two switches, send attempts, events and their retention, and Ed25519 lease keys that can be rotated and revoked. A lease is signed as `LeaseToken` describes. The fakes exist for the tests and for poking at the API locally. They are not an implementation of the core.

## Run

```sh
cd reader-backend
pip install --require-hashes --no-deps -r requirements-dev.lock
python -m pytest -q                 # cases, facade rules, guards, validator cross-check
python scripts/mutation.py          # mutants on the facade's own rules; every one must be killed
PYTHONPATH=src python -m mecon_reader_backend --world ../contracts/reader-api/v1/cases/worlds.json --port 8787 --origin http://127.0.0.1:8787
```

The last command serves the synthetic world on the loopback address only. Logins there are approved out of band, so it is for poking at the API by hand.

## What CI proves, and what it does not

The `reader-backend` workflow replays every published case from `contracts/reader-api/v1/cases`, read in place and never copied, against this app with the fake adapters. One pytest item runs per case id. A case whose action the implementation cannot express would be skipped as not applicable; none is. The workflow also runs:

- unit tests of the facade's own rules;
- guard tests: the case count equals the files, every operation is exercised, every world action is mapped, and the routes and declared statuses match the OpenAPI;
- a cross-check of the hand-written validators against the OpenAPI schemas;
- a self-test showing that the runner fails a case whose expectation is not met;
- the mutation check.

It does **not** prove isolation. The isolation cases (another fleet's devices, contacts, channels, conversations, attempts and events) pass here only because the fake core scopes correctly, and the facade does no scoping at all. The real proof is the core passing the same cases, and later this facade passing them on real adapters. CI also does not prove:

- rate limiting;
- the login mail;
- any real session store;
- anything about deployment.
