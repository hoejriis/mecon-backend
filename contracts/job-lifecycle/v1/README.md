# Job lifecycle, version 1 (draft)

How the Backend runs one caller's request that one device run one typed command, asynchronously: what is committed before it answers, the states the job passes through, how a worker claims it and delivers signed bytes at most once per attempt, what a restart may and may not repeat, what ends a job, and who may see it. The commands themselves, the dispositions of an attempt and the correlation of device results are the [device dispatch](../../device-dispatch/v1/README.md) contract.

**Status: draft, version `1.0.0-draft.1`.** The text is derived from a Backend's handling of device requests. Statements marked **(observed)** describe that implementation today and are SHOULD here; section 11 lists where it falls short. The fixtures are synthetic: no real caller, device, key, host or tracker reference appears in them. How bytes are signed and which transport carries them are outside this contract: signed bytes are an opaque value, and a delivery is one handover to a transport.

| File | What it is |
| --- | --- |
| `README.md` | This contract. |
| `schemas/job.schema.json` | JSON Schema for a job as its creator reads it. |
| `schemas/attempt.schema.json` | JSON Schema for one attempt. |
| `schemas/control.schema.json` | JSON Schema for a signed `job.get` or `job.cancel` about an attempt. |
| `schemas/outcome.schema.json` | JSON Schema for the outcome of a terminal job. |
| `schemas/error.schema.json` | JSON Schema for the three fixed error bodies. |
| `schemas/response.schema.json` | JSON Schema for the response to one step. |
| `schemas/delivery.schema.json` | JSON Schema for one delivery handed to a transport. |
| `schemas/create-request.schema.json` | JSON Schema for the body of a create request. |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-happy-path.json` | Fixture A: a job runs to `succeeded`. |
| `fixtures/B-idempotent-create.json` | Fixture B: idempotent create, a conflicting reuse of the key, and reads scoped to the creator. |
| `fixtures/C-crash-and-second-worker.json` | Fixture C: a crash mid-dispatch; a second worker re-delivers the same bytes after the lease lapses. |
| `fixtures/D-no-answer-unknown.json` | Fixture D: no answer ends `unknown` at 3600 s, never `failed`. |
| `fixtures/E-nothing-ran.json` | Fixture E: the nothing-ran rule and the expiry bound. |
| `fixtures/F-cancel.json` | Fixture F: cancel before and after dispatch. |
| `fixtures/G-authority.json` | Fixture G: authority re-checked before every delivery. |
| `fixtures/H-forged-and-late.json` | Fixture H: forged results, a result for another device and late results, ignored and counted. |
| `fixtures/K-invalid.json` | Fixture K: documents the schemas reject. |

`npm test` in `contracts/` validates every schema and fixture. It replays fixtures A to H through `job-lifecycle-reference.mjs`, a reference model written from this README (it uses the device dispatch reference for commands, dispositions and correlation), and compares every step's response, deliveries, ignored count and job views exactly. It also checks the rules of section 10 on every step, fails when a fixture or schema file is not referenced here, when a fixture names another version than this one, and when no fixture covers a step kind. `scripts/gen-job-dispatch-fixtures.mjs` regenerates the scripted fixtures' expected outputs; a changed expectation is reviewed by hand, and a second implementation replaying the same fixtures is what checks the reference.

Fixture letters are per contract. The device dispatch contract has its own fixtures I, J, K and L.

---

## 1. Objects

**Job** (`schemas/job.schema.json`): one caller's request that one device run one typed command.
- `id`: `job_<n>`, public.
- `caller`: an opaque principal id; `device`: an opaque device id; `command`: `{op, args}`.
- `state`, `created_at`, `updated_at` (the time of the job's last change of any kind), `expires_at`.
- `attempts[]`, `controls[]`, `events[]`, `cancel_requested_at`, `redelivery_halted`.
- `claimed_by` and `lease_until`: the lease, or null.
- `idempotency_key`: the caller's key, or null.
- `outcome`: null until the job is terminal.

**Job number.** Every signed request to a device carries an integer from 1 to 2^32 minus 1, unique per device and increasing. The job number is bound into the device signature as `job_id`, and the device runs a given job number at most once.

**Attempt** (`schemas/attempt.schema.json`): one signed request, `att_<n>`, with its own `request_id` (`rq_<n>`), its own job number and its stored signed bytes. **Identical bytes delivered more than once are one attempt.** It keeps a `deliveries` count, and the dispositions of the device dispatch contract (section 2 there).

**Control** (`schemas/control.schema.json`): a signed `job.get` or `job.cancel` about an attempt, `ctl_<n>`. It has its own request id and job number, and is delivered once.

**Event**: a device's unsolicited status for the job (section 6), with `at`, `status` and `data`.

## 2. Create, persisted acceptance and idempotency

A create request (`schemas/create-request.schema.json`) names the device, a command and an optional `ttl_s` (1 to 86400, default 600). The caller is the authenticated principal. The `Idempotency-Key` is per caller.

- **Answer only after commit.** Create answers `created` only once the job is committed in state `accepted`. Nothing has been signed or sent.
- **Same key, same body:** the same job (`replayed`). The body is the device, the command and the time to live.
- **Same key, different body:** the error `conflict`. Nothing is created or sent.
- **Authority first:** a caller with no right on the device, a device that is not in a fleet the caller can reach, or a blocked device is the error `not_found`, as for any other id: nothing is created. Only then is the command checked against the device's role (device dispatch section 1); a refused command is the error `invalid`. A key already used is answered before either.

**Error bodies are fixed** (`schemas/error.schema.json`) and echo nothing from the request:

| Code | Message |
| --- | --- |
| `invalid` | The request is not valid. |
| `conflict` | The request conflicts with an earlier request. |
| `not_found` | Not found. |

## 3. States and transitions

| State | Meaning |
| --- | --- |
| `accepted` | Committed, before anything is delivered. A signed attempt may exist. |
| `dispatched` | An attempt was handed to a transport. |
| `running` | The device answered that the job is open on it: `progress`, `applied`, `awaiting-confirm`, `queued`, `duty_held`, `transmitted` or `native_ack`. |
| `succeeded` | The device's final state is `ok`, `confirmed` or `applied-final`. |
| `failed` | The device ran it and it failed or was undone: `failed` or `reverted`. |
| `refused` | Nothing ran: either the Backend's own check (reason `authority`), or a device answer proving nothing ran when no new attempt is made (reason `nothing_ran`). |
| `cancelled` | Before dispatch, or the device confirmed `cancelled`. |
| `expired` | Never dispatched before `expires_at`. |
| `unknown` | Dispatched, and no answer settled it before the abandon deadline. |

The only moves are:

| From | To |
| --- | --- |
| `accepted` | `dispatched`, `cancelled`, `expired`, `refused` |
| `dispatched` | `running`, `succeeded`, `failed`, `refused`, `cancelled`, `unknown` |
| `running` | `succeeded`, `failed`, `cancelled`, `unknown` |
| `succeeded`, `failed`, `refused`, `cancelled`, `expired`, `unknown` | none |

**A terminal state never changes, and a late event never moves a job backwards.** A result that arrives for a terminal job is ignored and counted, and so is one for an attempt that has been replaced by a new one.

A terminal job's `outcome` (`schemas/outcome.schema.json`) has a `reason`, the `device_status` that settled it (null when none did) and `at`. Which reason fits which state:

| State | Reasons |
| --- | --- |
| `succeeded`, `failed` | `device_final` |
| `refused` | `authority`, `nothing_ran` |
| `cancelled` | `caller_before_dispatch`, `device_confirmed` |
| `expired` | `expiry` |
| `unknown` | `abandon_deadline` |

## 4. Attempts, job numbers and the nothing-ran rule

An attempt is signed with the next job number of the device, and a status read or cancel (a control) takes the next one after it. The job number of an attempt never changes.

**A new attempt, with a new job number and a new signature, is allowed only when the device's answer proves nothing ran:**
- the status is `refused`, `invalid`, `unknown-op` or `unsupported-version`;
- the status is `busy` and the job is still `dispatched`, so the device has not opened it;
- the status is `replay` and the attempt was delivered exactly once, because a first delivery that the device already knew can only be a duplicate of an earlier run of that job number.

Otherwise there is never a new attempt. A `replay` for an attempt delivered more than once does not prove nothing ran, since the device may have run it from an earlier delivery: the Backend reads the job with `job.get` instead (section 7).

Marking an attempt as having run nothing is final: later results for it are ignored. The job stays `dispatched` until the new attempt is delivered. **A new attempt can start only before `expires_at`:** if the job has expired by the time a nothing-ran answer arrives, or before the new attempt is delivered, the job is `refused` with reason `nothing_ran` and no new attempt is made. A cancel while a new attempt is only awaited ends the job `cancelled` at once (section 8).

## 5. Claim, lease and signed bytes

A worker **claims** a job with a lease: `claimed_by` and `lease_until`, 30 seconds by default **(observed: there is no lease; one open request per device is its exclusion)**. A claim succeeds when the job is not terminal and has no live lease held by another worker; a lapsed lease lets another worker claim it. A worker renews its own lease by claiming again. A worker signs and delivers only while its lease is live.

**The signed bytes are stored with the attempt before the first delivery.** A worker that crashes after signing, or after delivering, leaves the bytes behind. A second worker that claims after the lease lapses delivers **the same bytes**, never new ones: it never re-signs. Two deliveries of identical bytes are one attempt with `deliveries` 2, and every delivery's `bytes` equals the stored bytes.

A delivery moves a job from `accepted` to `dispatched`. A delivery is recorded as `deliveries` and, when the transport accepts it, as `transport_accepted` (device dispatch section 2): neither is a device result.

## 6. Device results

A result is correlated first (device dispatch section 3): signed by the attempt's device, naming its request id and its job number. One that fails is ignored and counted, never applied. A result for a control is correlated by the control's own request id and job number, and then settles the attempt the control is about.

A correlated result for the job's current attempt updates the attempt's dispositions and then moves the job:
- an open status moves `dispatched` to `running`, and leaves `running` as it is;
- a final success status ends it `succeeded`; a final failure status ends it `failed`;
- `cancelled` ends it `cancelled`, only when the caller asked for the cancel (section 8); otherwise it is ignored and counted;
- a nothing-ran status acts as section 4 says. `busy` and `replay` are ignored and counted when the job is already `running`.

An **event** is a device result that the Backend did not ask for with a delivery (`device_event`); it is applied the same way and is also appended to the job's `events`. **Device-side job events after the device left the caller's reach** (it is no longer in the caller's fleet, the caller's right is gone, or it is blocked) **stay readable to the creator, but carry no data from after that point:** the event's `data` is null.

## 7. Restart, re-delivery, expiry and the abandon deadline

**After a restart,** every lease is void, since the workers that held them are gone, and the persisted state is unchanged. Then:
- an `accepted` job is dispatched normally: a worker claims it and delivers;
- a `dispatched` or `running` job is **re-delivered as identical bytes at most every 60 seconds while unanswered**. This is a transport retry, and it is safe because the device keeps one run per job number;
- when the job has been **quiet for 15 minutes**, a signed status read, `job.get`, is sent instead. Quiet is the time since the latest of the attempt's first delivery, the device's latest answer and the latest control delivered. A `job.get` is also sent at once after a `replay` that is not a nothing-ran proof (section 4);
- the job is never re-signed, except under the nothing-ran rule.

A running job that is not unanswered is not re-delivered; it is only read when it has been quiet.

**Expiry bounds dispatch only.** `expires_at` ends a job that was never dispatched, `expired`, whether or not a signed attempt exists. It never ends a dispatched job.

**The abandon deadline ends a dispatched job in `unknown`, never `failed`.** When 3600 seconds (the default) have passed since the first delivery of the current attempt and nothing settled the job, it is `unknown`: the Backend does not know what the device did. `failed` is only ever the device's own word. **(observed: the Backend ends an unanswered request `failed` with "no answer"; see section 11.)**

## 8. Cancellation and the authority re-check

**Cancel.** The caller's cancel is for the caller's own job; any other job is `not_found`.
- **Before dispatch** (the job is `accepted`, or only a new attempt is awaited), the job is `cancelled` at once with reason `caller_before_dispatch`, and nothing is sent.
- **After dispatch,** the request is recorded (`cancel_requested_at`) and the job keeps its state. A signed `job.cancel` is sent by the next delivery, **only if the device's job is in a cancellable state** (device dispatch section 3), and before any re-delivery. The job moves only when the device reports: it may still be `succeeded`, `failed` or `cancelled`. If the device proves nothing ran, the job is `cancelled`.
- **A second cancel is a `conflict`,** and so is a cancel of a terminal job.

**Authority re-check.** Three things are checked at creation and again immediately before every delivery, including a re-delivery of identical bytes and the delivery of a `job.get` or `job.cancel`: the caller's right on the device, the device's fleet membership, and the device's blocked flag.
- If the check fails **before the first delivery** of the current attempt, the job is `refused` with reason `authority`, and nothing is sent. Nothing is signed for a job that fails at signing.
- If it fails **before a re-delivery**, re-delivery stops (`redelivery_halted`), and it stays stopped even if the authority returns. The job then settles only by a device answer already in flight, and otherwise ends `unknown` at the abandon deadline.

**(observed: the caller is not checked again before a re-delivery.)**

## 9. Caller-scoped reads

A caller reads and lists only the jobs it created. **Any other id is `not_found`, the same as a malformed or a nonexistent id,** with the same fixed body, so existence is never disclosed. A list holds exactly the caller's own jobs. A job read by its creator after the device left the caller's reach is still readable, with the limit on events in section 6. **(observed: reads go through the device's access list, not the job's creator.)**

## 10. The fixtures' rules

Each lifecycle fixture is a scripted sequence of steps against a clock that only `advance` moves. The step kinds are `create`, `read`, `list`, `claim`, `sign`, `deliver`, `transport_ack`, `device_answer`, `device_event`, `advance`, `restart`, `cancel` and `authority`. After each step `expect` states the response, the deliveries handed to transports, the cumulative `ignored_results` and the view of every job. The validator checks:
- every response, delivery and job against its schema, and the error bodies against the fixed ones;
- the replay through the reference model equals `expect` exactly;
- every job state change is in the transition table, a terminal job's state and outcome never change, and every outcome reason fits its state;
- an attempt's stored bytes, request id and job number never change, a delivery carries exactly the stored bytes, and an attempt's `deliveries` equals the deliveries handed out;
- job numbers of one device strictly increase with the requests, and a job never has a new attempt after one that may have run;
- a refused create makes no job and sends nothing; a read by anyone but the creator is `not_found`, and a list holds the caller's own jobs;
- every step kind appears in at least one fixture, and **K**: each case fails its schema.

A Backend replaying these fixtures supplies its own storage, transport and clock. The expected values use the defaults of this README: a lease of 30 seconds, a re-delivery interval of 60 seconds, a status read after 900 seconds of quiet, an abandon deadline of 3600 seconds and a time to live of 600 seconds.

## 11. Gaps in the observed implementation

- **`failed` for no answer.** An unanswered request ends `failed` with "no answer" after its timeout. Here it is `unknown`: the Backend cannot know the device did not run it.
- **No caller re-check before a re-delivery.** A request that is sent again is not checked against the caller's right, the fleet or the blocked flag again.
- **No claim lease.** The only exclusion is one open request per device, so a crashed worker's request blocks the device until it times out, and a second worker has nothing to claim.
- **Caller scoping through the device.** A read is allowed by the device's access list, so a caller who gained access to a device can read earlier callers' jobs on it.
