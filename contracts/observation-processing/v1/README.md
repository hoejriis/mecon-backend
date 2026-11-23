# Observation processing, version 1 (draft)

How the **observation processor** turns captures the archive has committed (see [raw capture append](../../raw-capture/v1/README.md)) into deduplicated packets, one reception per observer hearing, and hourly aggregates that can be rebuilt from those receptions. It reads committed captures only, and never changes them.

**Status: draft, version `1.0.0-draft.1`.** The text is derived from a Backend's normalization of raw captures. Statements marked **(observed)** describe that implementation today and are SHOULD here; section 9 lists where it falls short. The fixtures are synthetic. Observer records (names, locations, last heard), decryption and contact records from adverts are downstream of this contract and outside it.

| File | What it is |
| --- | --- |
| `README.md` | This contract. |
| `schemas/committed-capture.schema.json` | JSON Schema for one committed capture, the processor's input. |
| `schemas/outcome.schema.json` | JSON Schema for what processing made of one capture. |
| `schemas/packet.schema.json` | JSON Schema for one deduplicated packet. |
| `schemas/reception.schema.json` | JSON Schema for one reception. |
| `schemas/hour.schema.json` | JSON Schema for one observer-hour aggregate. |
| `schemas/counters.schema.json` | JSON Schema for the processor's counters. |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-one-batch.json` | Fixture A: one batch with two receptions of one packet, every way a capture is skipped, and both payload formats. |
| `fixtures/B-repeats-and-identity.json` | Fixture B: a repeated report, separate receptions, TRACE identity and an hour boundary. |
| `fixtures/C-crash-and-replay.json` | Fixture C: a crash mid-run loses nothing and duplicates nothing. |
| `fixtures/D-counters-after-a-b.json` | Fixture D: the counters after A and B. |
| `fixtures/E-invalid.json` | Fixture E: documents the schemas reject. |

`npm test` in `contracts/` validates every schema and fixture. It replays fixtures A to C through `observation-processing-reference.mjs`, a reference processor written from this README. It checks D against what A and B add up to, and fails on a schema or fixture file this README does not reference. `scripts/gen-observation-processing-fixtures.mjs` regenerates the fixtures' expected outputs from their captures. A changed expectation is reviewed by hand, and a second implementation replaying the same fixtures is what checks the reference.

---

## 1. Input

`schemas/committed-capture.schema.json`: a capture the archive has committed, with `capture_id`, the archive's commit sequence (unique, increasing in commit order). A stub carries its `size` and `content_hash` instead of `payload_b64`.

Each capture's `source` names a source whose payload format, its `adapter`, was validated when the source was set up (see the [subscription profile](../../observation-subscription/v1/README.md)). A fixture lists its sources and their adapters under `sources`.

## 2. Payload formats

The adapter decides the observer and extracts the packet bytes and signal readings. Two formats exist.

**`observer_envelope`:**
- **Observer:** the topic's second-to-last `/` segment, when the topic has at least 4 segments and that segment is not empty; otherwise none.
- **Packet traffic only:** a topic not ending in `/packets` or `/raw` is `not_a_packet`. This covers status and neighbour messages.
- **The envelope:** the payload must be a JSON object; otherwise `malformed`.
- **Own transmissions:** an envelope with `direction` `"tx"` is the observer's own transmission, so `not_a_packet`.
- **Packet bytes:** the first present of `data`, `raw_data` and `raw` must be a string of hex digits in pairs; otherwise `malformed`. A present but unusable field is not passed over for a later one. An empty string is a well-formed envelope carrying zero packet bytes, so the capture is `unparseable` (section 3), not `malformed`.
- **Origin check:** when `origin_id` is a string that is not blank and the topic names an observer, the two must match, ignoring case and surrounding whitespace. A blank `origin_id` (empty or whitespace only) claims nothing. Otherwise the capture is `origin_mismatch`: it claims another observer's reception.
- **Signal readings:** `rssi` is `RSSI` if present, else `rssi`; `snr` is `SNR` if present, else `snr`.
  - Each is a JSON number, or a string holding one: an optional sign, digits with an optional fraction (or a fraction alone), an optional exponent, surrounding whitespace ignored. Anything else, and any value too large to be a finite number, reads as null.
  - An RSSI of exactly 0 means "not measured" and reads as null. SNR 0 is a reading.
- **Device time:** `device_observed_at` is `ts`, epoch seconds (a number or a numeric string, truncated to whole seconds; never a boolean). It is kept only when trusted: no earlier than 2025-01-01T00:00:00Z, and no later than the capture's `received_at` plus 60 seconds. Otherwise it is null, because an unsynchronised or forward-skewed clock is not corrected, only not trusted.

**`raw_hex`:**
- **Observer:** the topic's last segment, when the topic has at least 2 segments and that segment is not empty.
- **Packet bytes:** the payload is ASCII hex text, surrounding whitespace removed. Empty, non-ASCII or non-hex text is `malformed`: with no envelope, an empty payload is not a packet format at all.
- **No readings:** `rssi`, `snr` and `device_observed_at` are null.

A reception's `received_at` is always the capture's own, never the device time.

## 3. Packet framing and identity

The packet bytes follow the MeshCore wire framing:
- a header byte: route type in bits 0–1, payload type in bits 2–5, payload version in bits 6–7;
- for route types 0 and 3 (transport routes), four bytes of transport codes;
- a path byte: hop count in bits 0–5, hash mode in bits 6–7 (hash size = mode + 1; mode 3 is reserved);
- the path itself, hop count × hash size bytes, at most 64;
- the payload, 1 to 184 bytes (the firmware's own payload limit).

Bytes that are truncated anywhere, use hash mode 3, carry a path over 64 bytes or a payload over 184 bytes are `unparseable`: MeshCore firmware refuses each of them.

**Packet identity**, `packet_id`, is the first 16 hex digits, uppercase, of SHA-256 over:
- the payload type, as one byte;
- for TRACE (payload type 9) only, the path byte as two bytes, little-endian;
- the payload.

The route type, transport codes and path are not part of it. The same packet relayed along different paths, or heard by different observers, has one identity. This is the identity MeshCore firmware itself uses. `packet_type` is the payload type's name, or `UNKNOWN_0x` and two lowercase hex digits for a type with no name.

## 4. Processing

**Batches.** The processor takes pending captures, those committed and not yet processed, in `capture_id` order, in bounded batches of at most 500. **(observed: 500 per batch, every 10 seconds, within a few seconds' budget per run.)**

**One outcome per capture** (`schemas/outcome.schema.json`). Every committed capture is eventually processed exactly once, to a `reception` or to `skipped` with one reason:

| Reason | When |
| --- | --- |
| `stub` | The capture is a stub. Checked first: a stub is never parsed. |
| `retained` | The broker's retained copy. It may be old, so it is never live evidence. |
| `not_a_packet` | Not packet traffic (section 2). |
| `malformed` | The payload is not in its format (section 2). |
| `origin_mismatch` | The envelope names another observer (section 2). |
| `unparseable` | The packet bytes do not frame (section 3). |
| `duplicate_report` | The same reception, reported again (below). |
| `failed` | An unexpected error. The capture is not retried. |

**Packets.** A reception's packet is recorded by its identity. The first reception of a packet, in capture order, sets `first_seen_at` to its `received_at`. Any later capture with the same packet that reaches the duplicate check raises `last_seen_at` to its `received_at` if that is later, and never lowers it. The packet's other fields come from its first reception and are never rewritten.

**Separate receptions.** Each capture that becomes a reception gives exactly one reception (`schemas/reception.schema.json`), carrying its own `capture_id`, observer, readings, `hop_count` and `route_type`. Receptions of one packet are never merged:
- not across observers;
- not across sources;
- not when one observer hears a packet again, for example a flood retransmission.

**Duplicate reports.** A capture is the same reception reported twice, and so `duplicate_report`, only when all of these hold:
- it has a trusted `device_observed_at`;
- an earlier reception has the same packet, source and observer;
- that reception has the same `device_observed_at`, `rssi` and `snr`, where null equals null.

The packet is still recorded as seen first. Without a device time there is no fact to tell a repeat from a second hearing, so every such capture is a reception. The processor fails toward keeping data.

**Progress commits with its output.** A batch's outcomes, packets, receptions and progress commit together, or none of them do. After a crash, the captures of an uncommitted batch are pending again, and processing them again gives exactly the state one uninterrupted pass would have. A conforming processor achieves this in one of two ways:
- by committing a batch atomically;
- by making every write of the batch idempotent by key: the packet by its identity, the reception by its `capture_id`.

## 5. Hourly aggregates

`schemas/hour.schema.json`: per source, observer and UTC hour of `received_at`:
- the number of receptions;
- the sum and count of the non-null `rssi` readings;
- the sum and count of the non-null `snr` readings.

Receptions with no observer are not folded.

The aggregate is a fold over receptions, and nothing else. An aggregate updated incrementally MUST equal a fold over all receptions, so a rebuild from receptions alone gives the same rows. **(observed: updated by a separate pass after processing, from a reception watermark that commits with the update.)**

## 6. Counters

`schemas/counters.schema.json`. These are totals since the processor started, except two levels:
- `pending`: committed captures not yet processed;
- `oldest_pending_ms`: how long the oldest of them has waited since its `received_at`, which is the processing lag; null when nothing is pending.

`processed` = `receptions` + the sum of `skipped`, at every instant. Counters start at zero with the processor. A crashed batch was never committed, so it was never counted.

## 7. The fixtures' rules

The validator checks:
- **A to C:**
  - every document against its schema;
  - one outcome per capture;
  - at most one reception per capture, and exactly for the `reception` outcomes;
  - every reception's packet present, with `first_seen_at` that of its first reception and `last_seen_at` no earlier than any;
  - the hours equal to the fold of the receptions.
  - It then replays the captures through the reference processor, and the result must equal `expect` exactly.
- **C:** each of its `steps` takes up to `take` pending captures, and a step with `crash` commits nothing. The replay must also equal one uninterrupted pass.
- **D:** the counters equal what the outcomes of A and B add up to.
- **E:** each case fails its schema.

A Backend replaying these fixtures processes each fixture's captures in its own storage. Output lists are compared in the order the fixtures use: outcomes and receptions by `capture_id`, packets by `packet_id`, hours by source, observer and hour.

## 8. Budgets

Processing must not delay capture, device control or user requests. A processor SHOULD keep each commit's hold on shared storage brief, and size its work by the time it measures **(observed: chunks that shrink when a commit holds its lock longer than a target, and grow back while fast)**. Measured budgets for a host are set when a block moves, not here.

## 9. Gaps in the observed implementation

- **Two commits, not one.** Where receptions live in a separate database file, the packets commit first, and the receptions with the progress marks second. A crash between the two re-derives the packets by identity, which is safe. One daily hearing count kept beside the packets is counted again.
- **No `capture_id` on a reception.** Re-running already processed captures, which no tool offers but clearing the marks by hand would do, duplicates every reception without a device time.
- **Failures and skips are not counted.** A failed capture is marked processed and logged. Skips are logged, some not at all, and there are no counters or lag figure.
- **No rebuild.** The hourly aggregate cannot be rebuilt: it is only folded forward from its watermark.
- **Looser inputs.** Hex with whitespace between bytes, and number strings beyond the grammar in section 2 (digit separators, infinities), are accepted. A payload over 184 bytes is taken as a reception.
- **Unknown adapters.** A source naming an unknown adapter is processed as `observer_envelope` with a warning, not refused.
- **Two aggregates.** There is a second hourly aggregate keyed by source alone.
