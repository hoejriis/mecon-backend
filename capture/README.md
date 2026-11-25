# MECON observation capture

A small headless service that subscribes to MQTT brokers, captures every message it receives, bytes unchanged, and commits the captures to an archive of its own (a SQLite file). It is receive-only and does no parsing.

```
broker(s)  --MQTT 3.1.1, subscribe only-->  ingester  --receive bound, bounded buffer, batches of <= 500-->  archive (SQLite, WAL)
```

It is the public implementation of two published contracts:

- [`contracts/observation-subscription/v1`](../contracts/observation-subscription/v1/README.md): the receive-only subscription profile (draft.2);
- [`contracts/raw-capture/v1`](../contracts/raw-capture/v1/README.md): the raw capture append (draft.3).

**Status.** It passes the fixtures of both contracts and an integration test against a real mosquitto, in its own CI job (`.github/workflows/capture.yml`). Since 2026-11-25 release v0.9.2 has run as a bounded 7-day subscribe-only shadow trial beside the hosted Backend; it is connected and subscribed but has received no observation traffic, so it has not been run against a real feed or measured under load, and there is no parity evidence. Nothing is cut over. Nothing downstream of the archive (parsing, normalization, deduplication) is here.

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
| `archive.max_payload_bytes` | Default 65536. A payload strictly larger is committed as a stub. A capture that arrives as a stub is committed as one whatever its size. |
| `ingester.instance_tag` | Required, 1 to 8 of `[a-z0-9]`. Unique per ingester instance reading the same broker. |
| `ingester.client_id_prefix` | Default `mecon-capture`. The MQTT client id is `<prefix>-<source name>-<instance_tag>`. |
| `ingester.buffer_max` | Default 5000. Captures held in memory; beyond it a capture is lost and counted `shed` (the ingester's count, never the archive's). |
| `ingester.max_receive_bytes` | Default 65536, at least 1. A payload strictly larger is handed on as a stub (size and content hash, no bytes) and counted `oversize`. |
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
- Section 4: payload bytes, topic, source, retained flag and receive time are captured as received; the ingester does not parse payloads. Retained messages are captured and flagged. **The receive bound:** every payload is measured on receipt; one over `max_receive_bytes` is hashed (the archive's content hash: topic UTF-8, a zero byte, payload) and handed on as a stub with its size and hash, counted `oversize`, and its bytes are not kept past the hash. The bound is strict: a payload of exactly `max_receive_bytes` is kept whole. MQTT 5's Maximum Packet Size property, which the profile says a client SHOULD also set, is **not set** by this implementation: it exists only in MQTT 5, and this transport speaks MQTT 3.1.1 only (the protocol version is not switched for it). The receive-side measure is the whole bound here; the broker still sends, and paho still reads, an oversize packet before the measure applies, so this bounds what is held, not what is transferred. **The buffer:** fixed bound (`buffer_max`); a message arriving while it is full is lost and counted `shed` by the ingester. The network thread never waits on the archive.
- Section 5a: the ingester's counters (`ingester.schema.json`): `received` (every message, on arrival), `handed_on` (captures the archive answered `available` for, whether committed or rejected there; added only after that answer), `buffered` and `oldest_buffered_ms` (levels; the latter null when empty), `bound`, `shed` and `oversize`. `received = handed_on + buffered + shed` at every instant: the queue and all counters sit behind one lock, and a capture that arrives oversize and finds the buffer full counts in both `oversize` and `shed`.
- Section 5: status per profile as `status.schema.json`: `last_error` is set only in `error`; `last_connected_at` changes only on a successful connect; `subscribed` and `refused` come from the SUBACK.

**Raw capture**
- Section 1: `received_at` is stamped on the receiving thread at arrival (UTC, milliseconds, truncated), not when the row is written. No deduplication: two receptions are two captures.
- Section 2: each capture is checked against `capture.schema.json`; a malformed one is rejected alone with its index. Beyond the schema's pattern, a `payload_b64` that does not really decode as base64 and a topic with no UTF-8 encoding are malformed too, as is a capture with both or neither of `payload_b64` and `stub`. A payload larger than `max_payload_bytes` is committed as a stub: every field plus the size and the SHA-256 content hash (topic UTF-8, a zero byte, payload), no payload bytes. A capture that arrives as a stub (`stub: {size, content_hash}`, no payload) is committed as a stub row with that size and hash and listed in `stubbed` too; the archive cannot check its hash and does not try, and does no base64 check on it. All the rest of a batch is committed in one transaction (`synchronous=FULL`, WAL), so after an `available` answer it survives a crash.
- Section 3: when the database cannot take the batch (cannot take the write lock, or any error during the transaction) nothing of the batch is committed and the answer is `storage: unavailable`. The ingester keeps the captures in its buffer and retries the same batch id.
- Section 4: counters as `counters.schema.json`, with `received = committed + rejected + buffered + dropped` at every instant. This archive accepts at its commit: `received`, `committed`, `rejected` and `stubbed` are counted together, in one step, after COMMIT has succeeded. A failure before or during the write answers `unavailable` and changes only `unavailable_batches`; `received` never steps back. `buffered` is always 0 and `oldest_buffered_ms` null (the archive is synchronous; the lag before it is the ingester's and shows in its own counters), and `dropped` is the archive's own and stays 0: captures the ingester sheds are the ingester's, and the archive has no way to be told of them.
- Section 5: replayed by the tests: every file in both contracts' fixture directories, dispatched on its `kind`, an unknown kind failing the test (raw capture A to F, subscription A to D). Section 6: the flusher appends about once a second, at most 500 captures per batch, one short write transaction each.

The archive's read method, `Archive.read_committed(after_id, limit)`, returns committed captures in `capture_id` order for a downstream consumer. A stub has `payload` `None`.

## Health

`GET http://127.0.0.1:9470/healthz` returns JSON: `profiles` (one status object per source, `status.schema.json`) and `counters` (the archive's, `counters.schema.json`) and `ingester` (the ingester's, `ingester.schema.json`). The endpoint is read-only and listens on loopback by default.

## Stopping

SIGTERM or SIGINT stops receiving, then flushes the buffer to the archive (up to 10 s) before exit 0.

## Known limits

- **A capture still in the in-memory buffer at a hard stop is lost** (a kill, a crash, a power loss), at most about a second of captures plus anything held while the archive is unavailable. The contract allows this; the counters start at zero with the process, so the loss is not counted. A graceful stop flushes, and gives up (logging the number lost) only if the archive stays unavailable for the whole timeout.
- The receive bound limits what is held, not what is transferred: the library has read an oversize packet before the ingester measures it, and MQTT 5's Maximum Packet Size is not set (see Section 4 above). Up to `buffer_max` captures of at most `max_receive_bytes` each (plus base64 overhead) are held in memory.
- A topic longer than 512 characters fails `capture.schema.json`; the append rejects it as malformed and it is counted `rejected`.
- No per-profile CA file, no reconnect counter, no per-topic refusal reason beyond the SUBACK lists.
- Connection failures show in `last_error` as a class (`network error`, `tls verification failed`), not the library's text.
- A failure before or during the archive's write (including COMMIT) rolls the whole batch back and answers `unavailable`; the archive counts nothing for it, so there is no state to take back. If COMMIT reported an error although the database did commit, the batch would be retried and stored twice; SQLite makes that unlikely but this code does not rule it out.
- One archive file, one writer process. There is no retention or pruning.
- No container image, packaging or production deployment yet.

## Mutation check

`python scripts/mutation.py` first runs the suite on the unmutated tree (it must pass), then applies each mutant (a publish call added, no re-subscribe after a reconnect, `received_at` stamped at write, an oversized payload stored instead of a stub, a partial batch committed on failure, the whole batch rejected for one malformed capture, `received` counted before the commit or not at all, an arrived stub treated as a payload or left out of `stubbed`, the receive bound off, shed captures counted in the archive, `handed_on` counted on an unavailable answer, and others), checks the file really changed, runs the unit tests, requires failures, and restores the file. Integration tests are not part of it.
