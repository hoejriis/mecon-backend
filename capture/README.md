# MECON observation capture

A small headless service that subscribes to MQTT brokers, captures every message it receives, bytes unchanged, and commits the captures to an archive of its own (a SQLite file). It is receive-only and does no parsing.

```
broker(s)  --MQTT 3.1.1, subscribe only-->  ingester  --bounded buffer, batches of <= 500-->  archive (SQLite, WAL)
```

It is the public implementation of two published contracts:

- [`contracts/observation-subscription/v1`](../contracts/observation-subscription/v1/README.md): the receive-only subscription profile (draft.1);
- [`contracts/raw-capture/v1`](../contracts/raw-capture/v1/README.md): the raw capture append (draft.2).

**Status.** It passes the fixtures of both contracts and an integration test against a real mosquitto, in its own CI job (`.github/workflows/capture.yml`). It has not been deployed anywhere, run against a real feed, or measured under load. Nothing downstream of the archive (parsing, normalization, deduplication) is here.

## Run

```sh
cd capture
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements.lock && pip install --no-deps .
cp config.example.toml config.toml && $EDITOR config.toml
mecon-capture --check-config --config config.toml
OBSERVER_USERNAME=... OBSERVER_PASSWORD=... mecon-capture --config config.toml
```

Python 3.11 or newer. One runtime dependency, `paho-mqtt` (pinned); the archive is the standard library's `sqlite3`.

Tests: `pip install --require-hashes --no-deps -r requirements-dev.lock && python -m pytest -q`. The integration tests (marked `integration`) start their own mosquitto on a free port and are skipped, with a stated reason, when no `mosquitto` binary is on `PATH`. `python scripts/mutation.py` breaks each safety rule in the source in turn and requires the unit tests to fail (see [Mutation check](#mutation-check)).

## Configuration

One TOML file, validated at start; every problem is listed and the process exits with status 2. [`config.example.toml`](config.example.toml) is annotated.

| Setting | Rule |
| --- | --- |
| `archive.path` | Required. The SQLite file; created if absent. |
| `archive.max_payload_bytes` | Default 65536. A payload strictly larger is committed as a stub. |
| `ingester.instance_tag` | Required, 1 to 8 of `[a-z0-9]`. Unique per ingester instance reading the same broker. |
| `ingester.client_id_prefix` | Default `mecon-capture`. The MQTT client id is `<prefix>-<source name>-<instance_tag>`. |
| `ingester.buffer_max` | Default 5000. Captures held in memory; beyond it a capture is counted `dropped`. |
| `ingester.batch_max` | Default and maximum 500. |
| `ingester.flush_interval_s` | Default 1.0. |
| `health.enabled`, `bind`, `port` | Default on, `127.0.0.1`, 9470. |
| `log.level` | `debug`, `info`, `warn`, `error`. |
| `[[profile]]` | One per source, exactly as `profile.schema.json`: `name`, `host`, `port`, `transport` (`tcp` or `websockets`), `ws_path` (websockets only), `tls = { enabled, verify = true }`, `topics`, optional `qos = 0`, optional `credential = { username_ref, password_ref }`, `adapter`. An unknown field, a `verify` that is not `true`, a `qos` above 0, a credential value or a publish topic is refused with a reason. |

**Credentials are environment variable names, never values.** The variables are read when the ingester connects (and again before each reconnect attempt). A variable that is not set stops startup with status 2. Values are never logged; log lines never carry payloads.

## What it guarantees

Per section of the contracts.

**Subscription profile**
- Section 2: profiles are checked against the schema's rules in code. Certificate verification cannot be turned off; there is no setting for a topic to publish to.
- Section 3.1: unique client id per instance and source. 3.2: a clean session. 3.3: on every successful connect, including each reconnect, one QoS 0 subscribe per topic. 3.4: no publish path exists; the transport interface has no publish, and tests (an AST scan of the source and a stand-in client that fails on a publish call) and the mutation script check it. 3.5: a topic the broker refuses in its SUBACK is reported in `refused`, and no other topic is substituted. 3.6: reconnect backoff starts at 1 s and doubles to a 120 s cap (paho's own mechanism, configured).
- Section 4: payload bytes, topic, source, retained flag and receive time are captured as received; the ingester does not parse payloads. Retained messages are captured and flagged.
- Section 5: status per profile as `status.schema.json`: `last_error` is set only in `error`; `last_connected_at` changes only on a successful connect; `subscribed` and `refused` come from the SUBACK.

**Raw capture**
- Section 1: `received_at` is stamped on the receiving thread at arrival (UTC, milliseconds, truncated), not when the row is written. No deduplication: two receptions are two captures.
- Section 2: each capture is checked against `capture.schema.json`; a malformed one is rejected alone with its index. A payload larger than `max_payload_bytes` is committed as a stub: every field plus the size and the SHA-256 content hash (topic UTF-8, a zero byte, payload), no payload bytes. All the rest of a batch is committed in one transaction (`synchronous=FULL`, WAL), so after an `available` answer it survives a crash.
- Section 3: when the database cannot take the batch (cannot take the write lock, or any error during the transaction) nothing of the batch is committed and the answer is `storage: unavailable`. The ingester keeps the captures in its buffer and retries the same batch id.
- Section 4: counters as `counters.schema.json`, with `received = committed + rejected + buffered + dropped` at every instant. A capture counts as received when its append is accepted; an append answered `unavailable` counts only in `unavailable_batches`. A capture the ingester sheds because its buffer is full counts as received and dropped.
- Section 5: replayed by the tests (fixtures A to E). Section 6: the flusher appends about once a second, at most 500 captures per batch, one short write transaction each.

The archive's read method, `Archive.read_committed(after_id, limit)`, returns committed captures in `capture_id` order for a downstream consumer. A stub has `payload` `None`.

## Health

`GET http://127.0.0.1:9470/healthz` returns JSON: `profiles` (one status object per source, `status.schema.json`) and `counters` (`counters.schema.json`). The endpoint is read-only and listens on loopback by default.

## Stopping

SIGTERM or SIGINT stops receiving, then flushes the buffer to the archive (up to 10 s) before exit 0.

## Known limits

- **A capture still in the in-memory buffer at a hard stop is lost** (a kill, a crash, a power loss), at most about a second of captures plus anything held while the archive is unavailable. The contract allows this; the counters start at zero with the process, so the loss is not counted. A graceful stop flushes, and gives up (logging the number lost) only if the archive stays unavailable for the whole timeout.
- A message is held whole in memory until it is flushed. There is no receive-side size bound: a very large message from a broker is held in full (and then stored as a stub). The contract names such a bound and says it is not yet set.
- A topic longer than 512 characters fails `capture.schema.json`; the append rejects it as malformed and it is counted `rejected`.
- No per-profile CA file, no reconnect counter, no per-topic refusal reason beyond the SUBACK lists.
- Connection failures show in `last_error` as a class (`network error`, `tls verification failed`), not the library's text.
- A failure after the batch was accepted but before commit (a write error mid-transaction) rolls the whole batch back and reverses its acceptance in the counters, so `received` can fall back by one batch at that instant. It never shows a state that breaks the identity.
- One archive file, one writer process. There is no retention or pruning.
- No container image, packaging or production deployment yet.

## Mutation check

`python scripts/mutation.py` first runs the suite on the unmutated tree (it must pass), then applies each mutant (a publish call added, no re-subscribe after a reconnect, `received_at` stamped at write, an oversized payload stored instead of a stub, a partial batch committed on failure, the whole batch rejected for one malformed capture, `received` counted before acceptance, a full buffer not counted as dropped, and others), checks the file really changed, runs the unit tests, requires failures, and restores the file. Integration tests are not part of it.
