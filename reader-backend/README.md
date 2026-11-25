# MECON Reader backend (facade)

A public implementation of the Reader API ([`contracts/reader-api/v1`](../contracts/reader-api/v1/openapi.yaml)): a Starlette app that serves the HTTP side of the contract and hands everything else to a core through two ports. It also serves the authorized observation projection ([`contracts/observations/v1`](../contracts/observations/v1/openapi.yaml), see below). It is groundwork. Each port has one real adapter, an HTTP client: for the session lookup contract ([`contracts/session-lookup/v1`](../contracts/session-lookup/v1/openapi.yaml)) and for the reader-core contract ([`contracts/reader-core/v1`](../contracts/reader-core/v1/openapi.yaml)), which the fake core follows too (both below). `--core-url` wires both into the run command. The facade is not deployed anywhere, and nothing in production depends on it.

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

## HTTP session lookup adapter

[`http_lookup.py`](src/mecon_reader_backend/http_lookup.py) implements the `SessionLookup` port over HTTP, as the session lookup contract describes it: `HttpSessionLookup(base_url, token_file, timeout_s=, feed_silence_s=50)`.

- **The service token** is read from `token_file` (the deployment's mode-600 file) by path, again whenever the file changes, and sent as `Authorization: Bearer` on every request. It is never logged and never shown in a repr. A missing or empty file makes every lookup `core_unavailable` without a request.
- **`resolve`** sends `POST {base}/lookup` with `credential`, `purpose`, `origin` and `sec_fetch_site`, plus `csrf_token` on a write. A value past its schema bound is never sent: an over-long Origin or Sec-Fetch-Site goes as absent, which never accepts what the core would refuse, and an over-long CSRF token is left out (`csrf_failed`). A credential that is empty or longer than 4096 characters is `unknown` without asking.
- **The answer** is mapped by status:
  - 200 is a `Caller` only if it matches the contract's schema exactly: every required member, no extra member (so no scope can slip in), a `user_id` of at most 128 characters, a `csrf_token` (when present) of 16 to 512, and an RFC 3339 `expires_at` with an offset.
  - 403 is a `Denied` only with one of its five reasons and `retryable: false`.
  - Everything else is `core_unavailable`, so the cookie is kept: 503, 401 `service_unauthorized`, any other status, a redirect (never followed), a timeout (`timeout_s` bounds the whole lookup), a refused connection, a body that is not JSON or breaks the schema, or one over 64 KiB.
- **`revocations`** reads `GET {base}/revocations` as server-sent events. It yields `Subscribed` and `Revocation(session_ref, reason)` and skips comment lines (the heartbeat). An item it cannot read is never skipped, since it could be a revocation. It ends, so the resolver counts the feed down, caches nothing and reconnects after `feed_retry_s`, in these cases:
  - no bytes for `feed_silence_s`, heartbeats included;
  - no `subscribed` item within `subscribe_timeout_s` (30 s) of connecting, whatever other bytes arrive (logged as a warning), so caching cannot stay off unnoticed;
  - any status but 200, or a body that is not an event stream;
  - an item it cannot read (not JSON, an unknown `type`, a missing, extra or invalid member) an over-long line, or data lines of one event over 16 KiB together;
  - any transport error.
- **A refused service token** (401 `service_unauthorized`, on a lookup or on the feed) is a configuration fault, not an outage. It is still answered as `core_unavailable`, so the cookie is kept. It is logged at ERROR once when it starts and once when it stops, never once per request. Only a valid answer (a `Caller`, a `Denied`, or `subscribed` on the feed) ends it: a timeout, a 503 or a refused connection shows nothing about the token; a 503 is logged as a warning.
- **`health_state`** is `unknown` until the core first answers, then `ok`, `unavailable` or `service_unauthorized`. `GET /health` reports it as `session_lookup`, a member the Reader API's `Health` schema allows, but only as `unknown`, `ok` or `unavailable`: `/health` is unauthenticated, so a refused token shows there as `unavailable` and is named only in the ERROR log. A lookup without that attribute, such as the fake, adds nothing.
- **The client** is httpx with explicit timeouts. It ignores proxy settings from the environment, because the core is on the deployment's private network, over plain HTTP.

## HTTP core adapter

[`http_core.py`](src/mecon_reader_backend/http_core.py) implements the `ReaderCore` port over HTTP, as the reader-core contract (1.0.0-draft.2) describes it: `HttpReaderCore(base_url, token_file, timeout_s=5, events_margin_s=5)`.

- **One method, one operation.** Each port method is a `POST {base}/reader/...` with the operation's JSON body: the `caller` reference (`{user_id, session_ref}`, nothing else about the caller) and the arguments. `getHealth` is a `GET`. `base_url` includes any path prefix in front of `/reader/`. A first page sends no `cursor`; `limit` is always sent. Login start and poll carry `client_address`, which the facade derives behind its trusted proxies. An over-long Origin or Sec-Fetch-Site is sent as absent, which never accepts what the core would refuse. A `wait_s` outside 0 to 25 is sent at the nearer bound.
- **The service token** is handled as by the session lookup adapter: read from `token_file` by path, again whenever the file changes, sent as `Authorization: Bearer` on every call, never logged and never in a repr. A missing or empty file answers `core_unavailable` without a request.
- **Timeouts.** `timeout_s` bounds each call. `read_events` is a long poll, so it is bounded by its `wait_s` plus `events_margin_s`.
- **Answers** are checked against the contract's schema for their operation and status before use. [`core_schema.py`](src/mecon_reader_backend/core_schema.py) checks them against a copy of the document's schemas ([`reader_core_schemas.py`](src/mecon_reader_backend/reader_core_schemas.py), written by [`scripts/reader_core_schemas.py`](scripts/reader_core_schemas.py)), so the running facade needs no schema engine. A `pattern` is matched as ECMA-262 means it: `$` only at the end of the value, and `\d` and `\w` ASCII only. A refusal must also carry a code its status declares (for example `session_ended` on a 403, `not_found` on a 404).
- **The mapping** gives the `CoreError`s the fake core raises, so the facade's `call_core` maps both the same way:
  - 403 `session_ended` is `CoreError("forbidden", "session_ended")`, which the facade answers 401 with the cookie cleared, and which closes an open stream after `session_revoked`;
  - 403 `origin_rejected` and `sending_disabled`, 404 `not_found`, 409 `conflict`, 410 `cursor_expired`, 422 `invalid` and `validation_failed`, 429 `rate_limited` and `throttled` (with `retry_after_s`) and 503 `lease_signing_unavailable` keep their code, with the kind from the status;
  - everything else is `core_unavailable` (503 `unavailable`, retryable, cookie kept): 401 `service_unauthorized` (logged at ERROR once when it starts and once when it stops), 503 `core_unavailable`, a status the operation does not declare, a redirect (never followed), a body that is not JSON (nested past the parser's depth included), breaks the schema or is over 8 MiB, a refusal code the status does not declare, a timeout and a connection error;
  - 422 `malformed_request` means the adapter sent a body the contract refuses. That is an adapter bug, never an answer about the caller, so it is logged at ERROR once per operation and answered `core_unavailable`.

  A batch holding a `session_revoked` envelope is `core_unavailable` too: the contract says the core never sends one, and relaying it would sign the user out.

## Fake adapters

[`fakes/`](src/mecon_reader_backend/fakes/) builds an in-memory world from a `worlds.json` description and implements both ports over it: users, fleets, devices, identities, contacts, channels, messages, read marks, the two switches, send attempts, events and their retention, and Ed25519 lease keys that can be rotated and revoked. A lease is signed as `LeaseToken` describes. The fakes exist for the tests and for poking at the API locally. They are not an implementation of the core.

## Run

```sh
cd reader-backend
pip install --require-hashes --no-deps -r requirements-dev.lock
python -m pytest -q                 # Reader API, observation, session lookup and reader-core cases, facade and adapter rules, SQLite store, guards
python scripts/mutation.py          # mutants on the facade's own rules, the observation scope filters, the HTTP lookup and core adapters and the fake core's scoping and idempotency; every one must be killed
PYTHONPATH=src python -m mecon_reader_backend --world ../contracts/reader-api/v1/cases/worlds.json --port 8787 --origin http://127.0.0.1:8787
python scripts/reader_core_schemas.py  # after a change to contracts/reader-core/v1/openapi.yaml: the adapter's copy of its schemas
```

The `--world` command serves the synthetic world on the loopback address only. Logins there are approved out of band, so it is for poking at the API by hand.

To run against a core, pass `--core-url` instead of `--world`. The facade then uses `HttpSessionLookup` and `HttpReaderCore`, both sending the service token from `--token-file`:

```sh
PYTHONPATH=src python -m mecon_reader_backend --core-url http://core.internal:8080 --token-file /run/secrets/reader-service-token \
    --origin https://reader.example.test --trusted-proxy 172.18.0.2 --host 0.0.0.0
```

| Option | Environment | Default |
| --- | --- | --- |
| `--core-url` | `MECON_READER_CORE_URL` | none |
| `--lookup-url` | `MECON_READER_LOOKUP_URL` | the core URL |
| `--token-file` | `MECON_READER_SERVICE_TOKEN_FILE` | none (required with a core URL) |
| `--core-timeout-s` | `MECON_READER_CORE_TIMEOUT_S` | 5 |
| `--events-margin-s` | `MECON_READER_EVENTS_MARGIN_S` | 5 |
| `--lookup-timeout-s` | `MECON_READER_LOOKUP_TIMEOUT_S` | 2 |
| `--host` | `MECON_READER_HOST` | 127.0.0.1 |
| `--origin` | `MECON_READER_ORIGIN` | http://127.0.0.1:8787 |

`--world` wins over `MECON_READER_CORE_URL` when both are set.

The facade's own bounds on a lookup and a core call are set just above the adapters', so an adapter's timeout answers first.

## What CI proves, and what it does not

The `reader-backend` workflow replays every published case from `contracts/reader-api/v1/cases` and `contracts/observations/v1/cases`, read in place and never copied, against this app with the fake adapters (one runner, parameterised by contract). One pytest item runs per case id. A case whose action the implementation cannot express would be skipped as not applicable; none is. The workflow also runs:

- unit tests of the facade's own rules;
- guard tests: the case count equals the files, every operation is exercised, every world action is mapped, and the routes and declared statuses match the OpenAPI;
- a cross-check of the hand-written validators against the OpenAPI schemas;
- a self-test showing that the runner fails a case whose expectation is not met;
- the mutation check.

It also replays every session lookup case from `contracts/session-lookup/v1/cases`, read in place, on two targets. One pytest item runs per case and target. A case that does not apply is skipped with its reason, never counted as passed, and a guard fails if a case is skipped without being listed or listed and then run.

- **`http`**: a stub core ([`tests/stub_core.py`](tests/stub_core.py)) on a loopback socket, which serves the contract over the fake world. Each request is sent raw, as the case writes it, and the answer is checked against the case. Each lookup is then sent through `HttpSessionLookup`, which must send exactly the case's body with the service token and map the answer to the same meaning. With an absent or wrong token, the adapter must answer `core_unavailable` and its feed must end with no item. All 20 cases run here.
- **`fake`**: `FakeSessionLookup` called directly, so the fake the facade's own tests use is known to follow the contract. The three service token cases are not applicable, because the fake has no HTTP surface.

It replays every reader-core case from `contracts/reader-core/v1/cases` the same way, on two targets, in [`tests/test_core_cases.py`](tests/test_core_cases.py):

- **`http`**: a stub core ([`tests/stub_reader_core.py`](tests/stub_reader_core.py)) on a loopback socket, which serves every operation over `FakeReaderCore` in the contract's order of checks (service token, request schema, then the fake's answer). Each request is sent raw, as the case writes it, and the answer is checked against the case. All 49 cases run here.
- **`fake`**: `FakeReaderCore` called directly with the case's arguments and its answer turned into the contract's status and body. The cases about the service token (3) and about a body that breaks the request schema (3) are not applicable, because the fake is a Python port; the other 43 run.
- **`adapter`** ([`tests/test_http_core.py`](tests/test_http_core.py)): the `http` target, and then each request again through `HttpReaderCore` against the same stub, from the world as it was before the raw request. The adapter must send exactly the case's body with the service token, and its answer, turned back into the contract's status and body, must meet the same expectation. With an absent or wrong token it must answer `core_unavailable`, and with an absent one send nothing. A request whose body breaks the request schema is sent raw only, because the port takes typed arguments. All 49 cases run here.

The fake core re-checks the caller reference on every call, as the contract requires: a `Caller` whose session is revoked, expired or another user's gets `CoreError("forbidden", "session_ended")`. The facade answers that as a session that no longer resolves (401, cookie cleared), and an open event stream sends `session_revoked` and closes. The fake answers a send to a foreign or missing identity, or an out-of-scope target, with one `not_found`; the facade answers that 403 `forbidden` (`POST /send-attempts` declares no 404). The core's login calls carry `client_address`: the connection's peer, unless the peer is in `FacadeConfig.trusted_proxies` (addresses or CIDRs, default none), when `X-Forwarded-For` is read from the right past trusted proxies. A core's 429 `rate_limited` reaches the browser as the ordinary 202 on login start and `pending` on a poll. The facade caps each user's concurrent `GET /events` streams at `max_streams_per_user` (5): when the user opens one more, the facade ends that user's oldest stream, cleanly and with no frame, so the newest wins and nothing is refused.

The core adapter's own tests ([`tests/test_http_core.py`](tests/test_http_core.py)) cover:

- every operation's method, path, body and token header;
- every declared refusal and its `CoreError`, refusal codes a status does not carry, `malformed_request` logged once per operation, and `retry_after_s` kept;
- 2xx bodies that break the schema, an undeclared status, a redirect, an oversized answer and a `session_revoked` envelope in a batch;
- a missing, empty or refused token (ERROR once per change), and a token file that changes;
- a core that stalls past the call timeout, and `read_events` bounded by `wait_s` plus the margin;
- the facade over the adapter: a page, a login over the limit answered with the ordinary 202, an outage as 503 with the cookie kept, and a session the core finds ended as 401 with the cookie cleared;
- the copy of the schemas against the document, and the schema check against a real JSON Schema validator on every fixture and broken variants of them;
- the run command wiring both HTTP adapters.

The adapter's own tests ([`tests/test_http_lookup.py`](tests/test_http_lookup.py)) cover:

- every status;
- malformed, oversized and schema-breaking bodies, with the hand-written `Caller` and `Denied` checks cross-checked against the document;
- a redirect, a timeout and a refused connection;
- the request body and the token header, a token file that changes, and no token;
- the feed: comments, unreadable items (unknown types included, cross-checked against `RevocationItem`), split frames, silence past the bound, heartbeats that keep it up, no `subscribed` within its bound and the resolver resubscribing, every non-200 status, malformed items, and the resolver marking it down;
- the refused-token state: ERROR once per change, and `session_lookup` in the health output, which never names a refused token;
- that neither the token nor the cookie value appears in the logs.

This proves the adapters against stubs that serve their contracts, not against a real core. No real core has served these cases to these adapters, so CI does not prove an adapter and a core agree on anything the cases leave open, and it does not prove the adapters' behaviour under real network faults beyond a loopback socket.

The observation cases do not cover a stream's `access_revoked` while open, `resync_required`, the heartbeat or the freshness states; this package's own tests do, but the cases do not pin them for another implementation.

It does **not** prove isolation. The isolation cases (another fleet's devices, contacts, channels, conversations, attempts and events) pass here only because the fake core scopes correctly, and the facade does no scoping at all. The real proof is the core passing the same cases, and later this facade passing them on real adapters. CI also does not prove:

- rate limiting;
- the login mail;
- any real session store;
- anything about deployment.
