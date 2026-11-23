// Validates the receive-only observation subscription profile (contracts/observation-subscription/v1): both
// schemas, every fixture against fixtures.schema.json, the profiles each fixture says are valid or invalid, the
// rules of the connect/reconnect sequence (fixture C), and the README's references. Called from validate.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkReadme } from './validate-common.mjs';

const SCHEMAS = ['profile', 'status', 'ingester'];

export function validateObservationSubscription(dir = 'observation-subscription/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', `observation-subscription/v1: ${m}`); };
  const ok = (m) => { checked++; console.log('ok  ', `observation-subscription/v1/${m}`); };
  const readJson = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  const files = readdirSync(join(dir, 'schemas')).filter((f) => f.endsWith('.schema.json')).sort();
  for (const s of SCHEMAS) if (!files.includes(`${s}.schema.json`)) fail(`schemas/${s}.schema.json is missing`);
  for (const f of files) if (!SCHEMAS.includes(f.replace('.schema.json', ''))) fail(`schemas/${f} is not part of the contract`);
  const v = {};
  for (const s of SCHEMAS) {
    try { v[s] = ajv.compile(readJson(`schemas/${s}.schema.json`)); ok(`schemas/${s}.schema.json`); } catch (e) { fail(`schemas/${s}.schema.json: ${e.message}`); }
  }
  const fixtureFiles = checkReadme(dir, files, fail);
  ok('README.md references every schema and fixture, and carries no host name, issue number or token');

  const fixtureSchema = ajv.compile(readJson('fixtures.schema.json'));
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) { fail(`fixtures/${f}: ${JSON.stringify(fixtureSchema.errors)}`); continue; }
    const before = failures;
    if (doc.kind === 'profiles') {
      doc.cases.forEach((c, i) => {
        const valid = v.profile(c.value);
        if (valid !== (doc.expect === 'valid')) fail(`fixtures/${f} case ${i} (${c.note}): expected ${doc.expect}, the schema said ${valid ? 'valid' : 'invalid'}`);
      });
    } else if (doc.kind === 'sequence') {
      if (!v.profile(doc.profile)) fail(`fixtures/${f}: the profile is not valid`);
      let lastConnected = null;
      doc.steps.forEach((s, i) => {
        const where = `fixtures/${f} step ${i} (${s.event})`;
        if (!v.status(s.status)) fail(`${where}: status ${JSON.stringify(v.status.errors)}`);
        const subscribes = s.actions.map((a) => a.subscribe);
        const success = s.event === 'connack' && s.code === 0;
        if (success) {
          if (JSON.stringify([...subscribes].sort()) !== JSON.stringify([...doc.profile.topics].sort())) fail(`${where}: a successful connect must subscribe to every topic, got ${JSON.stringify(subscribes)}`);
          if (s.status.state !== 'connected') fail(`${where}: a successful connect is the state connected`);
          if (s.status.last_connected_at !== s.at) fail(`${where}: last_connected_at must be this connect's time`);
          lastConnected = s.at;
        } else {
          if (s.actions.length) fail(`${where}: only a successful connect subscribes`);
          if ((s.status.last_connected_at ?? null) !== lastConnected) fail(`${where}: last_connected_at moves only on a successful connect`);
        }
        if (s.event === 'connack' && s.code !== 0 && s.status.state !== 'error') fail(`${where}: a refused connect is the state error`);
        if (s.event === 'suback') {
          if (JSON.stringify(s.status.subscribed) !== JSON.stringify(s.granted)) fail(`${where}: subscribed must be the SUBACK's granted topics`);
          if (JSON.stringify(s.status.refused) !== JSON.stringify(s.refused)) fail(`${where}: refused must be the SUBACK's refused topics`);
        }
      });
    } else if (doc.kind === 'ingester') {
      // Section 4: replay the steps. A message is received; one over the receive bound is counted oversize (and
      // handed on as a stub); it waits in the buffer, or is shed when the buffer is full. An available append
      // hands on everything waiting; an unavailable one leaves it waiting.
      const st = { received: 0, handed_on: 0, buffered: 0, bound: doc.limits.buffer_bound, shed: 0, oversize: 0 };
      doc.events.forEach((s, i) => {
        const where = `fixtures/${f} event ${i} (${s.event})`;
        if (s.event === 'message') {
          st.received += 1;
          if (s.size > doc.limits.max_receive_bytes) st.oversize += 1;
          if (st.buffered < st.bound) st.buffered += 1; else st.shed += 1;
        } else if (s.event === 'append') {
          if (s.storage === 'available') { st.handed_on += st.buffered; st.buffered = 0; }
        } else fail(`${where}: unknown event`);
        for (const [k, want] of Object.entries(st)) if (s.expect?.[k] !== want) fail(`${where}: ${k} must be ${want}, the fixture says ${s.expect?.[k]}`);
        if (st.received !== st.handed_on + st.buffered + st.shed) fail(`${where}: received must equal handed_on + buffered + shed`);
      });
    }
    if (failures === before) ok(`fixtures/${f}`);
  }
  return { checked, failures };
}
