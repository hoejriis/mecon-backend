# MECON Reader backend (facade)

A public implementation of the Reader API ([`contracts/reader-api/v1`](../contracts/reader-api/v1/openapi.yaml)): a Starlette app that serves the HTTP side of the contract and hands everything else to a core through two ports. It also serves the authorized observation projection ([`contracts/observations/v1`](../contracts/observations/v1/openapi.yaml), see below). It is groundwork. There are no real adapters for the session and core ports yet, it is not deployed anywhere, and nothing in production depends on it.

## What the facade owns

- The host-only session cookie `__Host-mecon_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`): set on the single `approved` login poll, cleared on logout and whenever a presented session is refused.
- Passing every write's `X-CSRF-Token` and `Origin` to the session lookup, which checks them. Writes never use the cache.
- Passing the `Origin` and `Sec-Fetch-Site` of `POST /login` to the core, which checks them before a session exists. The rule accepts a request when either:
  - the Origin, with any trailing `/` stripped, is on the allow-list; or
  - `Sec-Fetch-Site` is `same-origin`.

  Anything else gets 403 `origin_rejected`. The facade's optional pre-check (`login_origin_precheck`) applies the same rule with the same list (`reader_origins`), so it never refuses what the core would accept, and the core's check holds without it.
- The `Idempotency-Key` rule: the header is required on `POST /send-attempts` and must equal `client_attempt_id`.
- Validating request bodies, path and query parameters (422 `invalid`). A `limit` or `cursor` outside its schema is refused, never clamped; a cursor the core did not issue is the core's to refuse (`invalid`). A lease request with a body is refused.
- Error bodies `{code, message, request_id, retryable}` and mapping each core error to a status the operation declares. A core error whose status the operation does not declare is never passed on: it becomes 404 where the operation has one (forbidden or not found), else 503.
- `Cache-Control: no-store` on every answer.
- The event stream: SSE framing (one `id:` and one `data:` line per `EventEnvelope`), `Last-Event-ID` winning over `?cursor=`, 410 `cursor_expired` before the stream starts, a `: heartbeat` comment right after the backlog and then while idle, and closing the stream when its session is revoked, after one `session_revoked` envelope (`resource_id` null, no `id:` line).
- Failing closed on the session lookup. `expired`, `revoked` and `unknown` give 401 and clear the cookie. `core_unavailable`, a timeout, an adapter error or a malformed answer give 503 `unavailable` (retryable) and keep the cookie. A caller whose `expires_at` has passed is refused even when the lookup returned it.

## Ports

[`ports.py`](src/mecon_reader_backend/ports.py) defines both ports as `typing.Protocol`s.

- **`SessionLookup.resolve(credential, purpose, csrf_token=, origin=, sec_fetch_site=)`** returns a `Caller` or a `Denied`, as the session lookup contract's `POST /lookup` does. `purpose` is `read`, `write`, `stream` or `session` (the read that serves `GET /session`). Every lookup carries the request's Origin and Sec-Fetch-Site. On a write the lookup checks the CSRF token and the Origin rule (an allow-listed Origin, or `Sec-Fetch-Site: same-origin`) and may deny with `csrf_failed` or `origin_rejected` (both 403). The `Caller` carries the CSRF token only on a `session` lookup; that lookup fails closed (503) if the token does not come back, and never answers from a cached `Caller` without one. A `Caller` carries:
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

Read answers are cached for at most `lookup_cache_s` (5 s), never past the caller's expiry, never across a revocation the facade has heard of, and only while the revocation feed is up. An answer is not cached if a revocation arrived while its lookup ran. The cache holds at most `lookup_cache_max` entries (10,000): an insert prunes timed-out entries from the oldest end, then evicts the oldest while full. Logout drops the entry at once.

## Observations

[`observations.py`](src/mecon_reader_backend/observations.py) mounts `GET /observers`, `GET /snapshot` and `GET /events` (SSE) at `/api/observations/v1/authorized`, in the same app. They share the session resolver, the session cookie and the error body. They are GET only, so there is no CSRF token. `create_app(lookup, core, config, observation_scope=, reception_store=)` mounts them; without both ports the routes do not exist.

- **Access** comes from the resolved session's `capabilities.observations`: `forbidden` is 403 `forbidden` on all three operations, `unavailable` (or a scope or store that cannot answer) is 503 `unavailable`, retryable, and a caller who may observe but sees nothing gets 200 with an empty list or snapshot and a stream of heartbeats only. The grant is read on every request and every stream reconnect (a session answer may come from the 5 s read cache; a revocation drops it at once).
- **Scope** never comes from capabilities and the facade never computes or widens it. `ObservationScope.visible_observers(caller)` is a core call: the observers the caller may see, each with its provenance (`own_fleet`, `shared_fleet`, `approved_public_source`) and how precisely its location may be shown (none: withheld). It is asked again on every request and on every read of an open stream. `ReceptionStore` answers only for the observers it was handed.
- **The store.** [`fakes/observations.py`](src/mecon_reader_backend/fakes/observations.py) is the in-memory adapter for the cases. [`sqlite_receptions.py`](src/mecon_reader_backend/sqlite_receptions.py) reads the processor's SQLite store (`processing/`) on read-only connections: observer ids and reception ids are keyed hashes, the packet correlation id is a keyed hash bound to the caller (never the packet hash), cursors are bound to the caller, `rssi` is rounded and null outside -200..0, `transport` is `mqtt`, `packet_kind` is mapped from the packet type, and no hash, hop count, route type or transmitter position is ever read into a response. Labels and positions come from an `ObserverDirectory` the deployment supplies. There is no real `ObservationScope` yet: only the fake in tests.
- **The stream** sends `id:` = `event_id` and one `ObservationEvent` per `data:` line, the held backlog first, then a heartbeat comment at least every `heartbeat_s` (25 s by default) while idle. `Last-Event-ID` wins over `?cursor=`. A malformed, foreign or out-of-retention cursor is 410 `cursor_expired` before the stream starts. When the session is revoked it sends one `access_revoked` and closes; when a read finds the cursor gone it sends `resync_required` and closes. The control events' ids are never cursors, so resuming from one is a 410.
- List and snapshot answers carry `Cache-Control: no-store`.

## Fake adapters

[`fakes/`](src/mecon_reader_backend/fakes/) builds an in-memory world from a `worlds.json` description and implements both ports over it: users, fleets, devices, identities, contacts, channels, messages, read marks, the two switches, send attempts, events and their retention, and Ed25519 lease keys that can be rotated and revoked. A lease is signed as `LeaseToken` describes. The fakes exist for the tests and for poking at the API locally. They are not an implementation of the core.

## Run

```sh
cd reader-backend
pip install --require-hashes --no-deps -r requirements-dev.lock
python -m pytest -q                 # Reader API and observation cases, facade rules, SQLite store, guards, validator cross-check
python scripts/mutation.py          # mutants on the facade's own rules and the observation scope filters; every one must be killed
PYTHONPATH=src python -m mecon_reader_backend --world ../contracts/reader-api/v1/cases/worlds.json --port 8787 --origin http://127.0.0.1:8787
```

The last command serves the synthetic world on the loopback address only. Logins there are approved out of band, so it is for poking at the API by hand.

## What CI proves, and what it does not

The `reader-backend` workflow replays every published case from `contracts/reader-api/v1/cases` and `contracts/observations/v1/cases`, read in place and never copied, against this app with the fake adapters (one runner, parameterised by contract). One pytest item runs per case id. A case whose action the implementation cannot express would be skipped as not applicable; none is. The workflow also runs:

- unit tests of the facade's own rules;
- guard tests: the case count equals the files, every operation is exercised, every world action is mapped, and the routes and declared statuses match the OpenAPI;
- a cross-check of the hand-written validators against the OpenAPI schemas;
- a self-test showing that the runner fails a case whose expectation is not met;
- the mutation check.

The observation cases do not cover a stream's `access_revoked` while open, `resync_required`, the heartbeat or the freshness states; this package's own tests do, but the cases do not pin them for another implementation.

It does **not** prove isolation. The isolation cases (another fleet's devices, contacts, channels, conversations, attempts and events) pass here only because the fake core scopes correctly, and the facade does no scoping at all. The real proof is the core passing the same cases, and later this facade passing them on real adapters. CI also does not prove:

- rate limiting;
- the login mail;
- any real session store;
- anything about deployment.
