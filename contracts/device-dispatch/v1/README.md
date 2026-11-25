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
| `fixtures/I-dispositions.json` | Fixture I: dispositions kept distinct: broker acceptance, duty hold, transmission, a native ACK (`acked`) on a direct message and never on a channel message. |
| `fixtures/J-typed-commands.json` | Fixture J: every catalogue op accepted, and invalid commands refused before anything is signed. |
| `fixtures/K-invalid.json` | Fixture K: documents the schemas reject. |
| `fixtures/L-origins.json` | Fixture L: the origin rules for a multi-gateway send of a packet whose bytes are fixed. |

`npm test` in `contracts/` validates the catalogue, every schema and every fixture. It replays I, J and L through `device-dispatch-reference.mjs`, a reference model written from this README, and compares each step's expected output exactly. It fails when a fixture file or schema is not referenced here, when a fixture names another version than this one, and when no fixture covers a catalogue op, a step kind, a command refusal reason or an origin result. `scripts/gen-job-dispatch-fixtures.mjs` regenerates the expected outputs of the scripted fixtures; a changed expectation is reviewed by hand, and a second implementation replaying the same fixtures is what checks the reference.

Fixture letters are per contract. The job lifecycle contract has its own fixtures A to H and K.

---

## 1. Typed commands

There is no door for "send any op". A command is `{ "op": ..., "args": {...} }` (`schemas/command.schema.json`), and it is valid only when the catalogue says so. `schemas/catalogue.json` lists each op once, with:
- `roles`: the device roles the op applies to (`companion`, `repeater`);
- `changes_state`: whether running it changes the device;
- `internal`: whether only the Backend may request it;
- `cancellable_states`: the device job states in which a `job.cancel` still has something to cancel (section 3);
- `status_read`: the internal op the Backend uses to ask the device where a job of this op stands: `job.get` for the job ops and `message.get` for `message.send`; null for the internal ops;
- `args`: a closed JSON Schema (`additionalProperties` is false, required args are listed).

The synthetic catalogue holds `contact.put`, `contact.remove`, `message.send`, `packet.transmit`, `config.apply`, `job.cancel`, `job.get` and `message.get`. The last three are internal: the Backend signs them to manage a job it already has, and a caller cannot request them. A `job.cancel` is a signed request and takes a job number of its own. **A `job.get` is a plain read:** it carries no job number of its own and no signature-bound job id, it takes no place in the job number sequence, and `target_job_number` only names the job it reads.

**A message is not a job.** On the device `message.send` lives in a separate table of 8 slots held in RAM, and a `job.get` for it always answers `unknown-job`. Its status read is **`message.get`** with `{"message": <identity>}` (here `msg_<n>`, the attempt's job number). It is a plain read like `job.get`: no job number of its own. A Backend never reads a `message.send` with `job.get`.

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
| `device_answered` | The device answered. It holds the device's `status`, `error` code, `state`, packet `outcome` and `duty_held` flag (each may be null or false) and when it arrived, and is replaced by each later answer. |
| `rf_transmitted` | The device reported a transmission: the message state `transmitted`, or a `packet.transmit` that is `applied` with the outcome `transmitted`. A count, and the first and last time. Each such answer adds its `rf_count`, 1 when absent. |
| `acked` | A direct message was acknowledged natively by its recipient: the device reported the state `acked`. Only ever for `message.send` with `kind` `direct`, never for a channel message. Set once. |

**Broker acceptance is never a device result.** `transport_accepted` says a message was handed over, and nothing about the device. A device that never answers has a null `device_answered` however many publishes the broker accepted.

A set `signed`, `transport_accepted` or `acked` never changes, and `rf_transmitted` only grows.

## 3. Results and correlation

`schemas/result.schema.json`. A device answer carries `signed_by` (the device whose signature verified, or null when none does), the `request_id` and `job_number` it answers, and the answer as the device sends it: a `status` and, depending on it, an `error` code or a job `state`. For a `job.get` the job number is the one of the job it reads, since the read has none of its own.

**A result is applied to an attempt only when** it is signed by the attempt's own device, and names that attempt's request id and the job number the attempt carries for that device. Anything else is **ignored and counted** (`ignored_results`), never applied: an unsigned result, one signed by another device, one naming another request id, one naming another job number, an answer that is not well formed (below), and a state the attempt's op cannot have (section 4). An attempt that was never signed has no request id to answer.

**Statuses:** `ok`, `refused`, `invalid`, `unknown-op`, `unsupported-version`, `busy` and `failed`. Their meaning, with the error codes:

| Answer | Means |
| --- | --- |
| `ok` with a `state` | The device has the job, and `state` is where it stands (below). |
| `refused`, `invalid`, `unknown-op`, `unsupported-version` | The device did not run it. |
| `busy` | The device is occupied and did not run it. The attempt stands and is delivered again later. |
| `busy` with error `job-open` | The device is occupied by another open job and did not run it. |
| `refused` with error `replay` and a `mark` | The device has seen this job number. `mark` is the highest job number the device has seen. |
| `failed` with error `duplicate` | The job number already ran, or a power cut lost its answer. What happened is not known. |
| `failed` with error `unknown-job` | The device has no job with that number. |
| `failed` | The device ran it and it failed. |

**Replay and duplicate are error codes, not statuses.** An error code goes only with its status (`replay` with `refused`, `duplicate` and `unknown-job` with `failed`, `job-open` with `busy`), `replay` always carries a `mark` and nothing else does, and a `state` goes only with `ok`. Any other combination is not well formed.

**Device states differ by kind.** A **message** (`message.send`) has message states; every other op is a **device job** with job states.

| Kind | Class | States |
| --- | --- | --- |
| message | open | `queued`, `duty-held`, `transmitted` (direct message), `timed-out` |
| message | final success | `acked` (direct message), `transmitted` (channel message: a channel has no ACK to wait for) |
| job | open | `accepted`, `progress`, `applied`, `awaiting-confirm` |
| job | final success | `confirmed`; for `packet.transmit`, `applied` with the outcome `transmitted` |
| job | final failure | `reverted`, `failed`; for `packet.transmit`, `applied` with the outcome `expired` or `failed` |
| job | cancelled | `cancelled` |
| either | unknown | `unknown`; for `packet.transmit`, `applied` with the outcome `unknown` |

**`timed-out` is not final.** It does not prove the message was not received, and a late ACK moves it to `acked`. A message in `timed-out` stays `running`, a later `acked` ends it `succeeded`, and at the abandon deadline it ends `unknown`, never `failed`.

**A `packet.transmit` is a device job.** Its state `applied` is final and carries an `outcome` (`transmitted`, `expired`, `failed` or `unknown`) in its result. A duty hold is the state `accepted` with `duty_held` true. The message states do not apply to it (section 4).

A device state of `unknown` is the device saying it does not know how the job ended. It ends the job `unknown`, never `failed`.

**The answer to a `message.get`** carries the device `epoch`. When the entry is found, `state` is the entry's state, applied like any other state. When it is not found the answer is `ok` with `state` `unknown` and the current epoch: the entry was evicted, lost to a reboot, or never sent, and these cannot be told apart. That answer settles nothing: it is never `refused`, never `failed` and never "nothing ran", so the job stays where it is and is not delivered again. Contrast `unknown-job` from a `job.get` on a job op, which ends the job `unknown` (job lifecycle contract, section 4).

**What can be cancelled.** A `job.cancel` is useful only while the job's latest state is in its op's `cancellable_states`: `accepted`, `applied` (cancelling an applied job reverts it) and `awaiting-confirm` for the data and settings ops; for `packet.transmit` only `accepted` (a duty hold included): `progress` means the packet is handed to the radio and cannot be recalled. `message.send` has none: the device has no cancel for a message (a `job.cancel` looks only in the job table), so a caller's cancel of a dispatched message is recorded and never sent, and the job runs to its device outcome. A `progress` state would be cancellable only for an update op, which the synthetic catalogue does not have.

## 4. Which states an op can have

`queued`, `duty-held`, `transmitted`, `acked` and `timed-out` are **message** states, for `message.send` only. A result with one of them for another op is ignored and counted. `acked` also needs a direct message: for a channel message it is ignored and counted, because a channel has no recipient to acknowledge. A job op's answer with a message state is ignored in the same way, and a message's answer with a job state other than `unknown` too. `duty_held` goes only with the state `accepted` of a `packet.transmit`, and `outcome` only with its state `applied`; otherwise the answer is not well formed.

## 5. No automatic resend

The only repetition of an attempt is **a re-delivery of the identical stored bytes** (job lifecycle contract, section 7), which is safe because the device keeps one run per job number. For an attempt whose outcome is uncertain the Backend:
- never signs it again;
- never reroutes it to another transport or gateway;
- never picks another origin for it.

A user's retry is a new job, with a new job number and a new signature. A Backend never turns an uncertain outcome into a certain one by sending again.

**This is about one job's attempt.** In a multi-gateway send (section 6) each origin is its own job with its own single attempt, which is never sent again. Choosing another origin sends the same packet bytes, already public once any gateway has transmitted them, from a different gateway, and the mesh deduplicates a packet by its hash. That is the design of the profile and not a retry of the uncertain job: the earlier origin's job is left to settle on its own.

## 6. Origin rules for a multi-gateway send (a profile)

A message may be sent from more than one gateway: the user's own Companion, or Repeaters that can reach the destination. These rules decide the **origin**, the gateway whose transmission starts the packet. **The profile applies only to packet sends whose bytes are fixed before the first origin is chosen:** every origin sends the same packet, so a second origin can add nothing the first did not, and the mesh drops a repeat by its hash. Each origin is its own job (section 5). A fixture of kind `origin` states the gateways, a seeded order, the window (10 to 15 seconds), the Companion's timeout (120 seconds) and the send's lifetime (600 seconds).

- **The first origin is the user's Companion** when it is connected, capable, eligible and authorized. Otherwise the first round picks a Repeater.
- **The Companion's 120 seconds.** If it shows no transmission within 120 seconds of the start, the next round picks a Repeater.
- **Rounds continue** until every eligible gateway has heard or transmitted the packet. A gateway is an origin at most once, and there is no other limit on the number of rounds. After an origin's first `transmitted` result the next round begins when the window (10 to 15 s) has run out.
- **The next origin is chosen at random** among the eligible gateways that are **authorized again at that moment** and have neither heard nor transmitted the packet and have not been an origin. The fixtures make the choice deterministic with a seeded `order` in the setup: the first gateway of the order that qualifies.
- **After an origin ends `refused`, `expired`, `failed` or `unknown`,** the next round begins at once and picks another origin. The ended origin is never sent again.
- **Nothing left:** when no gateway qualifies the scheduling closes as `no_candidates`, or as `no_origin` when no first origin could be found.
- **A native DM ACK stops scheduling.** It closes the scheduling as `native_ack` and sends `job.cancel` to the **Repeater** origins whose jobs are still dispatched (no transmission yet), **never to the Companion**. A cancel the device refuses is retried for up to 300 seconds from the ACK, and then given up. A cancelled origin that later reports `transmitted` counts as transmitted. For a channel message the ACK is ignored and counted.
- **The send's lifetime is 600 seconds,** after which the scheduling closes as `lifetime`.

Results per origin: `queued` (the origin's job is `accepted`), `duty-held` (`accepted` with `duty_held`), `transmitted`, `refused`, `expired`, `failed`, `unknown`, and `cancelled` once a cancel was accepted; null before the first report. **"Silent" means no report at all,** and a silent Repeater is waited for until the send's lifetime ends. A Repeater that expires its own hold after 60 seconds reports `expired`, and that starts the next round at once. A result for a gateway that is not an origin, and a result after the first transmission or a final result, are ignored and counted; a result for an origin that is `queued`, `duty-held` or `cancelled` is recorded even after the scheduling closed.

## 7. The fixtures' rules

The validator checks:
- **Catalogue:** every op once, with a valid closed args schema, roles, `changes_state` and `internal`, and named in this README.
- **I:** the replay equals `expect` at every step; every `dispositions` document fits its schema; broker acceptance never changes the device answer; a set disposition never changes; `acked` exists only for a direct message; a radio disposition exists only for a radio op; nothing is accepted by a transport before it is signed.
- **J:** every case's verdict equals the replay, and every catalogue op is accepted by at least one case and every refusal reason is shown by one.
- **K:** each case fails its schema.
- **L:** each run's replay equals `expect`; origins never repeat and one round adds at most one; a further origin comes only after the previous one ended without transmitting, or when the window or the Companion's 120 seconds had run out; nothing is scheduled after the scheduling closed; a native ACK closes only a direct message and cancels only Repeater origins that had not transmitted, never the Companion; a cancel is given up only 300 seconds after the ACK; every origin result appears.
- **Coverage:** every fixture file is referenced here and valid; every catalogue op, every step kind of kinds `dispatch` and `origin`, every refusal reason and every origin result is covered by at least one fixture.

A Backend replaying these fixtures drives its own transport and clock. Output is compared exactly, in the order the fixtures use.
