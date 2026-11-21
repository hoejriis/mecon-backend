# Raw capture append, version 1 (draft)

How a capture producer (the [observation ingester](../../observation-subscription/v1/README.md), or the device path for eligible reception reports) hands raw messages to the **archive**, and what the archive answers. A raw capture is the message as received: its bytes unchanged, where it came from, when it arrived. Parsing, normalization and deduplication happen downstream, from what the archive has committed.

**Status: draft, version `1.0.0-draft.1`.** The text is derived from a Backend's raw-first capture. Statements marked **(observed)** describe that implementation today and are SHOULD here; section 7 lists where it falls short. The fixtures are synthetic.

| File | What it is |
| --- | --- |
| `README.md` | This contract. |
| `schemas/capture.schema.json` | JSON Schema for one capture. |
| `schemas/append-request.schema.json` | JSON Schema for one append (a bounded batch). |
| `schemas/append-result.schema.json` | JSON Schema for its result. |
| `schemas/counters.schema.json` | JSON Schema for the archive's counters. |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-committed-batch.json` | Fixture A: a batch committed whole, a retained copy among it. |
| `fixtures/B-one-malformed-one-too-large.json` | Fixture B: one malformed and one oversized capture rejected alone; the rest commit. |
| `fixtures/C-storage-unavailable.json` | Fixture C: storage unavailable; nothing committed. |
| `fixtures/D-counters-after-a-b-c.json` | Fixture D: the counters after A, B and C. |
| `fixtures/E-invalid.json` | Fixture E: documents the schemas reject. |

`npm test` in `contracts/` validates every schema and fixture, replays the rules below on fixtures A to D, and fails on a schema or fixture file this README does not reference.

---

## 1. A capture

`schemas/capture.schema.json`. A capture has:
- `source`: the source identity;
- `topic`;
- `payload_b64`: the payload bytes exactly as received;
- `retained`: the broker's stored copy, delivered at subscribe time;
- `received_at`: the receiver's clock at arrival, UTC, with milliseconds.

- `received_at` is stamped **at arrival**, not when the capture is written. **(observed)**
- An observation time that a payload carries is a different thing, read downstream, and never replaces `received_at`.
- A retained capture is stored and flagged, never dropped. Downstream does not treat it as a live observation.
- Two identical receptions are two captures: capture does not deduplicate. **(observed: deduplication happens in normalization, except a short window that skips copies a federation peer already replicated.)**

## 2. An append

`schemas/append-request.schema.json`: a `batch_id` the caller chooses and 1 to 500 captures.

- The archive checks each capture against `capture.schema.json` and against its payload size limit, `max_payload_bytes`.
  - One that fails is **rejected alone**, with its index and a reason: `malformed`, or `too_large` for a payload past the limit.
  - It never fails the batch.
- The rest are committed **together**: after the result says `committed`, they survive a crash.

## 3. The result

`schemas/append-result.schema.json`:
- `storage` is `available`: `committed` + the number of `rejected` entries equals the number of captures, and each rejected index appears once and is inside the batch.
- `storage` is `unavailable`: nothing of the batch was committed (`committed` 0, no rejections). The caller still holds every capture and MAY retry the same batch. That is the backpressure signal: a producer that gets `unavailable` buffers, within its own bound, or counts what it cannot keep.

A producer never learns "committed" for a capture that was not.

## 4. Counters

`schemas/counters.schema.json`, since the archive started:
- `received`: captures the archive took responsibility for, which is every capture of a batch answered `available`. A batch answered `unavailable` stays with the caller and is not counted.
- `committed`, `rejected`.
- `unavailable_batches`.
- `buffered`: received, not yet committed.
- `dropped`: lost without a commit.
- `oldest_buffered_ms`: the lag.

Every received capture is committed, rejected, buffered or dropped: `received = committed + rejected + buffered + dropped`. A conforming archive that never drops reports `dropped` 0.

## 5. The fixtures' rules

The validator checks:
- **A to C:** each result is consistent with section 3, and with its own request: the right `batch_id`, and exactly the captures that fail the schema or the fixture's `max_payload_bytes` rejected, with the right reasons.
- **D:** the counters equal what results A to C add up to under section 4.

## 6. Budgets

Capture bursts must not delay device control or user requests. An archive SHOULD commit within about a second of arrival and hold its write lock briefly per batch (observed: chunks of 100 rows, each one transaction, flushed every second). Measured budgets for a host are set when a block moves, not here.

## 7. Gaps in the observed implementation

- The append is fire-and-forget. The producer learns nothing, and a failed write is logged, not answered.
- A failed chunk is retried row by row. A row that fails again is lost with no counter.
- A full in-memory buffer (5,000 rows) writes through synchronously on the receiving thread instead of answering `unavailable`.
- There is no payload size limit, no counters beyond a total row count, and no lag figure.
- A hard crash loses the in-memory buffer, at most about a second of captures.
