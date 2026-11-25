// Writes the fixtures of contracts/job-lifecycle/v1 (A to H) and contracts/device-dispatch/v1 (I, J, L) from the
// scripted steps below, with every step's expected output filled in by the reference models. Run from contracts/:
//   node scripts/gen-job-dispatch-fixtures.mjs
// Review the diff by hand: the references are specification aids, and a second implementation replaying the same
// fixtures is what checks them. Fixture K of each contract (documents the schemas reject) is written by hand.
import { writeFileSync } from 'node:fs';
import { replayLifecycle } from '../job-lifecycle-reference.mjs';
import { replayDispatch, replayCommands, replayOrigins, CONTRACT_VERSION } from '../device-dispatch-reference.mjs';

const START = '2026-01-01T00:00:00Z';
const write = (dir, name, doc) => writeFileSync(`${dir}/fixtures/${name}.json`, JSON.stringify(doc, null, 1) + '\n');

// ---- job lifecycle ----
const LDIR = 'job-lifecycle/v1';
const setup = () => ({
  start: START,
  devices: { dev_1: { role: 'companion', member: true, blocked: false }, dev_2: { role: 'companion', member: true, blocked: false } },
  rights: { cal_1: ['dev_1'], cal_2: ['dev_2'] },
});
const W1 = 'worker_1';
const W2 = 'worker_2';
const create = (o) => ({ step: 'create', caller: 'cal_1', device: 'dev_1', ...o });
const claim = (job, worker = W1) => ({ step: 'claim', worker, job });
const sign = (job, worker = W1) => ({ step: 'sign', worker, job });
const deliver = (job, worker = W1) => ({ step: 'deliver', worker, job });
const ack = (job, target) => ({ step: 'transport_ack', job, target });
const advance = (seconds) => ({ step: 'advance', seconds });
const cancel = (job_id, caller = 'cal_1') => ({ step: 'cancel', caller, job_id });
const read = (job_id, caller = 'cal_1') => ({ step: 'read', caller, job_id });
const list = (caller) => ({ step: 'list', caller });
const authority = (o) => ({ step: 'authority', ...o });
const result = (request_id, job_number, status, o = {}, signed_by = 'dev_1') => ({ signed_by, request_id, job_number, status, ...o });
const answer = (...a) => ({ step: 'device_answer', result: result(...a) });
const event = (...a) => ({ step: 'device_event', result: result(...a) });
const put = (n = 'ctc_1') => ({ op: 'contact.put', args: { contact_ref: n, name: 'Synthetic One' } });
const rm = (n = 'ctc_1') => ({ op: 'contact.remove', args: { contact_ref: n } });
const dm = { op: 'message.send', args: { kind: 'direct', target: 'ctc_2', text: 'synthetic hello' } };

const lifecycle = (fixture, title, steps) => {
  const s = setup();
  const got = replayLifecycle(s, steps);
  return { fixture, title, kind: 'lifecycle', contract_version: CONTRACT_VERSION, setup: s, steps: steps.map((st, i) => ({ ...st, expect: got[i] })) };
};

write(LDIR, 'A-happy-path', lifecycle('A', 'A job runs to succeeded: create, claim, deliver, progress, an event, the final answer', [
  create({ command: put(), idempotency_key: 'key-a' }), claim('job_1'), deliver('job_1'), ack('job_1', 'att_1'), advance(2),
  answer('rq_1', 1, 'progress'), advance(3), event('rq_1', 1, 'awaiting-confirm', { data: 'synthetic detail' }), advance(1),
  answer('rq_1', 1, 'ok'), read('job_1'),
]));

write(LDIR, 'B-idempotent-create', lifecycle('B', 'Idempotent create, a conflicting reuse of the key, and reads scoped to the creator', [
  create({ command: rm(), idempotency_key: 'k1' }), create({ command: rm(), idempotency_key: 'k1' }),
  create({ command: rm('ctc_2'), idempotency_key: 'k1' }),
  create({ caller: 'cal_2', device: 'dev_2', command: rm(), idempotency_key: 'k1' }),
  read('job_1', 'cal_2'), read('job_x'), read('job_99'), list('cal_1'), list('cal_2'),
  create({ device: 'dev_2', command: rm() }), create({ command: { op: 'job.get', args: { target_job_number: 1 } } }),
]));

write(LDIR, 'C-crash-and-second-worker', lifecycle('C', 'A worker stores the signed bytes and delivers, then is gone; a second worker re-delivers the same bytes after the lease lapses', [
  create({ command: dm }), claim('job_1'), sign('job_1'), deliver('job_1'), deliver('job_1', W2), advance(31), claim('job_1', W2),
  deliver('job_1', W2), advance(30), claim('job_1', W2), deliver('job_1', W2), { step: 'restart' }, deliver('job_1', W2),
]));

write(LDIR, 'D-no-answer-unknown', lifecycle('D', 'No answer: identical re-delivery, a status read after 15 minutes, and unknown (never failed) at 3600 s', [
  create({ command: { op: 'packet.transmit', args: { packet_hex: '0a0b0c0d' } } }), claim('job_1'), deliver('job_1'), advance(61), claim('job_1'),
  deliver('job_1'), advance(840), claim('job_1'), deliver('job_1'), advance(2699), advance(1), answer('rq_1', 1, 'ok'),
]));

write(LDIR, 'E-nothing-ran', lifecycle('E', 'The nothing-ran rule: a new attempt, no new attempt after a re-delivery, and the expiry bound', [
  create({ command: put() }), claim('job_1'), deliver('job_1'), answer('rq_1', 1, 'replay'), deliver('job_1'), answer('rq_1', 1, 'replay'),
  answer('rq_2', 2, 'ok'),
  create({ command: put('ctc_2') }), claim('job_2'), deliver('job_2'), advance(61), claim('job_2'), deliver('job_2'), answer('rq_3', 3, 'replay'),
  deliver('job_2'), answer('rq_4', 4, 'ok'),
  create({ command: put('ctc_3'), ttl_s: 100 }), claim('job_3'), deliver('job_3'), advance(101), answer('rq_5', 5, 'busy'),
  create({ command: put('ctc_4') }), claim('job_4'), deliver('job_4'), answer('rq_6', 6, 'busy'), deliver('job_4'), answer('rq_7', 7, 'progress'),
  answer('rq_7', 7, 'reverted'),
]));

write(LDIR, 'F-cancel', lifecycle('F', 'Cancel before dispatch, after dispatch (the outcome may still be succeeded), confirmed by the device, and when the device cannot cancel', [
  create({ command: put() }), cancel('job_1'), claim('job_1'), cancel('job_1'),
  create({ command: put('ctc_2') }), claim('job_2'), deliver('job_2'), cancel('job_2'), deliver('job_2'), cancel('job_2'), ack('job_2', 'ctl_1'),
  answer('rq_1', 1, 'ok'), cancel('job_2'),
  create({ command: put('ctc_3') }), claim('job_3'), deliver('job_3'), cancel('job_3'), deliver('job_3'), answer('rq_3', 3, 'cancelled'),
  create({ command: put('ctc_4') }), claim('job_4'), deliver('job_4'), answer('rq_5', 5, 'applied'), cancel('job_4'), deliver('job_4'),
  answer('rq_5', 5, 'applied-final'),
]));

write(LDIR, 'G-authority', lifecycle('G', 'Authority re-checked before every delivery: refused before the first, re-delivery stops after, blocked flag, and events after the device left reach', [
  create({ command: put() }), claim('job_1'), authority({ caller: 'cal_1', device: 'dev_1', right: false }), deliver('job_1'),
  authority({ caller: 'cal_1', device: 'dev_1', right: true }),
  create({ command: put('ctc_2') }), claim('job_2'), deliver('job_2'), authority({ device: 'dev_1', member: false }), advance(61), claim('job_2'),
  deliver('job_2'), authority({ device: 'dev_1', member: true }), deliver('job_2'), advance(3600),
  create({ command: put('ctc_3') }), claim('job_3'), authority({ device: 'dev_1', blocked: true }), deliver('job_3'),
  create({ command: put('ctc_4') }), authority({ device: 'dev_1', blocked: false }),
  create({ command: put('ctc_4') }), claim('job_4'), deliver('job_4'), answer('rq_2', 2, 'progress'), authority({ device: 'dev_1', member: false }),
  event('rq_2', 2, 'awaiting-confirm', { data: 'after leaving reach' }),
]));

write(LDIR, 'H-forged-and-late', lifecycle('H', 'Results that are unsigned, from another device, or name the wrong request or job number are ignored and counted; late results never move a terminal job', [
  create({ command: put() }), claim('job_1'), deliver('job_1'),
  answer('rq_1', 1, 'ok', {}, null), answer('rq_1', 1, 'ok', {}, 'dev_2'), answer('rq_1', 99, 'ok'), answer('rq_9', 1, 'ok'), answer('rq_1', 1, 'native_ack'),
  answer('rq_1', 1, 'progress'), answer('rq_1', 1, 'ok'), event('rq_1', 1, 'progress'), answer('rq_1', 1, 'ok'),
]));

// ---- device dispatch ----
const DDIR = 'device-dispatch/v1';
const dispatchStep = (step, t, o = {}) => ({ step, t, ...o });
const res = (request_id, job_number, status, o = {}) => ({ signed_by: 'dev_1', request_id, job_number, status, ...o });
{
  const s = {
    start: START,
    attempts: [
      { request_id: 'rq_1', device: 'dev_1', role: 'companion', job_number: 1, command: dm },
      { request_id: 'rq_2', device: 'dev_1', role: 'companion', job_number: 2, command: { op: 'message.send', args: { kind: 'channel', target: 'chan_1', text: 'synthetic broadcast' } } },
      { request_id: 'rq_3', device: 'dev_1', role: 'companion', job_number: 3, command: put() },
    ],
  };
  const steps = [
    dispatchStep('sign', 0, { request_id: 'rq_1' }), dispatchStep('sign', 0, { request_id: 'rq_2' }),
    dispatchStep('transport_accept', 1, { request_id: 'rq_1' }), dispatchStep('transport_accept', 1, { request_id: 'rq_2' }),
    dispatchStep('transport_accept', 1, { request_id: 'rq_3' }),
    dispatchStep('result', 2, { result: res('rq_1', 1, 'queued') }), dispatchStep('result', 3, { result: res('rq_3', 3, 'ok') }),
    dispatchStep('result', 5, { result: res('rq_1', 1, 'duty_held') }),
    dispatchStep('result', 10, { result: res('rq_1', 1, 'transmitted', { rf_count: 1 }) }), dispatchStep('result', 11, { result: res('rq_2', 2, 'transmitted') }),
    dispatchStep('result', 12, { result: res('rq_1', 1, 'transmitted', { rf_count: 1 }) }), dispatchStep('result', 13, { result: res('rq_2', 2, 'native_ack') }),
    dispatchStep('result', 14, { result: res('rq_1', 1, 'native_ack') }), dispatchStep('result', 20, { result: res('rq_1', 1, 'ok') }),
    dispatchStep('result', 21, { result: res('rq_2', 2, 'ok') }),
  ];
  const got = replayDispatch(s, steps);
  write(DDIR, 'I-dispositions', { fixture: 'I', title: 'Dispositions kept distinct: broker acceptance, duty hold, transmission, a native ACK on a direct message and never on a channel', kind: 'dispatch', contract_version: CONTRACT_VERSION, setup: s, steps: steps.map((st, i) => ({ ...st, expect: got[i] })) });
}
{
  const cases = [
    { note: 'contact.put by a caller to a companion', by: 'caller', role: 'companion', command: put() },
    { note: 'contact.remove by a caller to a companion', by: 'caller', role: 'companion', command: rm() },
    { note: 'message.send, direct, by a caller to a companion', by: 'caller', role: 'companion', command: dm },
    { note: 'packet.transmit to a repeater', by: 'caller', role: 'repeater', command: { op: 'packet.transmit', args: { packet_hex: '0a0b0c0d' } } },
    { note: 'config.apply to a repeater', by: 'caller', role: 'repeater', command: { op: 'config.apply', args: { settings: { tx_power: 14, repeat: true } } } },
    { note: 'job.cancel signed by the Backend', by: 'backend', role: 'companion', command: { op: 'job.cancel', args: { target_job_number: 4 } } },
    { note: 'job.get signed by the Backend', by: 'backend', role: 'repeater', command: { op: 'job.get', args: { target_job_number: 4 } } },
    { note: 'an op the catalogue does not list', by: 'caller', role: 'companion', command: { op: 'device.reboot', args: {} } },
    { note: 'job.get requested by a caller', by: 'caller', role: 'companion', command: { op: 'job.get', args: { target_job_number: 4 } } },
    { note: 'contact.put to a repeater: a known op for the wrong role', by: 'caller', role: 'repeater', command: put() },
    { note: 'message.send to a repeater', by: 'caller', role: 'repeater', command: dm },
    { note: 'contact.remove with no args', by: 'caller', role: 'companion', command: { op: 'contact.remove', args: {} } },
    { note: 'contact.remove with an extra arg', by: 'caller', role: 'companion', command: { op: 'contact.remove', args: { contact_ref: 'ctc_1', force: true } } },
    { note: 'contact.remove with no args key at all', by: 'caller', role: 'companion', command: { op: 'contact.remove' } },
    { note: 'a command with an extra top-level key', by: 'caller', role: 'companion', command: { op: 'contact.remove', args: { contact_ref: 'ctc_1' }, raw: 'x' } },
    { note: 'message.send with a kind outside the enum', by: 'caller', role: 'companion', command: { op: 'message.send', args: { kind: 'broadcast', target: 'ctc_2', text: 'x' } } },
    { note: 'packet.transmit with an odd number of hex digits', by: 'caller', role: 'repeater', command: { op: 'packet.transmit', args: { packet_hex: '0a0b0c0' } } },
    { note: 'config.apply with no settings', by: 'caller', role: 'repeater', command: { op: 'config.apply', args: { settings: {} } } },
    { note: 'an op that is not a string', by: 'caller', role: 'companion', command: { op: 7, args: {} } },
    { note: 'a command that is not an object', by: 'caller', role: 'companion', command: 'contact.put' },
    { note: 'job.cancel with job number 0, signed by the Backend', by: 'backend', role: 'companion', command: { op: 'job.cancel', args: { target_job_number: 0 } } },
  ];
  const got = replayCommands(cases);
  write(DDIR, 'J-typed-commands', { fixture: 'J', title: 'Typed commands: every catalogue op accepted, and invalid commands refused before anything is signed', kind: 'commands', contract_version: CONTRACT_VERSION, cases: cases.map((c, i) => ({ ...c, expect: got[i] })) });
}
{
  const gw = (kind, o = {}) => ({ kind, connected: kind === 'companion', capable: kind === 'companion', eligible: true, reachable: true, authorized: true, heard: false, ...o });
  const run = (note, message_kind, gateways, steps, window_s = 12) => {
    const s = { start: START, message_kind, window_s, gateways };
    const got = replayOrigins(s, steps);
    return { note, setup: s, steps: steps.map((st, i) => ({ ...st, expect: got[i] })) };
  };
  const o = (step, t, x = {}) => ({ step, t, ...x });
  const runs = [
    run('A direct message: the companion first; queued and duty-held start no window; a second gateway only after the window, skipping one that heard the packet', 'direct',
      { comp: gw('companion'), rep_1: gw('repeater'), rep_2: gw('repeater') },
      [o('start', 0), o('result', 1, { gateway: 'comp', status: 'queued' }), o('result', 5, { gateway: 'comp', status: 'duty_held' }), o('tick', 25),
        o('result', 30, { gateway: 'comp', status: 'transmitted' }), o('tick', 41), o('heard', 41, { gateway: 'rep_1' }), o('tick', 42),
        o('result', 43, { gateway: 'rep_2', status: 'transmitted' })]),
    run('A native ACK stops scheduling', 'direct', { comp: gw('companion'), rep_1: gw('repeater') },
      [o('start', 0), o('result', 2, { gateway: 'comp', status: 'transmitted' }), o('native_ack', 6), o('tick', 20)]),
    run('A channel message: no companion connected, so one repeater; an ACK on a channel is ignored; a gateway no longer authorised is skipped', 'channel',
      { comp: gw('companion', { connected: false }), rep_1: gw('repeater'), rep_2: gw('repeater'), rep_3: gw('repeater') },
      [o('start', 0), o('result', 3, { gateway: 'rep_1', status: 'transmitted' }), o('native_ack', 5), o('authority', 8, { gateway: 'rep_2', authorized: false }),
        o('tick', 15), o('result', 16, { gateway: 'rep_9', status: 'transmitted' })]),
    run('An ambiguous origin is never resent and no other origin is picked', 'direct', { comp: gw('companion'), rep_1: gw('repeater') },
      [o('start', 0), o('result', 4, { gateway: 'comp', status: 'unknown' }), o('tick', 100)]),
    run('No eligible origin', 'direct', { comp: gw('companion', { capable: false }), rep_1: gw('repeater', { reachable: false }) }, [o('start', 0), o('tick', 50)]),
    run('Only one gateway: no second origin', 'channel', { comp: gw('companion') },
      [o('start', 0), o('result', 2, { gateway: 'comp', status: 'transmitted' }), o('tick', 14)], 10),
    ...['refused', 'expired', 'failed'].map((status) => run(`The first origin answers ${status}: nothing was transmitted, so no window starts and nothing else is tried`, 'direct',
      { comp: gw('companion'), rep_1: gw('repeater') },
      [o('start', 0), o('result', 3, { gateway: 'comp', status }), o('tick', 60)])),
  ];
  write(DDIR, 'L-origins', { fixture: 'L', title: 'Origin rules for a multi-gateway send', kind: 'origin', contract_version: CONTRACT_VERSION, runs });
}
