# MECON observation processing

A small headless service that reads the captures a [capture archive](../capture/README.md) has committed and turns them into deduplicated packets, one reception per observer hearing, and hourly aggregates that can be rebuilt from those receptions. It reads the archive read-only and writes a SQLite store of its own.

```
capture archive (SQLite, read-only)  --pending captures, capture_id order, batches <= 500-->  processor  --one transaction per batch-->  store (SQLite, WAL)
```

It is the public implementation of [`contracts/observation-processing/v1`](../contracts/observation-processing/v1/README.md) (version `1.0.0-draft.1`).

**Status.** It replays all five published fixtures (A to E) in its own CI job (`.github/workflows/processing.yml`), with unit tests and a mutation check. It has not been deployed, run against a live feed, or measured under load; the private reference replay of its contract is merged. Observer records, decryption and contact records from adverts are outside the contract and not here.

## Run

```sh
cd processing
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements.lock && pip install --no-deps .
cp config.example.toml config.toml && $EDITOR config.toml
mecon-processing --check-config --config config.toml
mecon-processing --config config.toml          # loops, picking up new captures every few seconds
mecon-processing --config config.toml --once   # processes what is pending, then exits
```

Python 3.11 or newer; no runtime dependencies (the standard library's `sqlite3`, `json`, `hashlib`).

Tests: `pip install --require-hashes --no-deps -r requirements-dev.lock && python -m pytest -q`, then `python scripts/mutation.py` (see [Mutation check](#mutation-check)).

## Configuration

One TOML file, validated at start; every problem is listed and the process exits with status 2. [`config.example.toml`](config.example.toml) is annotated.

| Setting | Rule |
| --- | --- |
| `archive.path` | Required. The capture archive's SQLite file, opened read-only; it must exist. |
| `store.path` | Required. This processor's own file; created if absent. |
| `processor.batch_max` | Default and maximum 500. |
| `processor.interval_s` | Default 3.0. The wait when nothing is pending. |
| `health.enabled`, `bind`, `port` | Default on, `127.0.0.1`, 9471. |
| `log.level` | `debug`, `info`, `warn`, `error`. |
| `[sources.<name>]` | One per source, named as the capture profile's `name`; `adapter` is `observer_envelope` or `raw_hex`. An unknown adapter, an unknown field or no source at all is a configuration error: there is no fallback adapter. |

## What it guarantees

Per section of the contract.

- **Section 1, input.** The input is `Archive.read_committed()`'s shape: committed captures in `capture_id` order, a stub with no payload. `validate_committed` and `from_document` check a committed-capture document by hand against `committed-capture.schema.json`; the tests check them against the schema and the invalid fixture.
- **Section 2, payload formats.** `adapters.py`: both formats as written, including the observer rules, packet topics, `direction: "tx"`, the first present of `data`, `raw_data`, `raw` (a present but unusable one is `malformed`, never passed over), an empty hex string as zero bytes (later `unparseable`), the case-insensitive origin check, `RSSI`/`rssi` and `SNR`/`snr` with the stated number grammar, an RSSI of exactly 0 as null, and device time trusted only from 2025-01-01T00:00:00Z to `received_at` plus 60 s, truncated, never a boolean. A number that is not finite reads as null.
- **Section 3, framing and identity.** `framing.py`: route and payload type bits, transport codes for route types 0 and 3, the path byte with hash mode 3 refused, a path of at most 64 bytes, a payload of 1 to 184 bytes; the identity is the first 16 uppercase hex digits of SHA-256 over the payload type byte, for TRACE the path byte as two bytes little-endian, and the payload.
- **Section 4, processing.** One outcome per capture, with the reasons checked in the table's order (stub, retained, then the adapter's `not_a_packet` and `malformed`, `origin_mismatch`, `unparseable`, `duplicate_report`); an unexpected error in analysing one capture is `failed`, logged by class only, and not retried. A capture whose data the store refuses (an integrity or data error) is `failed` the same way: the batch is re-run capture by capture, so only that one is. A storage error (`OperationalError`) leaves the whole batch pending and it is retried. **A capture from a source with no configured adapter stops processing before it:** it and everything after it stay pending, `source_not_configured` is logged, and fixing the configuration recovers them. The packet is recorded as seen before the duplicate check, so a duplicate report still raises `last_seen_at` (never lowers it); a packet's other fields come from its first reception. Receptions are never merged. A duplicate report needs a trusted device time and an earlier reception with the same packet, source, observer, device time, RSSI and SNR (null equals null). **A batch is one transaction:** outcomes, packets, receptions, aggregates and the progress mark commit together or not at all; a crash leaves nothing of the batch, and the same captures are pending again. `receptions.capture_id` is UNIQUE and a capture that already has an outcome is left alone, so handing it the same captures again changes nothing, even with the progress mark cleared by hand.
- **Section 5, hourly aggregates.** Kept incrementally in the batch's transaction per source, observer and UTC hour of `received_at`; receptions with no observer are not folded. `Store.rebuild_hours()` recomputes them from the receptions alone, and the tests require it to equal the incremental result after every fixture and after the aggregate has been damaged by hand.
- **Section 6, counters.** `processed` = `receptions` + the sum of `skipped`, counted only after a batch commits; `pending` and `oldest_pending_ms` are read from the input side (the archive) against the progress mark. Served at `GET /healthz` as `counters`, validated against `counters.schema.json` in the tests.
- **Section 8, budgets.** Batches are at most 500 captures and one short write transaction each. There is no adaptive chunk sizing and no measured budget.

## Health

`GET http://127.0.0.1:9471/healthz` returns JSON `{"counters": {...}, "progress": <last capture_id processed>}`. Read-only, loopback by default.

## Stopping

SIGTERM or SIGINT stops the loop after the batch in flight has committed (or rolled back), then exits 0.

## Tests

`python -m pytest -q` runs:
- **Every fixture file** in `contracts/observation-processing/v1/fixtures/`, dispatched on `kind`; an unknown kind fails. Process fixtures A to C go through the real processor and store (`steps`: `take` n pending captures; `crash: true` makes the batch's transaction fail after its writes and before the commit through an injected fault, and the test checks the store is untouched) and are compared with `expect` exactly. Fixture D is compared with the counters after A and B. Fixture E's cases are rejected by their schemas and, for committed captures, by the processor's own validation.
- Rebuild equals incremental, idempotence by `capture_id`, edge cases of each rule, configuration, the command line and the loop (a subprocess with a health check and a graceful stop), and a capture read from a real `capture/` archive file end to end.

### Mutation check

`python scripts/mutation.py` breaks each rule in the source in turn (TRACE's path byte left out of the identity, the route in the identity, oversize payloads and the reserved hash mode accepted, RSSI 0 kept, a widened device-time window, a case-sensitive origin check, own transmissions not filtered, each part of the duplicate rule dropped, the packet seen only after the duplicate check, retained before stub, progress committed apart from its output, `capture_id` uniqueness dropped, null observers folded, a rebuild that differs from the incremental result, an unknown adapter defaulting, and more) and requires the tests to fail. A control run of the unmutated tree comes first; every edit is checked to have changed its file and is restored and compared afterwards.

## Known limits

- Numbers: a numeric string is read with `float`, so a string that overflows (`1e999`) reads as null, as does any non-finite number. Whitespace around a numeric string is ASCII whitespace.
- The duplicate check reads the store for earlier receptions of the packet (indexed by packet and source); it is not measured under load.
- One processor per store file; the store is not meant to be shared.
- The input is a single archive file; there is no multi-archive merge. A source with no configured adapter holds up everything after it until it is configured.
- No packet or reception retention, pruning, or export; no reads API. Those belong to other contracts.
