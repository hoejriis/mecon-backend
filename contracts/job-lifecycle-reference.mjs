// A reference model for the job lifecycle contract (contracts/job-lifecycle/v1): the rules of its README as code.
// The validator replays every fixture through it, and the fixture generator in scripts/ uses it to fill in
// expected outputs. It is a specification aid, not a Backend: no storage, no transport, no signing, and a clock
// that only the `advance` step moves. Commands, dispositions and correlation come from the device dispatch
// reference.
import { CATALOGUE, validateCommand, newDispositions, applyResult, correlates, classify, cancellable, iso } from './device-dispatch-reference.mjs';

export const DEFAULTS = { lease_s: 30, redeliver_s: 60, read_s: 300, abandon_s: 3600, ttl_s: 600 };
export const STATES = ['accepted', 'dispatched', 'running', 'succeeded', 'failed', 'refused', 'cancelled', 'expired', 'unknown'];
export const TERMINAL = ['succeeded', 'failed', 'refused', 'cancelled', 'expired', 'unknown'];
// Section 3: the only moves a job makes. A terminal state has none.
export const TRANSITIONS = {
  accepted: ['dispatched', 'cancelled', 'expired', 'refused'],
  dispatched: ['running', 'succeeded', 'failed', 'refused', 'cancelled', 'unknown'],
  running: ['succeeded', 'failed', 'cancelled', 'unknown'],
  succeeded: [], failed: [], refused: [], cancelled: [], expired: [], unknown: [],
};
// Section 3: which reasons an outcome may carry in each terminal state.
export const OUTCOME_REASONS = {
  succeeded: ['device_final'], failed: ['device_final'], refused: ['authority', 'nothing_ran'],
  cancelled: ['caller_before_dispatch', 'device_confirmed'], expired: ['expiry'],
  unknown: ['abandon_deadline', 'device_lost_job', 'device_reported_unknown'],
};
export const STEP_KINDS = ['create', 'read', 'list', 'claim', 'sign', 'deliver', 'transport_ack', 'device_answer', 'device_event', 'advance', 'restart', 'cancel', 'authority'];
export const ERRORS = {
  invalid: 'The request is not valid.',
  conflict: 'The request conflicts with an earlier request.',
  not_found: 'Not found.',
};

const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const last = (a) => a[a.length - 1];
const err = (code) => ({ outcome: 'error', error: { code, message: ERRORS[code] } });

class Engine {
  constructor(setup) {
    this.start = setup.start;
    this.devices = structuredClone(setup.devices);
    this.rights = structuredClone(setup.rights);
    this.now = 0;
    this.jobs = [];
    this.counters = { job: 0, att: 0, req: 0, ctl: 0 };
    this.numbers = {};
    this.idem = new Map();
    this.ignored = 0;
    this.out = [];
  }
  at = (s) => (s === null ? null : iso(this.start, s));
  find = (id) => this.jobs.find((j) => j.id === id);
  authorityOk(j) {
    const d = this.devices[j.device];
    return (this.rights[j.caller] ?? []).includes(j.device) && !!d && d.member && !d.blocked;
  }
  setState(j, to, outcome) {
    if (!TRANSITIONS[j.state].includes(to)) throw new Error(`${j.id}: ${j.state} to ${to} is not a transition`);
    j.state = to;
    if (TERMINAL.includes(to)) {
      j.outcome = { reason: outcome.reason, device_status: outcome.device_status ?? null, at: this.at(this.now) };
      j.claimed_by = null;
      j.lease_until = null;
    }
  }
  hasLease = (j, w) => j.claimed_by === w && j.lease_until > this.now;
  ignore() { this.ignored++; return { outcome: 'ignored' }; }
  nextNumber(device) { return (this.numbers[device] = (this.numbers[device] ?? 0) + 1); }

  // Section 7: expiry and the abandon deadline, evaluated whenever the clock is read.
  sweep() {
    for (const j of this.jobs) {
      if (TERMINAL.includes(j.state)) continue;
      const cur = last(j.attempts);
      const undelivered = j.need_attempt || cur.deliveries === 0;
      if (undelivered && this.now >= j.expires_s) {
        if (j.state === 'accepted') this.setState(j, 'expired', { reason: 'expiry' });
        else this.setState(j, 'refused', { reason: 'nothing_ran', device_status: cur.dispositions.device_answered?.status });
      } else if (!undelivered && this.now >= cur.signed_s + DEFAULTS.abandon_s) {
        this.setState(j, 'unknown', { reason: 'abandon_deadline' });
      }
    }
  }

  makeAttempt(j) {
    const c = this.counters;
    const a = {
      id: `att_${++c.att}`, request_id: `rq_${++c.req}`, job_number: this.nextNumber(j.device), deliveries: 0, nothing_ran: false, read_only: false,
      dispositions: newDispositions(), signed_s: this.now, first_delivery_s: null, last_delivery_s: null, answered_s: null,
    };
    a.bytes = `signed:${a.request_id}`;
    a.dispositions.signed = this.at(this.now);
    j.attempts.push(a);
    j.need_attempt = false;
    return a;
  }
  emit(j, target, kind, op, request_id, job_number, bytes, delivery) {
    this.out.push({ job: j.id, target, kind, op, job_number, request_id, bytes, delivery });
  }
  sendAttempt(j, a) {
    a.deliveries++;
    a.first_delivery_s ??= this.now;
    a.last_delivery_s = this.now;
    this.emit(j, a.id, 'attempt', j.command.op, a.request_id, a.job_number, a.bytes, a.deliveries);
    if (j.state === 'accepted') this.setState(j, 'dispatched');
  }
  // A job.get or message.get is a plain read: no job number of its own. A job.cancel is a signed request and takes one.
  sendControl(j, a, op) {
    const command = { op, args: op === 'message.get' ? { message: `msg_${a.job_number}` } : { target_job_number: a.job_number } };
    if (!validateCommand(command, this.devices[j.device].role, 'backend').valid) throw new Error('control is not a catalogue command');
    const c = this.counters;
    const ctl = {
      id: `ctl_${++c.ctl}`, op, device: j.device, request_id: `rq_${++c.req}`, job_number: op === 'job.cancel' ? this.nextNumber(j.device) : null,
      target_job_number: a.job_number, attempt: a.id, deliveries: 1, delivery_s: this.now, transport_accepted: null, device_answered: null,
    };
    ctl.bytes = `signed:${ctl.request_id}`;
    j.controls.push(ctl);
    this.emit(j, ctl.id, 'control', op, ctl.request_id, ctl.job_number, ctl.bytes, 1);
    return { outcome: 'sent', control: ctl.id, op };
  }

  create(s) {
    const ttl = s.ttl_s ?? DEFAULTS.ttl_s;
    const body = { device: s.device, command: s.command, ttl_s: ttl };
    const key = s.idempotency_key;
    if (key !== undefined) {
      const prior = this.idem.get(`${s.caller}|${key}`);
      if (prior) return canon(prior.body) === canon(body) ? { outcome: 'replayed', job_id: prior.job_id } : err('conflict');
    }
    const dev = this.devices[s.device];
    if (!dev || !(this.rights[s.caller] ?? []).includes(s.device) || !dev.member || dev.blocked) return err('not_found');
    if (!validateCommand(s.command, dev.role, 'caller').valid || !Number.isInteger(ttl) || ttl < 1 || ttl > 86400) return err('invalid');
    const j = {
      id: `job_${++this.counters.job}`, caller: s.caller, device: s.device, command: structuredClone(s.command), idempotency_key: key ?? null,
      state: 'accepted', created_s: this.now, updated_s: this.now, expires_s: this.now + ttl, claimed_by: null, lease_until: null,
      cancel_requested_s: null, halted: false, need_attempt: true, read_wanted: false, replay_retried: false, attempts: [], controls: [], events: [], outcome: null,
    };
    this.jobs.push(j);
    if (key !== undefined) this.idem.set(`${s.caller}|${key}`, { body, job_id: j.id });
    return { outcome: 'created', job_id: j.id };
  }
  read(s) {
    const j = this.find(s.job_id);
    return j && j.caller === s.caller ? { outcome: 'read', job_id: j.id } : err('not_found');
  }
  list(s) { return { outcome: 'listed', job_ids: this.jobs.filter((j) => j.caller === s.caller).map((j) => j.id) }; }
  // The lease is internal: it makes sure one deliverer at a time works on a job.
  claim(s) {
    const j = this.find(s.job);
    if (!j) return { outcome: 'unknown_job' };
    if (TERMINAL.includes(j.state)) return { outcome: 'not_claimable' };
    if (j.claimed_by !== null && j.claimed_by !== s.worker && j.lease_until > this.now) return { outcome: 'held' };
    j.claimed_by = s.worker;
    j.lease_until = this.now + DEFAULTS.lease_s;
    return { outcome: 'claimed' };
  }
  // Section 5: the signed bytes are stored with the attempt before anything is delivered.
  sign(s) {
    const j = this.find(s.job);
    if (!j) return { outcome: 'unknown_job' };
    if (TERMINAL.includes(j.state)) return { outcome: 'terminal' };
    if (!this.hasLease(j, s.worker)) return { outcome: 'not_leased' };
    if (!j.need_attempt) return { outcome: 'already_signed' };
    if (!this.authorityOk(j)) { this.setState(j, 'refused', { reason: 'authority' }); return { outcome: 'refused' }; }
    return { outcome: 'signed', attempt: this.makeAttempt(j).id };
  }
  otherOpen = (j) => this.jobs.some((o) => o !== j && o.device === j.device && ['dispatched', 'running'].includes(o.state));
  deliver(s) {
    const j = this.find(s.job);
    if (!j) return { outcome: 'unknown_job' };
    if (TERMINAL.includes(j.state)) return { outcome: 'terminal' };
    if (!this.hasLease(j, s.worker)) return { outcome: 'not_leased' };
    if (j.halted) return { outcome: 'halted' };
    const first = j.need_attempt || last(j.attempts).deliveries === 0;
    // Section 8: the authority check comes before every delivery, the first and each repeat, and before a new signing.
    if (!this.authorityOk(j)) {
      if (first) { this.setState(j, 'refused', { reason: 'authority' }); return { outcome: 'refused' }; }
      j.halted = true;
      return { outcome: 'halted' };
    }
    if (first) {
      const a = j.need_attempt ? this.makeAttempt(j) : last(j.attempts);
      this.sendAttempt(j, a);
      return { outcome: 'delivered', attempt: a.id, delivery: a.deliveries };
    }
    const cur = last(j.attempts);
    const answer = cur.dispositions.device_answered;
    // Section 8: a cancel goes out only once the device has acknowledged the job, while its latest state can still
    // be cancelled, and while no other request to the device is open.
    if (j.cancel_requested_s !== null && !j.controls.some((c) => c.op === 'job.cancel') && answer?.status === 'ok' && cancellable(j.command.op, answer.state) && !this.otherOpen(j)) {
      return this.sendControl(j, cur, 'job.cancel');
    }
    // Section 7: a status read when the job has been quiet, at most every 300 s; quiet runs from the latest answer,
    // or from the first delivery when there is none.
    const gets = j.controls.filter((c) => c.op !== 'job.cancel');
    const quietSince = Math.max(cur.first_delivery_s, cur.answered_s ?? 0);
    const due = this.now - quietSince >= DEFAULTS.read_s && gets.every((c) => this.now - c.delivery_s >= DEFAULTS.read_s);
    if (j.read_wanted || due) { j.read_wanted = false; return this.sendControl(j, cur, CATALOGUE.ops.find((o) => o.op === j.command.op).status_read); }
    if (j.state === 'dispatched' && !cur.read_only && this.now - cur.last_delivery_s >= DEFAULTS.redeliver_s) {
      this.sendAttempt(j, cur);
      return { outcome: 'redelivered', attempt: cur.id, delivery: cur.deliveries };
    }
    return { outcome: j.state === 'dispatched' && !cur.read_only ? 'too_soon' : 'idle' };
  }
  transport_ack(s) {
    const j = this.find(s.job);
    const a = j?.attempts.find((x) => x.id === s.target && x.deliveries > 0);
    const c = j?.controls.find((x) => x.id === s.target);
    if (a) a.dispositions.transport_accepted ??= this.at(this.now);
    else if (c) c.transport_accepted ??= this.at(this.now);
    else return { outcome: 'unknown_target' };
    return { outcome: 'recorded' };
  }
  device_answer(s) { return this.result(s, false); }
  device_event(s) { return this.result(s, true); }
  // Sections 4 and 6: correlate, then let the device's answer move the job, never backwards.
  result(s, isEvent) {
    const r = s.result;
    let hit = null;
    for (const j of this.jobs) {
      for (const a of j.attempts) if (correlates({ device: j.device, ...a }, r)) hit = { j, a, c: null };
      // A job.get names the job it reads, since it has no job number of its own.
      for (const c of j.controls) if (correlates({ device: j.device, request_id: c.request_id, job_number: c.job_number ?? c.target_job_number }, r)) hit = { j, a: j.attempts.find((x) => x.id === c.attempt), c };
    }
    if (!hit) return this.ignore();
    const { j, a, c } = hit;
    const cls = classify(r);
    if (!cls || TERMINAL.includes(j.state) || a.nothing_ran || a !== last(j.attempts)) return this.ignore();
    const k = cls.kind;
    if ((k === 'cancelled' && j.cancel_requested_s === null) || (['busy', 'replay', 'duplicate', 'job_open'].includes(k) && j.state !== 'dispatched')) return this.ignore();
    // A message.get that finds nothing says the message is not on the device: evicted, lost to a reboot or never
    // sent, which look the same. It settles nothing: the job stays where it is.
    if (c?.op === 'message.get' && k === 'unknown_state') {
      c.device_answered = { status: r.status, error: null, state: 'unknown', epoch: r.epoch ?? null, at: this.at(this.now) };
      a.answered_s = this.now;
      a.read_only = true; // the entry may have been evicted after it was sent: never deliver the message again
      return { outcome: 'applied' };
    }
    const bound = { device: j.device, request_id: a.request_id, job_number: a.job_number, command: j.command, dispositions: a.dispositions };
    if (!applyResult(bound, { ...r, signed_by: j.device, request_id: a.request_id, job_number: a.job_number }, this.at(this.now)).applied) return this.ignore();
    if (c) c.device_answered = { status: r.status, error: r.error ?? null, state: r.state ?? null, epoch: r.epoch ?? null, at: this.at(this.now) };
    a.answered_s = this.now;
    if (isEvent) j.events.push({ at: this.at(this.now), status: r.status, state: r.state ?? null, data: this.authorityOk(j) ? (r.data ?? null) : null });
    if (k === 'open') { if (j.state === 'dispatched') this.setState(j, 'running'); }
    else if (k === 'final_success') this.setState(j, 'succeeded', { reason: 'device_final', device_status: r.state });
    else if (k === 'final_failure') this.setState(j, 'failed', { reason: 'device_final', device_status: r.state });
    else if (k === 'failed') this.setState(j, 'failed', { reason: 'device_final', device_status: 'failed' });
    else if (k === 'cancelled') this.setState(j, 'cancelled', { reason: 'device_confirmed', device_status: 'cancelled' });
    else if (k === 'unknown_state') this.setState(j, 'unknown', { reason: 'device_reported_unknown', device_status: 'unknown' });
    else if (k === 'unknown_job') this.setState(j, 'unknown', { reason: 'device_lost_job' });
    else if (k === 'nothing_ran') this.setState(j, 'refused', { reason: 'nothing_ran', device_status: r.status });
    else if (k === 'job_open') this.setState(j, 'refused', { reason: 'nothing_ran', device_status: r.status });
    // busy: the attempt is kept; the next delivery on the 60 s cadence repeats the identical bytes.
    else if (k === 'duplicate') { a.read_only = true; j.read_wanted = true; }
    else if (k === 'replay') {
      if (a.deliveries === 1 && !j.replay_retried) {
        // Nothing ran: one new attempt, numbered above the device's mark. It is delivered, and signed, by the next delivery.
        a.nothing_ran = true;
        j.replay_retried = true;
        j.need_attempt = true;
        this.numbers[j.device] = Math.max(this.numbers[j.device] ?? 0, r.mark);
      } else { a.read_only = true; j.read_wanted = true; }
    }
    return { outcome: 'applied' };
  }
  cancel(s) {
    const j = this.find(s.job_id);
    if (!j || j.caller !== s.caller) return err('not_found');
    if (TERMINAL.includes(j.state) || j.cancel_requested_s !== null) return err('conflict');
    if (j.state === 'accepted' || j.need_attempt) {
      this.setState(j, 'cancelled', { reason: 'caller_before_dispatch' });
      return { outcome: 'cancelled' };
    }
    j.cancel_requested_s = this.now;
    return { outcome: 'cancel_requested' };
  }
  authority(s) {
    if (s.right !== undefined) {
      const list = (this.rights[s.caller] ??= []);
      this.rights[s.caller] = s.right ? [...new Set([...list, s.device])] : list.filter((d) => d !== s.device);
    }
    if (s.member !== undefined) this.devices[s.device].member = s.member;
    if (s.blocked !== undefined) this.devices[s.device].blocked = s.blocked;
    return { outcome: 'set' };
  }
  restart() {
    for (const j of this.jobs) { j.claimed_by = null; j.lease_until = null; }
    return { outcome: 'restarted' };
  }
  advance(s) { this.now += s.seconds; return { outcome: 'advanced' }; }

  // The creator's view of a job. The lease is internal and is not in it.
  view(j) {
    const t = (x) => this.at(x);
    return {
      id: j.id, caller: j.caller, device: j.device, command: j.command, idempotency_key: j.idempotency_key, state: j.state,
      created_at: t(j.created_s), updated_at: t(j.updated_s), expires_at: t(j.expires_s), cancel_requested_at: t(j.cancel_requested_s), redelivery_halted: j.halted,
      attempts: j.attempts.map((a) => ({ id: a.id, request_id: a.request_id, job_number: a.job_number, bytes: a.bytes, deliveries: a.deliveries, nothing_ran: a.nothing_ran, dispositions: a.dispositions })),
      controls: j.controls.map((c) => ({ id: c.id, op: c.op, request_id: c.request_id, job_number: c.job_number, target_job_number: c.target_job_number, attempt: c.attempt, bytes: c.bytes, deliveries: c.deliveries, transport_accepted: c.transport_accepted, device_answered: c.device_answered })),
      events: j.events, outcome: j.outcome,
    };
  }
  run(step) {
    if (!STEP_KINDS.includes(step.step)) throw new Error(`unknown step ${step.step}`);
    this.out = [];
    // updated_at moves when anything in the creator's view moves.
    const snap = (j) => JSON.stringify({ ...this.view(j), updated_at: 0 });
    const before = new Map(this.jobs.map((j) => [j, snap(j)]));
    this.sweep();
    const response = this[step.step](step);
    this.sweep();
    for (const j of this.jobs) if (before.get(j) !== snap(j)) j.updated_s = this.now;
    return { response, out: this.out, ignored_results: this.ignored, jobs: this.jobs.map((j) => this.view(j)) };
  }
}

// Replay a fixture's steps; the result of each step is what its `expect` must equal.
export function replayLifecycle(setup, steps) {
  const e = new Engine(setup);
  return steps.map((s) => structuredClone(e.run(s)));
}
