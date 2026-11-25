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

// Section 3: what a device may answer. Each status belongs to one class.
export const STATUS_CLASSES = {
  running: ['progress', 'applied', 'awaiting-confirm', 'queued', 'duty_held', 'transmitted', 'native_ack'],
  final_ok: ['ok', 'confirmed', 'applied-final'],
  final_failed: ['failed', 'reverted'],
  cancelled: ['cancelled'],
  nothing_ran: ['refused', 'invalid', 'unknown-op', 'unsupported-version', 'busy', 'replay'],
};
export const ALL_STATUSES = Object.values(STATUS_CLASSES).flat();
export const RADIO_STATUSES = ['queued', 'duty_held', 'transmitted', 'native_ack'];
export const RADIO_OPS = ['message.send', 'packet.transmit'];
// The device's last status for a job, when a `job.cancel` still has something to cancel. null: not answered yet.
export const CANCELLABLE = [null, 'progress', 'awaiting-confirm', 'queued', 'duty_held'];
export const COMMAND_REASONS = ['unknown_op', 'internal_op', 'wrong_role', 'invalid_args'];
export const ORIGIN_RESULTS = ['queued', 'duty_held', 'transmitted', 'refused', 'expired', 'failed', 'unknown'];

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

// Section 2: the dispositions of one attempt, each with its own timestamp or null.
export const newDispositions = () => ({ signed: null, transport_accepted: null, device_answered: null, rf_transmitted: null, native_ack: null });

// Section 3: a result belongs to an attempt only when signed by that attempt's device and naming its request id
// and its job number.
export const correlates = (target, result) =>
  typeof result.signed_by === 'string' && result.signed_by === target.device
  && result.request_id === target.request_id && result.job_number === target.job_number;

// Section 3: apply a device result to an attempt `{ device, request_id, job_number, command, dispositions }` at
// time `at` (an ISO string). Returns { applied }. A result that does not correlate, names an unknown status or
// claims what the op cannot have is not applied, and the attempt is unchanged.
export function applyResult(att, result, at) {
  if (!correlates(att, result) || !ALL_STATUSES.includes(result.status)) return { applied: false };
  const { op, args } = att.command;
  if (RADIO_STATUSES.includes(result.status) && !RADIO_OPS.includes(op)) return { applied: false };
  if (result.status === 'native_ack' && !(op === 'message.send' && args.kind === 'direct')) return { applied: false };
  const d = att.dispositions;
  if (result.status === 'transmitted') {
    const n = result.rf_count ?? 1;
    d.rf_transmitted = d.rf_transmitted ? { count: d.rf_transmitted.count + n, first_at: d.rf_transmitted.first_at, last_at: at } : { count: n, first_at: at, last_at: at };
  }
  if (result.status === 'native_ack' && d.native_ack === null) d.native_ack = at;
  d.device_answered = { status: result.status, at };
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
      const a = atts[s.request_id];
      a.dispositions.signed ??= at;
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

// Section 6: the origin rules for a multi-gateway send. A fixture of kind `origin`.
export const ORIGIN_STEPS = ['start', 'result', 'heard', 'authority', 'native_ack', 'tick'];
export const CLOSED_REASONS = ['native_ack', 'second_origin', 'no_second_origin', 'no_origin', 'no_automatic_retry'];
export function replayOrigins(setup, steps) {
  const gws = structuredClone(setup.gateways); // in order: the companion first where there is one, then repeaters
  const names = Object.keys(gws);
  const origins = [];
  let windowEnds = null;
  let closed = null;
  let ignored = 0;
  const eligible = (g) => g.eligible && g.reachable && g.authorized && (g.kind !== 'companion' || (g.connected && g.capable));
  const state = (scheduled) => ({
    origins: origins.map((o) => ({ ...o })), window_ends_at: windowEnds === null ? null : iso(setup.start, windowEnds), scheduled, closed, ignored_results: ignored,
  });
  return steps.map((s) => {
    const scheduled = [];
    const at = iso(setup.start, s.t);
    const choose = (candidates) => {
      const g = candidates[0];
      if (g) { origins.push({ gateway: g, result: null, transmitted_at: null }); scheduled.push(g); }
      return g;
    };
    if (s.step === 'start') {
      const companion = names.filter((n) => gws[n].kind === 'companion' && gws[n].connected && gws[n].capable && eligible(gws[n]));
      const repeaters = names.filter((n) => gws[n].kind === 'repeater' && eligible(gws[n]));
      if (!choose([...companion, ...repeaters])) closed = 'no_origin';
    } else if (s.step === 'result') {
      const o = origins.find((x) => x.gateway === s.gateway);
      if (!o || closed === 'native_ack' || (o.result !== null && o.result !== 'queued' && o.result !== 'duty_held')) ignored++;
      else {
        o.result = s.status;
        if (s.status === 'transmitted') {
          o.transmitted_at = at;
          gws[o.gateway].heard = true;
          if (o === origins[0]) windowEnds = s.t + setup.window_s; // the window starts only on a transmission
        } else if (o === origins[0] && ['refused', 'expired', 'failed', 'unknown'].includes(s.status) && closed === null) closed = 'no_automatic_retry';
      }
    } else if (s.step === 'heard') {
      gws[s.gateway].heard = true;
    } else if (s.step === 'authority') {
      gws[s.gateway].authorized = s.authorized;
    } else if (s.step === 'native_ack') {
      if (setup.message_kind !== 'direct' || origins.length === 0) ignored++;
      else if (closed === null) closed = 'native_ack';
    } else if (s.step === 'tick') {
      if (closed === null && origins.length === 1 && windowEnds !== null && s.t >= windowEnds) {
        // One further gateway that has neither heard nor transmitted the packet, authorised again just now.
        const rest = names.filter((n) => !origins.some((o) => o.gateway === n) && !gws[n].heard && eligible(gws[n]));
        closed = choose(rest) ? 'second_origin' : 'no_second_origin';
      }
    } else throw new Error(`unknown step ${s.step}`);
    return state(scheduled);
  });
}
