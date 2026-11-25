// A reference model for the device dispatch contract (contracts/device-dispatch/v1): the rules of its README as
// code. The validator replays every fixture through it, the job lifecycle reference builds on it, and the fixture
// generator in scripts/ uses it to fill in expected outputs. It is a specification aid, not a Backend: no
// transport, no keys, no clock of its own.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

export const CONTRACT_VERSION = '1.0.0-draft.1';
export const CATALOGUE = JSON.parse(readFileSync(new URL('./device-dispatch/v1/schemas/catalogue.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const argValidators = Object.fromEntries(CATALOGUE.ops.map((o) => [o.op, ajv.compile(o.args)]));

// Section 3: a device answers with a status and, for some refusals, an error code. An `ok` answer carries the
// device's job state.
export const ANSWER_STATUSES = ['ok', 'refused', 'invalid', 'unknown-op', 'unsupported-version', 'busy', 'failed'];
export const ERROR_CODES = { replay: 'refused', duplicate: 'failed', 'job-open': 'busy', 'unknown-job': 'failed' };
// Device states differ by kind. A message (message.send) has message states; every other op is a device job with job
// states. A packet.transmit is a job: its state `applied` is final and carries the outcome, and a duty hold is the
// state `accepted` with `duty_held` true.
export const JOB_STATES = {
  open: ['accepted', 'progress', 'awaiting-confirm'], // an op that needs confirmation goes to awaiting-confirm
  final_success: ['applied', 'confirmed'], // applied is terminal on the device
  final_failure: ['reverted', 'failed'],
  cancelled: ['cancelled'],
  unknown: ['unknown'],
};
export const MESSAGE_STATES = ['queued', 'duty-held', 'transmitted', 'acked', 'timed-out'];
export const PACKET_OUTCOMES = ['transmitted', 'expired', 'failed', 'unknown'];
export const ALL_STATES = [...Object.values(JOB_STATES).flat(), ...MESSAGE_STATES];
export const RADIO_OPS = ['message.send', 'packet.transmit'];
export const COMMAND_REASONS = ['unknown_op', 'internal_op', 'wrong_role', 'invalid_args'];
export const ORIGIN_RESULTS = ['queued', 'duty-held', 'transmitted', 'refused', 'expired', 'failed', 'unknown', 'cancelled'];

export const iso = (start, seconds) => new Date(Date.parse(start) + seconds * 1000).toISOString().replace('.000Z', 'Z');

// Section 1: a command is valid only when the catalogue knows its op, a caller may request it, the device's role
// is one of the op's roles, and the args fit the op's schema. The reasons are checked in that order.
export function validateCommand(command, role, by = 'caller') {
  const isObject = command !== null && typeof command === 'object' && !Array.isArray(command);
  const entry = isObject && typeof command.op === 'string' ? CATALOGUE.ops.find((o) => o.op === command.op) : undefined;
  if (!entry) return { valid: false, reason: 'unknown_op' };
  if (entry.internal && by !== 'backend') return { valid: false, reason: 'internal_op' };
  if (!entry.roles.includes(role)) return { valid: false, reason: 'wrong_role' };
  const keys = Object.keys(command).sort().join(',');
  if (keys !== 'args,op' || !argValidators[entry.op](command.args)) return { valid: false, reason: 'invalid_args' };
  return { valid: true };
}

// Section 3: a job.cancel has something to cancel only in the states its op lists.
export const cancellable = (op, state) => !!CATALOGUE.ops.find((o) => o.op === op)?.cancellable_states.includes(state);

// Section 2: the dispositions of one attempt, each with its own timestamp or null.
export const newDispositions = () => ({ signed: null, transport_accepted: null, device_answered: null, rf_transmitted: null, acked: null });

// Section 3: a result belongs to an attempt only when signed by that attempt's device and naming its request id
// and its job number.
export const correlates = (target, result) =>
  typeof result.signed_by === 'string' && result.signed_by === target.device
  && result.request_id === target.request_id && result.job_number === target.job_number;

// Section 3: what a well-formed answer means for a command. Null for an answer the contract does not allow: an unknown
// status, an error code under the wrong status, a state without `ok` or missing with it, a mark without `replay`, a
// state of the wrong kind for the op, an `acked` for a channel message, an outcome or duty hold where they do not belong.
export function classify(r, command) {
  if (!ANSWER_STATUSES.includes(r.status)) return null;
  const error = r.error ?? null;
  const extras = r.outcome !== undefined || r.duty_held !== undefined;
  if (error !== null) {
    if (ERROR_CODES[error] !== r.status || r.state !== undefined || extras || (error === 'replay') !== (r.mark !== undefined)) return null;
    return { kind: { replay: 'replay', duplicate: 'duplicate', 'job-open': 'job_open', 'unknown-job': 'unknown_job' }[error] };
  }
  if (r.mark !== undefined) return null;
  if (r.status !== 'ok') {
    if (r.state !== undefined || extras) return null;
    return { kind: r.status === 'busy' ? 'busy' : r.status === 'failed' ? 'failed' : 'nothing_ran' };
  }
  const { op, args } = command;
  const st = r.state;
  if (op === 'message.send') {
    if (extras) return null;
    if (st === 'unknown') return { kind: 'unknown_state' };
    if (!MESSAGE_STATES.includes(st)) return null;
    if (st === 'acked' && args.kind !== 'direct') return null;
    if (st === 'transmitted') return { kind: args.kind === 'direct' ? 'open' : 'final_success' }; // a channel has no ACK to wait for
    if (st === 'acked') return { kind: 'final_success' };
    return { kind: 'open' }; // queued, duty-held and timed-out: a late ACK can still follow a time-out
  }
  if (r.duty_held !== undefined && !(op === 'packet.transmit' && st === 'accepted')) return null;
  if (r.outcome !== undefined && !(op === 'packet.transmit' && st === 'applied')) return null;
  if (op === 'packet.transmit' && st === 'applied') {
    if (!PACKET_OUTCOMES.includes(r.outcome)) return null;
    return { kind: r.outcome === 'transmitted' ? 'final_success' : r.outcome === 'unknown' ? 'unknown_state' : 'final_failure' };
  }
  const cls = Object.keys(JOB_STATES).find((k) => JOB_STATES[k].includes(st));
  if (!cls) return null;
  return { kind: cls === 'unknown' ? 'unknown_state' : cls };
}

// Section 3 and 4: apply a device result to an attempt `{ device, request_id, job_number, command, dispositions }`
// at time `at` (an ISO string). Returns { applied }. A result that does not correlate, is not well formed or
// claims what the op cannot have is not applied, and the attempt is unchanged.
export function applyResult(att, result, at) {
  if (!correlates(att, result) || !classify(result, att.command)) return { applied: false };
  const d = att.dispositions;
  const transmitted = result.state === 'transmitted' || (result.state === 'applied' && result.outcome === 'transmitted');
  if (transmitted) {
    const n = result.rf_count ?? 1;
    d.rf_transmitted = d.rf_transmitted ? { count: d.rf_transmitted.count + n, first_at: d.rf_transmitted.first_at, last_at: at } : { count: n, first_at: at, last_at: at };
  }
  if (result.state === 'acked' && d.acked === null) d.acked = at;
  d.device_answered = { status: result.status, error: result.error ?? null, state: result.state ?? null, outcome: result.outcome ?? null, duty_held: result.duty_held ?? false, at };
  return { applied: true };
}

// Sections 2 and 3 on bare attempts: a fixture of kind `dispatch`.
export const DISPATCH_STEPS = ['sign', 'transport_accept', 'result'];
export function replayDispatch(setup, steps) {
  const atts = Object.fromEntries(setup.attempts.map((a) => [a.request_id, { ...a, dispositions: newDispositions() }]));
  let ignored = 0;
  return steps.map((s) => {
    const at = iso(setup.start, s.t);
    let applied = null;
    if (s.step === 'sign') {
      atts[s.request_id].dispositions.signed ??= at;
    } else if (s.step === 'transport_accept') {
      const a = atts[s.request_id];
      applied = a.dispositions.signed !== null; // nothing can be accepted that was never signed
      if (applied) a.dispositions.transport_accepted ??= at;
    } else if (s.step === 'result') {
      const target = Object.values(atts).find((a) => a.dispositions.signed !== null && correlates(a, s.result));
      applied = target ? applyResult(target, s.result, at).applied : false;
      if (!applied) ignored++;
    } else throw new Error(`unknown step ${s.step}`);
    return { applied, ignored_results: ignored, attempts: Object.fromEntries(Object.entries(atts).map(([k, a]) => [k, structuredClone(a.dispositions)])) };
  });
}

// Section 1's reasons, one case at a time: a fixture of kind `commands`.
export const replayCommands = (cases) => cases.map((c) => validateCommand(c.command, c.role, c.by));

// Section 6: the origin rules for a multi-gateway send of a packet whose bytes are fixed. A fixture of kind
// `origin`. Each origin is its own job with its own single attempt; choosing another origin sends the same public
// packet bytes from a different gateway and never repeats an origin's attempt.
export const ORIGIN_STEPS = ['start', 'result', 'heard', 'authority', 'native_ack', 'cancel_result', 'tick'];
export const CLOSED_REASONS = ['native_ack', 'no_candidates', 'lifetime', 'no_origin'];
const FAILED_ORIGIN = ['refused', 'expired', 'failed', 'unknown'];
const PENDING_ORIGIN = [null, 'queued', 'duty-held', 'cancelled']; // a cancelled origin that later transmits counts as transmitted
const CANCELLABLE_ORIGIN = [null, 'queued', 'duty-held'];
export const CANCEL_RETRY_S = 300;
export function replayOrigins(setup, steps) {
  const gws = structuredClone(setup.gateways);
  const origins = [];
  let nextRound = null;
  let closed = null;
  let ignored = 0;
  let begun = null;
  let ackedAt = null;
  const eligible = (g) => g.eligible && g.reachable && g.authorized && (g.kind !== 'companion' || (g.connected && g.capable));
  const view = (scheduled, cancelSent, givenUp) => ({
    origins: origins.map((o) => ({ ...o })), next_round_at: nextRound === null ? null : iso(setup.start, nextRound), scheduled, cancel_sent: cancelSent, cancel_given_up: givenUp, closed, ignored_results: ignored,
  });
  return steps.map((s) => {
    const scheduled = [];
    const cancelSent = [];
    const givenUp = [];
    const at = iso(setup.start, s.t);
    // One round: the next origin is the first, in the setup's seeded order, of the eligible gateways that are
    // authorised again now, have neither heard nor transmitted the packet and have not been an origin.
    const round = () => {
      const pick = setup.order.find((n) => !origins.some((o) => o.gateway === n) && !gws[n].heard && eligible(gws[n]));
      nextRound = null;
      if (pick === undefined) { closed = origins.length ? 'no_candidates' : 'no_origin'; return; }
      origins.push({ gateway: pick, result: null, transmitted_at: null });
      scheduled.push(pick);
    };
    const live = () => closed === null && begun !== null;
    if (s.step === 'start') {
      begun = s.t;
      const first = setup.order.find((n) => gws[n].kind === 'companion' && eligible(gws[n]));
      if (first !== undefined) {
        origins.push({ gateway: first, result: null, transmitted_at: null });
        scheduled.push(first);
        nextRound = s.t + setup.companion_timeout_s; // no transmission by then: fall back to Repeaters
      } else round();
    } else if (s.step === 'result') {
      const o = origins.find((x) => x.gateway === s.gateway);
      if (begun === null || !o || !PENDING_ORIGIN.includes(o.result)) ignored++;
      else {
        o.result = s.status;
        const latest = o === origins[origins.length - 1];
        if (s.status === 'transmitted') {
          o.transmitted_at = at;
          gws[o.gateway].heard = true;
          if (latest && closed === null) nextRound = s.t + setup.window_s;
        } else if (FAILED_ORIGIN.includes(s.status) && latest && closed === null) round();
      }
    } else if (s.step === 'heard') {
      gws[s.gateway].heard = true;
    } else if (s.step === 'authority') {
      gws[s.gateway].authorized = s.authorized;
    } else if (s.step === 'native_ack') {
      if (setup.message_kind !== 'direct' || !live()) ignored++;
      else {
        closed = 'native_ack';
        nextRound = null;
        ackedAt = s.t;
        // Only Repeater origins whose jobs are still dispatched are cancelled, never the Companion.
        for (const o of origins) if (gws[o.gateway].kind === 'repeater' && CANCELLABLE_ORIGIN.includes(o.result)) cancelSent.push(o.gateway);
      }
    } else if (s.step === 'cancel_result') {
      const o = origins.find((x) => x.gateway === s.gateway);
      if (ackedAt === null || !o || gws[o.gateway].kind !== 'repeater' || !CANCELLABLE_ORIGIN.includes(o.result)) ignored++;
      else if (s.accepted) o.result = 'cancelled';
      else if (s.t < ackedAt + CANCEL_RETRY_S) cancelSent.push(o.gateway); // a refused cancel is retried for up to 300 s
      else givenUp.push(o.gateway);
    } else if (s.step === 'tick') {
      if (live()) {
        if (s.t >= begun + setup.lifetime_s) { closed = 'lifetime'; nextRound = null; }
        else if (nextRound !== null && s.t >= nextRound) round();
      }
    } else throw new Error(`unknown step ${s.step}`);
    return view(scheduled, cancelSent, givenUp);
  });
}
