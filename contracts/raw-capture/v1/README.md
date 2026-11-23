# Raw capture append, version 1 (draft)

How a capture producer (the [observation ingester](../../observation-subscription/v1/README.md), or the device path for eligible reception reports) hands raw messages to the **archive**, and what the archive answers. A raw capture is the message as received: its bytes unchanged, where it came from, when it arrived. Parsing, normalization and deduplication happen downstream, from what the archive has committed.

**Status: draft, version `1.0.0-draft.3`.** The text is derived from a Backend's raw-first capture. Statements marked **(observed)** describe that implementation today and are SHOULD here; section 7 lists where it falls short. The fixtures are synthetic.

| File | What it is |
| --- | --- |
| `README.md` | This contract. |
| `schemas/capture.schema.json` | JSON Schema for one capture. |
| `schemas/append-request.schema.json` | JSON Schema for one append (a bounded batch). |
| `schemas/append-result.schema.json` | JSON Schema for its result. |
| `schemas/counters.schema.json` | JSON Schema for the archive's counters. |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-committed-batch.json` | Fixture A: a batch committed whole, a retained copy among it. |
| `fixtures/B-one-malformed-one-oversized.json` | Fixture B: one malformed capture rejected alone, one oversized capture committed as a stub; the rest commit. |
| `fixtures/C-storage-unavailable.json` | Fixture C: storage unavailable; nothing committed. |
| `fixtures/F-arrived-stubbed-and-undecodable.json` | Fixture F: a capture that arrives as a stub is committed as one; a payload that does not decode and a topic with no UTF-8 encoding are rejected alone. |
| `fixtures/D-counters-after-a-b-c.json` | Fixture D: the counters after A, B and C. |
| `fixtures/E-invalid.json` | Fixture E: documents the schemas reject. |

`npm test` in `contracts/` validates every schema and fixture, replays the rules below on fixtures A to D, and fails on a schema or fixture file this README does not reference.

---

## 1. A capture

`schemas/capture.schema.json`. A capture has:
- `source`: the source identity;
- `topic`;
- `payload_b64`: the payload bytes exactly as received; or, from a producer that bounds what it keeps (the [subscription profile](../../observation-subscription/v1/README.md), section 4), `stub`: the size and content hash of a payload over that bound, without its bytes;
- `retained`: the broker's stored copy, delivered at subscribe time;
- `received_at`: the receiver's clock at arrival, UTC, with milliseconds.

- `received_at` is stamped **at arrival**, not when the capture is written. **(observed)**
- An observation time that a payload carries is a different thing, read downstream, and never replaces `received_at`.
- A retained capture is stored and flagged, never dropped. Downstream does not treat it as a live observation.
- Two identical receptions are two captures: capture does not deduplicate. **(observed: deduplication happens in normalization, except a short window that skips copies a federation peer already replicated.)**

## 2. An append

`schemas/append-request.schema.json`: a `batch_id` the caller chooses and 1 to 500 captures.

- The archive checks each capture against `capture.schema.json`, and also that `payload_b64` really decodes as base64 (the pattern alone admits strings that do not) and that `topic` is valid Unicode with a UTF-8 encoding (the content hash needs one).
  - One that fails is **rejected alone**, with its index and the reason `malformed`.
  - It never fails the batch.
- A valid capture whose payload is larger than the archive's limit, `max_payload_bytes`, is **committed as a stub**: every field of the capture, the payload's size and its content hash, but not its bytes.
  - The content hash is SHA-256, as lowercase hex, over the topic's UTF-8 bytes, one zero byte, then the decoded payload bytes. It is the same function an archive uses for every capture, so a stub and a full copy of the same message hash alike.
  - The message is still recorded as received; only its body is not kept.
  - Its index is listed in `stubbed`, and it counts in `committed`.
  - Downstream never parses a stub.
- A capture that arrives as a stub (its producer kept only its size and hash) is committed as a stub as it is, and listed in `stubbed` too. The archive cannot check its hash and does not try.
- The rest are committed **together**, stubs included: after the result says `committed`, they survive a crash.

## 3. The result

`schemas/append-result.schema.json`:
- `storage` is `available`:
  - `committed` + the number of `rejected` entries equals the number of captures;
  - each rejected index appears once and is inside the batch;
  - each `stubbed` index appears once, is inside the batch and is not rejected.
- `storage` is `unavailable`: nothing of the batch was committed (`committed` 0, no rejections, no stubs). The caller still holds every capture and MAY retry the same batch. That is the backpressure signal: a producer that gets `unavailable` buffers, within its own bound, or counts what it cannot keep.

A producer never learns "committed" for a capture that was not.

## 4. Counters

`schemas/counters.schema.json`. These are totals since the archive started, except `buffered`, which is a level:
- **Acceptance** is the moment the archive can no longer answer `unavailable`. For an archive that writes the batch before it answers, that is its commit.
- `received`: counted at acceptance, so every capture of every batch the archive accepts is counted, and never taken back.
  - An append the archive cannot take (storage unavailable, before or during its write) is answered `unavailable`, is never accepted, and stays with the caller: it counts in `unavailable_batches`, not in `received`.
- `committed`, `rejected` and `stubbed`: counted when the archive answers `available` for the batch. An archive that accepts at its commit counts all four in one step.
- `stubbed`: of `committed`, the captures stored as a stub. It is never more than `committed`.
- `buffered`: **the number** of captures accepted and not yet answered, at this instant. It rises at acceptance and falls at the answer. An archive that accepts at its commit reports 0: the lag before it belongs to its producer, which reports its own.
- `dropped`: captures the archive accepted and then lost while it kept running, for example by an archive that sheds its own buffer under pressure. A conforming archive that never drops reports `dropped` 0. Captures a producer sheds from its own buffer are the producer's to count (section 3), never the archive's, so two producers' losses never mix.
- `oldest_buffered_ms`: how long the oldest buffered capture has waited, which is the lag. It is null when nothing is buffered.

At **every instant**, `received = committed + rejected + buffered + dropped`.

Counters start at zero with the archive, so a crash's loss is never counted in them. A capture lost to a crash was accepted but never answered, and the producer sees that as an append with no result, which it treats like `unavailable`: it still holds the batch.

## 5. The fixtures' rules

The validator checks:
- **A to C and F:** each result is consistent with section 3, and with its own request: the right `batch_id`, exactly the captures that fail the schema or the checks of section 2 rejected as `malformed`, and exactly the valid captures that arrived as a stub or are past the fixture's `max_payload_bytes` listed in `stubbed`.
- **D:** the counters after A to C have all been answered (nothing in flight, so `buffered` 0) equal what their results add up to under section 4, and the identity holds.

## 6. Budgets

Capture bursts must not delay device control or user requests. An archive SHOULD commit within about a second of arrival and hold its write lock briefly per batch (observed: chunks of 100 rows, each one transaction, flushed every second). Measured budgets for a host are set when a block moves, not here.

## 7. Gaps in the observed implementation

- The append is fire-and-forget. The producer learns nothing, and a failed write is logged, not answered.
- A failed chunk is retried row by row. A row that fails again is lost with no counter.
- A full in-memory buffer (5,000 rows) writes through synchronously on the receiving thread instead of answering `unavailable`.
- There is no payload size limit, no counters beyond a total row count, and no lag figure.
- A hard crash loses the in-memory buffer, at most about a second of captures.
