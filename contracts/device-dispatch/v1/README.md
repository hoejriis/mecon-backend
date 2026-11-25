# Device dispatch, version 1 (draft)

How the Backend turns a request into a **typed command** for one device, which separate facts it keeps about each **attempt** to run it, when a device's answer counts, and why an uncertain attempt is never repeated by a different route. The job that wraps a command (its state, claim, restart and cancellation) is the [job lifecycle](../../job-lifecycle/v1/README.md) contract; this one is what that contract signs, sends and reads back.

**Status: draft, version `1.0.0-draft.1`.** The catalogue is a synthetic subset: it fixes the shape of an entry and the rules around it, and a real catalogue adds ops by pull request. The fixtures are synthetic: no real device, key, host or user appears in them. Signing, key custody and the wire encoding of a command are outside this contract: an attempt's signed bytes are an opaque value here.

| File | What it is |
| --- | --- |
| `README.md` | This contract. |
| `schemas/catalogue.json` | The catalogue: each op with a JSON Schema for its args, the roles it applies to, whether it changes state, and whether it is internal. |
| `schemas/command.schema.json` | JSON Schema for a command: an op and its args. |
| `schemas/result.schema.json` | JSON Schema for a device result as the Backend receives it. |
| `schemas/dispositions.schema.json` | JSON Schema for the dispositions of one attempt. |
| `schemas/origin-state.schema.json` | JSON Schema for the origin scheduling state after one step. |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/I-dispositions.json` | Fixture I: dispositions kept distinct: broker acceptance, duty hold, transmission, a native ACK on a direct message and never on a channel message. |
| `fixtures/J-typed-commands.json` | Fixture J: every catalogue op accepted, and invalid commands refused before anything is signed. |
| `fixtures/K-invalid.json` | Fixture K: documents the schemas reject. |
| `fixtures/L-origins.json` | Fixture L: the origin rules for a multi-gateway send. |

`npm test` in `contracts/` validates the catalogue, every schema and every fixture. It replays I, J and L through `device-dispatch-reference.mjs`, a reference model written from this README, and compares each step's expected output exactly. It fails when a fixture file or schema is not referenced here, when a fixture names another version than this one, and when no fixture covers a catalogue op, a step kind, a command refusal reason or an origin result. `scripts/gen-job-dispatch-fixtures.mjs` regenerates the expected outputs of the scripted fixtures; a changed expectation is reviewed by hand, and a second implementation replaying the same fixtures is what checks the reference.

Fixture letters are per contract. The job lifecycle contract has its own fixtures A to H and K.

---

## 1. Typed commands

There is no door for "send any op". A command is `{ "op": ..., "args": {...} }` (`schemas/command.schema.json`), and it is valid only when the catalogue says so. `schemas/catalogue.json` lists each op once, with:
- `roles`: the device roles the op applies to (`companion`, `repeater`);
- `changes_state`: whether running it changes the device;
- `internal`: whether only the Backend may request it;
- `args`: a closed JSON Schema (`additionalProperties` is false, required args are listed).

The synthetic catalogue holds `contact.put`, `contact.remove`, `message.send`, `packet.transmit`, `config.apply`, `job.cancel` and `job.get`. The last two are internal: the Backend signs them to manage a job it already has, and a caller cannot request them.

A command is checked **before anything is signed**, against the device's role. The first failing check names the reason, and the reasons are checked in this order:

| Reason | When |
| --- | --- |
| `unknown_op` | The command is not an object, or its `op` is not a string the catalogue lists. |
| `internal_op` | The op is internal and the request does not come from the Backend. |
| `wrong_role` | The op is known but not for this device's role. |
| `invalid_args` | `args` is missing, has an extra or missing field, or breaks the op's schema; or the command has a key besides `op` and `args`. |

A refused command is `invalid` at the job lifecycle's create, and nothing is created, signed or sent. The reason is for the Backend's own use: an error body never says which check failed.

## 2. Dispositions

`schemas/dispositions.schema.json`. Each attempt has five dispositions. Each has its own timestamp, or is null, and **none implies another**:

| Disposition | Set when |
| --- | --- |
| `signed` | The attempt's bytes were signed and stored. |
| `transport_accepted` | A transport took a delivery: the broker accepted the publish, or a hold relay took it. Never set before `signed`. |
| `device_answered` | The device answered. It holds the device's status string and when it arrived, and is replaced by each later answer. |
| `rf_transmitted` | The device reported transmitting: a count, and the first and last time. Each `transmitted` answer adds its `rf_count`, 1 when absent. |
| `native_ack` | A direct message was acknowledged natively by its recipient: only ever for `message.send` with `kind` `direct`, and never for a channel message. Set once. |

**Broker acceptance is never a device result.** `transport_accepted` says a message was handed over, and nothing about the device. A device that never answers has a null `device_answered` however many publishes the broker accepted.

A set `signed`, `transport_accepted` or `native_ack` never changes, and `rf_transmitted` only grows.

## 3. Results and correlation

`schemas/result.schema.json`. A device result carries `signed_by` (the device whose signature verified, or null when none does), the `request_id` and `job_number` it answers, and a `status`.

**A result is applied to an attempt only when** it is signed by the attempt's own device, and names that attempt's request id and the job number the attempt carries for that device. Anything else is **ignored and counted** (`ignored_results`), never applied: an unsigned result, one signed by another device, one naming another request id, one naming another job number, a status the contract does not list, and a status the attempt's op cannot have (section 4). An attempt that was never signed has no request id to answer.

The statuses, by class:

| Class | Statuses | Meaning |
| --- | --- | --- |
| open | `progress`, `applied`, `awaiting-confirm`, `queued`, `duty_held`, `transmitted`, `native_ack` | The job is open on the device. |
| final success | `ok`, `confirmed`, `applied-final` | It finished. |
| final failure | `failed`, `reverted` | It ran and failed or was undone. |
| cancelled | `cancelled` | The device cancelled it. |
| nothing ran | `refused`, `invalid`, `unknown-op`, `unsupported-version`, `busy`, `replay` | The device did not run it, or says it has seen the job number before. What each proves is in the job lifecycle contract, section 4. |

A job's `job.cancel` is useful only while the device's latest status for it is none yet, `progress`, `awaiting-confirm`, `queued` or `duty_held`. After any other status the device has nothing left to cancel.

## 4. Which results an op can have

`queued`, `duty_held`, `transmitted` and `native_ack` describe a radio, so only `message.send` and `packet.transmit` can have them. A result with one of them for another op is ignored and counted. `native_ack` also needs a direct message: for a channel message it is ignored and counted, because a channel has no recipient to acknowledge.

## 5. No automatic resend

The only repetition of an attempt is **a re-delivery of the identical stored bytes** (job lifecycle contract, section 7), which is safe because the device keeps one run per job number. For an attempt whose outcome is uncertain the Backend:
- never signs it again;
- never reroutes it to another transport or gateway;
- never picks another origin for it.

A user's retry is a new job, with a new job number and a new signature. A Backend never turns an uncertain outcome into a certain one by sending again.

## 6. Origin rules for a multi-gateway send (a profile)

A message may be sent from more than one gateway: the user's own Companion, or a Repeater that can reach the destination. These rules decide the **origin**, the gateway whose transmission starts the packet. A fixture of kind `origin` states the gateways (each `eligible`, `reachable`, `authorized`, and for a Companion `connected` and `capable`) and a window of 10 to 15 seconds.

- **One origin first.** The user's Companion, if it is connected and capable; otherwise the first eligible, reachable, authorized Repeater. No gateway qualifies: `no_origin`, and nothing is sent.
- **The window starts only on `rf_transmitted`.** It is the time from the first origin's first `transmitted` result until the window's end. Queued, accepted and duty-held start no window.
- **After the window,** and only if scheduling is still open, **one further gateway** is chosen: the first eligible, reachable gateway that has neither heard nor transmitted the packet and is **authorized again at that moment**. A gateway that heard the packet, or lost authorization, is skipped. If none is left, the scheduling closes as `no_second_origin`. There are never more than two origins.
- **A native DM ACK stops scheduling.** A native ACK for a direct message closes the scheduling as `native_ack`. For a channel message the ACK is ignored and counted.
- **An ambiguous origin is never resent.** An origin result of `refused`, `expired`, `failed` or `unknown` before any transmission starts no window, so nothing else is tried: the scheduling closes as `no_automatic_retry` and a retry is the user's, a new job.

Results per origin: `queued`, `duty_held`, `transmitted`, `refused`, `expired`, `failed`, `unknown`; null before the first report. A result for a gateway that is not an origin, or a second result after a final one, is ignored and counted. `queued` and `duty_held` may be followed by a later result.

## 7. The fixtures' rules

The validator checks:
- **Catalogue:** every op once, with a valid closed args schema, roles, `changes_state` and `internal`, and named in this README.
- **I:** the replay equals `expect` at every step; every `dispositions` document fits its schema; broker acceptance never changes the device answer; a set disposition never changes; a native ACK exists only for a direct message; a radio disposition exists only for a radio op; nothing is accepted by a transport before it is signed.
- **J:** every case's verdict equals the replay, and every catalogue op is accepted by at least one case and every refusal reason is shown by one.
- **K:** each case fails its schema.
- **L:** each run's replay equals `expect`; origins never repeat; there are at most two; a second origin is never scheduled before the window ends; a native ACK closes only a direct message; every origin result appears.
- **Coverage:** every fixture file is referenced here and valid; every catalogue op, every step kind of kinds `dispatch` and `origin`, every refusal reason and every origin result is covered by at least one fixture.

A Backend replaying these fixtures drives its own transport and clock. Output is compared exactly, in the order the fixtures use.
