// Validates the device dispatch contract (contracts/device-dispatch/v1): the catalogue, every schema, every fixture
// against fixtures.schema.json and its item schemas, a replay of each fixture through the reference model, the
// invariants of README sections 2 to 6, that every fixture is used and that every catalogue op, step kind, command
// reason and origin result is covered by a fixture, and the README's references. Called from validate.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkReadme } from './validate-common.mjs';
import {
  CONTRACT_VERSION, CATALOGUE, iso, replayDispatch, replayCommands, replayOrigins, DISPATCH_STEPS, ORIGIN_STEPS, COMMAND_REASONS, ORIGIN_RESULTS, RADIO_OPS, ALL_STATES,
} from './device-dispatch-reference.mjs';

const SCHEMAS = ['command', 'result', 'dispositions', 'origin-state'];
export const ID = (contract, name) => `https://example.test/mecon/${contract}/v1/${name}`;

export function validateDeviceDispatch(dir = 'device-dispatch/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', `device-dispatch/v1: ${m}`); };
  const ok = (m) => { checked++; console.log('ok  ', `device-dispatch/v1/${m}`); };
  const readJson = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  const files = readdirSync(join(dir, 'schemas')).filter((f) => f.endsWith('.json')).sort();
  const expected = [...SCHEMAS.map((s) => `${s}.schema.json`), 'catalogue.json'].sort();
  for (const f of expected) if (!files.includes(f)) fail(`schemas/${f} is missing`);
  for (const f of files) if (!expected.includes(f)) fail(`schemas/${f} is not part of the contract`);
  const v = {};
  for (const s of SCHEMAS) {
    try { ajv.addSchema(readJson(`schemas/${s}.schema.json`)); } catch (e) { fail(`schemas/${s}.schema.json: ${e.message}`); }
  }
  for (const s of SCHEMAS) {
    try { v[s] = ajv.getSchema(ID('device-dispatch', s)); if (!v[s]) throw new Error('not registered'); ok(`schemas/${s}.schema.json`); } catch (e) { fail(`schemas/${s}.schema.json: ${e.message}`); }
  }
  const fixtureFiles = checkReadme(dir, files, fail);
  ok('README.md references every schema and fixture, and carries no host name, issue number or token');

  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const version = /version `([^`]+)`/.exec(readme)?.[1];
  if (version !== CONTRACT_VERSION) fail(`README version ${version} is not the reference's ${CONTRACT_VERSION}`);
  if (CATALOGUE.catalogue_version !== version) fail('schemas/catalogue.json catalogue_version is not the README version');

  // The catalogue: every op described, its args schema valid, and the README naming it.
  const seenOps = new Set();
  const before = failures;
  for (const o of CATALOGUE.ops) {
    if (seenOps.has(o.op)) fail(`catalogue: ${o.op} is listed twice`);
    seenOps.add(o.op);
    if (!/^[a-z]+\.[a-z]+$/.test(o.op)) fail(`catalogue: ${o.op} is not a valid op name`);
    if (!Array.isArray(o.roles) || !o.roles.length || o.roles.some((r) => !['companion', 'repeater'].includes(r))) fail(`catalogue: ${o.op} roles`);
    if (!Array.isArray(o.cancellable_states) || o.cancellable_states.some((x) => !ALL_STATES.includes(x)) || (o.internal && o.cancellable_states.length)) fail(`catalogue: ${o.op} cancellable_states`);
    if (o.internal ? o.status_read !== null : !CATALOGUE.ops.some((x) => x.op === o.status_read && x.internal && !x.changes_state)) fail(`catalogue: ${o.op} status_read must be null for an internal op, else an internal read op`);
    if (typeof o.changes_state !== 'boolean' || typeof o.internal !== 'boolean') fail(`catalogue: ${o.op} changes_state and internal must be booleans`);
    if (o.args?.type !== 'object' || o.args.additionalProperties !== false || !Array.isArray(o.args.required)) fail(`catalogue: ${o.op} args must be a closed object schema with required fields`);
    if (!readme.includes(`\`${o.op}\``)) fail(`README.md does not name ${o.op}`);
    try { new Ajv2020({ strict: false }).compile(o.args); } catch (e) { fail(`catalogue: ${o.op} args: ${e.message}`); }
  }
  if (failures === before) ok('schemas/catalogue.json');

  const docs = {};
  const fixtureSchema = ajv.compile(readJson('fixtures.schema.json'));
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) { fail(`fixtures/${f}: ${JSON.stringify(fixtureSchema.errors)}`); continue; }
    if (doc.contract_version !== version) fail(`fixtures/${f}: contract_version is not the README's ${version}`);
    docs[f] = doc;
  }

  const coverage = { ops: new Set(), reasons: new Set(), dispatch: new Set(), origin: new Set(), results: new Set() };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [f, doc] of Object.entries(docs)) {
    const b0 = failures;
    const stripped = (steps) => steps.map(({ expect, ...rest }) => rest);
    if (doc.kind === 'dispatch') {
      const got = replayDispatch(doc.setup, stripped(doc.steps));
      let last = 0;
      const prev = {};
      doc.steps.forEach((s, i) => {
        coverage.dispatch.add(s.step);
        if (s.t < last) fail(`fixtures/${f}: step ${i + 1} goes back in time`);
        last = s.t;
        if (!same(s.expect, got[i])) fail(`fixtures/${f}: step ${i + 1} expect differs from the replay: ${JSON.stringify(got[i])}`);
        for (const [rq, d] of Object.entries(s.expect.attempts)) {
          if (!v.dispositions(d)) fail(`fixtures/${f}: step ${i + 1} ${rq} ${JSON.stringify(v.dispositions.errors)}`);
          const att = doc.setup.attempts.find((a) => a.request_id === rq);
          if (s.step === 'transport_accept' && s.request_id === rq && prev[rq] && !same(prev[rq].device_answered, d.device_answered)) fail(`fixtures/${f}: step ${i + 1} broker acceptance changed the device answer`);
          if (d.acked !== null && !(att.command.op === 'message.send' && att.command.args.kind === 'direct')) fail(`fixtures/${f}: ${rq} has a native ACK (acked) where the message is not direct`);
          if (d.rf_transmitted !== null && !RADIO_OPS.includes(att.command.op)) fail(`fixtures/${f}: ${rq} has a radio transmission for ${att.command.op}`);
          if (d.transport_accepted !== null && d.signed === null) fail(`fixtures/${f}: ${rq} was accepted by a transport without being signed`);
          if (prev[rq]) {
            for (const k of ['signed', 'transport_accepted', 'acked']) if (prev[rq][k] !== null && prev[rq][k] !== d[k]) fail(`fixtures/${f}: ${rq} ${k} changed once set`);
            if (prev[rq].rf_transmitted && (d.rf_transmitted.count < prev[rq].rf_transmitted.count || d.rf_transmitted.first_at !== prev[rq].rf_transmitted.first_at)) fail(`fixtures/${f}: ${rq} rf_transmitted went backwards`);
          }
          prev[rq] = d;
        }
      });
      for (const a of doc.setup.attempts) coverage.ops.add(a.command.op);
    } else if (doc.kind === 'commands') {
      const got = replayCommands(doc.cases);
      doc.cases.forEach((c, i) => {
        if (!same(c.expect, got[i])) fail(`fixtures/${f}: cases[${i}] (${c.note}) expect differs from the replay: ${JSON.stringify(got[i])}`);
        if (c.expect.valid) coverage.ops.add(c.command.op);
        else { if (!COMMAND_REASONS.includes(c.expect.reason)) fail(`fixtures/${f}: cases[${i}] reason ${c.expect.reason}`); coverage.reasons.add(c.expect.reason); }
      });
    } else if (doc.kind === 'origin') {
      doc.runs.forEach((run, ri) => {
        const got = replayOrigins(run.setup, stripped(run.steps));
        const st = run.setup;
        if (st.window_s < 10 || st.window_s > 15) fail(`fixtures/${f}: runs[${ri}] window_s must be 10 to 15`);
        if (st.packet_fixed !== true || st.companion_timeout_s !== 120 || st.lifetime_s !== 600) fail(`fixtures/${f}: runs[${ri}] must be a fixed-bytes packet send with a Companion timeout of 120 s and a lifetime of 600 s`);
        if (JSON.stringify([...st.order].sort()) !== JSON.stringify(Object.keys(st.gateways).sort())) fail(`fixtures/${f}: runs[${ri}] order is not a seeded order of every gateway`);
        let prev = null;
        let ackAt = null;
        run.steps.forEach((s, i) => {
          coverage.origin.add(s.step);
          const e = s.expect;
          const at = `fixtures/${f}: runs[${ri}] step ${i + 1}`;
          if (!v['origin-state'](e)) fail(`${at} ${JSON.stringify(v['origin-state'].errors)}`);
          if (!same(e, got[i])) fail(`${at} expect differs from the replay: ${JSON.stringify(got[i])}`);
          for (const o of e.origins) coverage.results.add(o.result);
          if (new Set(e.origins.map((o) => o.gateway)).size !== e.origins.length) fail(`${at} an origin repeats`);
          if (e.scheduled.length > 1) fail(`${at} more than one origin in one round`);
          // A further origin comes only when the last one ended without transmitting, or when the window or the Companion's 120 s has run out.
          if (e.scheduled.length && prev && prev.origins.length) {
            const lastNow = e.origins[prev.origins.length - 1];
            const failedNow = ['refused', 'expired', 'failed', 'unknown'].includes(lastNow.result);
            const due = prev.next_round_at !== null && iso(st.start, s.t) >= prev.next_round_at;
            if (!failedNow && !due) fail(`${at} a further origin was scheduled before its round was due`);
          }
          if (prev?.closed !== null && prev?.closed !== undefined && e.scheduled.length) fail(`${at} an origin after the scheduling closed`);
          if (e.closed === 'native_ack' && st.message_kind !== 'direct') fail(`${at} a native ACK stopped a channel message`);
          if (e.closed === 'lifetime' && s.t < st.lifetime_s) fail(`${at} closed before the lifetime`);
          if ((e.cancel_sent.length || e.cancel_given_up.length) && !['native_ack', 'cancel_result'].includes(s.step)) fail(`${at} a cancel outside a native ACK`);
          if (e.cancel_given_up.length && s.t < ackAt + 300) fail(`${at} a cancel given up before 300 s`);
          if (s.step === 'native_ack' && e.closed === 'native_ack') ackAt ??= s.t;
          for (const g of e.cancel_sent) {
            const before = prev?.origins.find((o) => o.gateway === g);
            if (!before || !['queued', 'duty-held', null].includes(before.result)) fail(`${at} a cancel to ${g}, whose job is no longer cancellable`);
            if (st.gateways[g].kind !== 'repeater') fail(`${at} a cancel to ${g}, which is not a Repeater origin`);
          }
          prev = e;
        });
      });
    } else if (doc.kind === 'invalid') {
      doc.cases.forEach((c, i) => { if (v[c.schema](c.value)) fail(`fixtures/${f}: cases[${i}] (${c.note}) passes ${c.schema}, which must reject it`); });
    }
    if (failures === b0) ok(`fixtures/${f}`);
  }
  const lacking = (what, all, seen) => { for (const x of all) if (!seen.has(x)) fail(`no fixture covers ${what} ${x}`); };
  lacking('catalogue op', CATALOGUE.ops.map((o) => o.op), coverage.ops);
  lacking('command reason', COMMAND_REASONS, coverage.reasons);
  lacking('dispatch step', DISPATCH_STEPS, coverage.dispatch);
  lacking('origin step', ORIGIN_STEPS, coverage.origin);
  lacking('origin result', ORIGIN_RESULTS, coverage.results);
  ok('every catalogue op, command reason, step kind and origin result is covered by a fixture');
  return { checked, failures };
}
