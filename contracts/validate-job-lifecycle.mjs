// Validates the job lifecycle contract (contracts/job-lifecycle/v1): every schema, every fixture against
// fixtures.schema.json and its item schemas, a replay of each fixture through the reference model, the invariants
// of README sections 3 to 9 (the transition table, terminal states that never change, job numbers, stored bytes,
// delivery counts, caller-scoped reads, fixed error bodies), that every step kind is covered by a fixture, and the
// README's references. Called from validate.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkReadme } from './validate-common.mjs';
import { CONTRACT_VERSION, CATALOGUE, ANSWER_STATUSES, ERROR_CODES } from './device-dispatch-reference.mjs';
import { replayLifecycle, STEP_KINDS, STATES, TERMINAL, TRANSITIONS, OUTCOME_REASONS, ERRORS } from './job-lifecycle-reference.mjs';

const SCHEMAS = ['job', 'attempt', 'control', 'outcome', 'error', 'response', 'delivery', 'create-request'];
const DEVICE_SCHEMAS = ['command', 'result', 'dispositions'];
const ID = (contract, name) => `https://example.test/mecon/${contract}/v1/${name}`;

export function validateJobLifecycle(dir = 'job-lifecycle/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', `job-lifecycle/v1: ${m}`); };
  const ok = (m) => { checked++; console.log('ok  ', `job-lifecycle/v1/${m}`); };
  const readJson = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  // The device dispatch schemas are referenced by $id from these; they are registered first.
  for (const s of DEVICE_SCHEMAS) ajv.addSchema(JSON.parse(readFileSync(join('device-dispatch/v1/schemas', `${s}.schema.json`), 'utf8')));
  const files = readdirSync(join(dir, 'schemas')).filter((f) => f.endsWith('.json')).sort();
  for (const s of SCHEMAS) if (!files.includes(`${s}.schema.json`)) fail(`schemas/${s}.schema.json is missing`);
  for (const f of files) if (!SCHEMAS.includes(f.replace('.schema.json', ''))) fail(`schemas/${f} is not part of the contract`);
  for (const s of SCHEMAS) {
    try { ajv.addSchema(readJson(`schemas/${s}.schema.json`)); } catch (e) { fail(`schemas/${s}.schema.json: ${e.message}`); }
  }
  const v = {};
  for (const s of SCHEMAS) {
    try { v[s] = ajv.getSchema(ID('job-lifecycle', s)); if (!v[s]) throw new Error('not registered'); ok(`schemas/${s}.schema.json`); } catch (e) { fail(`schemas/${s}.schema.json: ${e.message}`); }
  }
  const fixtureFiles = checkReadme(dir, files, fail);
  ok('README.md references every schema and fixture, and carries no host name, issue number or token');

  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const version = /version `([^`]+)`/.exec(readme)?.[1];
  const dispatchVersion = /version `([^`]+)`/.exec(readFileSync('device-dispatch/v1/README.md', 'utf8'))?.[1];
  if (version !== CONTRACT_VERSION || dispatchVersion !== version) fail(`versions differ: job lifecycle ${version}, device dispatch ${dispatchVersion}, reference ${CONTRACT_VERSION}`);
  for (const s of STATES) if (!readme.includes(`\`${s}\``)) fail(`README.md does not name the state ${s}`);

  const docs = {};
  const fixtureSchema = ajv.compile(readJson('fixtures.schema.json'));
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) { fail(`fixtures/${f}: ${JSON.stringify(fixtureSchema.errors)}`); continue; }
    if (doc.contract_version !== version) fail(`fixtures/${f}: contract_version is not the README's ${version}`);
    docs[f] = doc;
  }

  const covered = new Set();
  const answers = { statuses: new Set(), errors: new Set() };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const num = (id) => Number(id.split('_')[1]);
  for (const [f, doc] of Object.entries(docs)) {
    const b0 = failures;
    if (doc.kind === 'invalid') {
      doc.cases.forEach((c, i) => { if (v[c.schema](c.value)) fail(`fixtures/${f}: cases[${i}] (${c.note}) passes ${c.schema}, which must reject it`); });
      if (failures === b0) ok(`fixtures/${f}`);
      continue;
    }
    const steps = doc.steps.map(({ expect, ...rest }) => rest);
    let got;
    try { got = replayLifecycle(doc.setup, steps); } catch (e) { fail(`fixtures/${f}: the reference model failed: ${e.message}`); continue; }
    let prevJobs = new Map();
    let prevIgnored = 0;
    const deliveries = new Map(); // attempt or control id (per job) to the deliveries emitted so far
    doc.steps.forEach((s, i) => {
      const where = `fixtures/${f}: step ${i + 1} (${s.step})`;
      covered.add(s.step);
      const e = s.expect;
      if (!same(e, got[i])) { fail(`${where} expect differs from the replay: ${JSON.stringify(got[i])}`); return; }
      if (!v.response(e.response)) fail(`${where} response ${JSON.stringify(v.response.errors)}`);
      if (e.response.error && !same(e.response.error.message, ERRORS[e.response.error.code])) fail(`${where} error body is not the fixed one`);
      e.out.forEach((o, k) => { if (!v.delivery(o)) fail(`${where} out[${k}] ${JSON.stringify(v.delivery.errors)}`); });
      e.jobs.forEach((j, k) => { if (!v.job(j)) fail(`${where} jobs[${k}] ${JSON.stringify(v.job.errors)}`); });
      if (e.ignored_results < prevIgnored) fail(`${where} ignored_results went down`);
      prevIgnored = e.ignored_results;
      const now = new Map(e.jobs.map((j) => [j.id, j]));
      for (const [id, p] of prevJobs) if (!now.has(id)) fail(`${where} ${id} disappeared`);
      for (const j of e.jobs) {
        const p = prevJobs.get(j.id);
        if (p) {
          // Section 3: a terminal state never changes; every other move is in the table.
          if (p.state !== j.state && !TRANSITIONS[p.state].includes(j.state)) fail(`${where} ${j.id} moved ${p.state} to ${j.state}, which is not a transition`);
          if (TERMINAL.includes(p.state) && (!same(p.outcome, j.outcome) || p.state !== j.state)) fail(`${where} ${j.id} changed after ${p.state}`);
          // Section 5: stored bytes and job numbers never change; deliveries never go down.
          p.attempts.forEach((a, k) => {
            const b = j.attempts[k];
            if (!b || a.bytes !== b.bytes || a.job_number !== b.job_number || a.request_id !== b.request_id) fail(`${where} ${j.id} ${a.id} was re-signed or changed`);
            else if (b.deliveries < a.deliveries) fail(`${where} ${j.id} ${a.id} deliveries went down`);
          });
        }
        if (TERMINAL.includes(j.state) && !OUTCOME_REASONS[j.state].includes(j.outcome?.reason)) fail(`${where} ${j.id} ${j.state} carries the reason ${j.outcome?.reason}`);
        if (j.state === 'unknown' && ['abandon_deadline', 'device_lost_job'].includes(j.outcome.reason) && j.outcome.device_status !== null) fail(`${where} ${j.id} ${j.outcome.reason} carries a device status`);
        if (j.state === 'failed' && j.outcome.reason !== 'device_final') fail(`${where} ${j.id} failed without the device's say`);
        if (j.attempts.length > 1 && !j.attempts.slice(0, -1).every((a) => a.nothing_ran)) fail(`${where} ${j.id} has a new attempt after an attempt that may have run`);
        if (j.attempts.length > 2) fail(`${where} ${j.id} has more than one new attempt`);
        for (const a of j.attempts) {
          if (a.nothing_ran && !(a.dispositions.device_answered?.status === 'refused' && a.dispositions.device_answered.error === 'replay' && a.deliveries === 1)) fail(`${where} ${j.id} ${a.id} is marked nothing ran without a replay after one delivery`);
        }
        const lastAtt = j.attempts[j.attempts.length - 1];
        if (j.state === 'unknown' && j.outcome.reason === 'abandon_deadline' && Date.parse(j.outcome.at) - Date.parse(lastAtt.dispositions.signed) < 3600000) fail(`${where} ${j.id} was abandoned less than 3600 s after signing`);
        for (const c of j.controls) {
          if ((c.op === 'job.get') !== (c.job_number === null)) fail(`${where} ${j.id} ${c.id}: a job.get has no job number and a job.cancel has one`);
        }
      }
      // Section 5: every delivery carries the stored bytes of its attempt or control, and counts up by one.
      for (const o of e.out) {
        const j = now.get(o.job);
        const t = j?.attempts.find((a) => a.id === o.target) ?? j?.controls.find((c) => c.id === o.target);
        if (!t) { fail(`${where} delivery to ${o.target}, which the job does not have`); continue; }
        if (o.op === 'job.cancel') {
          // Section 8: a cancel goes out only after the device acknowledged the job, in a cancellable state, with no other request to the device open.
          const att = j.attempts.find((a) => a.id === t.attempt);
          const d = att.dispositions.device_answered;
          if (d?.status !== 'ok' || !CATALOGUE.ops.find((x) => x.op === j.command.op).cancellable_states.includes(d.state)) fail(`${where} a job.cancel was sent while the device's latest state was ${d?.state ?? 'none'}`);
          if (e.jobs.some((x) => x.id !== j.id && x.device === j.device && ['dispatched', 'running'].includes(x.state))) fail(`${where} a job.cancel was sent while another request to the device was open`);
        }
        const key = `${o.job}/${o.target}`;
        const n = (deliveries.get(key) ?? 0) + 1;
        deliveries.set(key, n);
        if (o.delivery !== n || o.bytes !== t.bytes || o.request_id !== t.request_id || o.job_number !== t.job_number) fail(`${where} delivery to ${o.target} is not delivery ${n} of its stored bytes`);
      }
      for (const j of e.jobs) {
        for (const a of j.attempts) if (a.deliveries !== (deliveries.get(`${j.id}/${a.id}`) ?? 0)) fail(`${where} ${j.id} ${a.id} deliveries is not the count of deliveries emitted`);
        for (const c of j.controls) if (c.deliveries !== (deliveries.get(`${j.id}/${c.id}`) ?? 0)) fail(`${where} ${j.id} ${c.id} deliveries is not the count of deliveries emitted`);
      }
      // Section 4: a job number is unique per device and increases with each signed request (a job.get has none).
      const byDevice = {};
      for (const j of e.jobs) for (const t of [...j.attempts, ...j.controls.filter((c) => c.job_number !== null)]) (byDevice[j.device] ??= []).push([num(t.request_id), t.job_number]);
      for (const [dev, list] of Object.entries(byDevice)) {
        list.sort((a, b) => a[0] - b[0]);
        if (list.some((x, k) => k > 0 && x[1] <= list[k - 1][1])) fail(`${where} job numbers of ${dev} do not strictly increase with the requests`);
      }
      // Section 9: reads and lists are the creator's alone, and a miss looks the same whoever asks.
      if (s.step === 'read') {
        const j = now.get(s.job_id);
        const should = j && j.caller === s.caller ? 'read' : 'error';
        if (e.response.outcome !== should) fail(`${where} a read by a caller who is not the creator must be not_found`);
        if (should === 'error' && e.response.error.code !== 'not_found') fail(`${where} a miss must be not_found`);
      }
      if (s.step === 'list' && !same(e.response.job_ids, e.jobs.filter((j) => j.caller === s.caller).map((j) => j.id))) fail(`${where} a list must hold exactly the caller's jobs`);
      if (s.step === 'create' && e.response.outcome === 'error' && now.size !== prevJobs.size) fail(`${where} a refused create made a job`);
      if (s.step === 'create' && e.response.outcome === 'error' && e.out.length) fail(`${where} a refused create sent something`);
      const r = s.result;
      if (r) { answers.statuses.add(r.status); if (r.error) answers.errors.add(r.error); }
      prevJobs = now;
    });
    if (failures === b0) ok(`fixtures/${f}`);
  }
  for (const k of STEP_KINDS) if (!covered.has(k)) fail(`no fixture covers the step kind ${k}`);
  for (const k of ANSWER_STATUSES) if (!answers.statuses.has(k)) fail(`no fixture covers the device status ${k}`);
  for (const k of Object.keys(ERROR_CODES)) if (!answers.errors.has(k)) fail(`no fixture covers the device error ${k}`);
  ok('every step kind is covered by a fixture');
  return { checked, failures };
}
