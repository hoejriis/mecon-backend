// Validates the observation processing contract (contracts/observation-processing/v1): every schema, every fixture
// against fixtures.schema.json and its item schemas, the invariants of README section 4, a replay of each process
// fixture through the reference processor (crashed steps included), the counters after a run, the documents the
// schemas reject, and the README's references. Called from validate.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkReadme } from './validate-common.mjs';
import { process as replay, hours, REASONS } from './observation-processing-reference.mjs';

const SCHEMAS = ['committed-capture', 'outcome', 'packet', 'reception', 'hour', 'counters'];
const ITEM_SCHEMA = { outcomes: 'outcome', packets: 'packet', receptions: 'reception', hours: 'hour' };

export function validateObservationProcessing(dir = 'observation-processing/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', `observation-processing/v1: ${m}`); };
  const ok = (m) => { checked++; console.log('ok  ', `observation-processing/v1/${m}`); };
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
  const docs = {};
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) { fail(`fixtures/${f}: ${JSON.stringify(fixtureSchema.errors)}`); continue; }
    docs[f] = doc;
  }

  const outcomesOf = {};
  for (const [f, doc] of Object.entries(docs)) {
    if (doc.kind !== 'process') continue;
    const before = failures;
    // Each document is checked against its schema first: the checks after read its fields, and must fail it, not
    // crash the validator.
    const bad = doc.captures.flatMap((c, i) => (v['committed-capture'](c) ? [] : [`captures[${i}] ${JSON.stringify(v['committed-capture'].errors)}`]));
    for (const [key, schema] of Object.entries(ITEM_SCHEMA)) {
      doc.expect[key].forEach((item, i) => { if (!v[schema](item)) bad.push(`expect.${key}[${i}] ${JSON.stringify(v[schema].errors)}`); });
    }
    if (bad.length) { for (const b of bad) fail(`fixtures/${f}: ${b}`); continue; }
    const ids = doc.captures.map((c) => c.capture_id);
    if (new Set(ids).size !== ids.length) { fail(`fixtures/${f}: capture_id repeats`); continue; }

    // Section 4's invariants, read from the fixture itself.
    const { outcomes, packets, receptions, hours: hrs } = doc.expect;
    const outIds = outcomes.map((o) => o.capture_id);
    if (JSON.stringify([...outIds].sort((a, b) => a - b)) !== JSON.stringify([...ids].sort((a, b) => a - b))) fail(`fixtures/${f}: not exactly one outcome per capture`);
    const recIds = receptions.map((r) => r.capture_id);
    if (new Set(recIds).size !== recIds.length) fail(`fixtures/${f}: more than one reception from one capture`);
    const asReception = new Set(outcomes.filter((o) => o.outcome === 'reception').map((o) => o.capture_id));
    if (recIds.length !== asReception.size || recIds.some((id) => !asReception.has(id))) fail(`fixtures/${f}: receptions and 'reception' outcomes differ`);
    const known = new Set(packets.map((p) => p.packet_id));
    if (receptions.some((r) => !known.has(r.packet_id))) fail(`fixtures/${f}: a reception names no packet`);
    for (const p of packets) {
      const its = receptions.filter((r) => r.packet_id === p.packet_id).sort((a, b) => a.capture_id - b.capture_id);
      if (!its.length) fail(`fixtures/${f}: ${p.packet_id} has no reception`);
      else if (p.first_seen_at !== its[0].received_at) fail(`fixtures/${f}: ${p.packet_id} first_seen_at is not its first reception's received_at`);
      if (its.some((r) => r.received_at > p.last_seen_at)) fail(`fixtures/${f}: ${p.packet_id} last_seen_at is before one of its receptions`);
    }
    if (JSON.stringify(hrs) !== JSON.stringify(hours(receptions))) fail(`fixtures/${f}: hours are not the fold of its receptions (section 5)`);

    // The replay: the reference processor must reach exactly the expected state, and a run with crashed steps the
    // same state as one uninterrupted pass.
    let got;
    try { got = replay(doc.sources, doc.captures, doc.steps); } catch (e) { fail(`fixtures/${f}: the reference processor failed: ${e.message}`); continue; }
    for (const key of Object.keys(ITEM_SCHEMA)) {
      if (JSON.stringify(got[key]) !== JSON.stringify(doc.expect[key])) fail(`fixtures/${f}: expect.${key} differs from the replay: ${JSON.stringify(got[key])}`);
    }
    if (doc.steps && JSON.stringify(replay(doc.sources, doc.captures)) !== JSON.stringify(got)) fail(`fixtures/${f}: the crashed run differs from one uninterrupted pass`);
    outcomesOf[doc.fixture] = outcomes;
    if (failures === before) ok(`fixtures/${f}`);
  }

  for (const [f, doc] of Object.entries(docs)) {
    const before = failures;
    if (doc.kind === 'counters') {
      if (!v.counters(doc.counters)) { fail(`fixtures/${f}: counters ${JSON.stringify(v.counters.errors)}`); continue; }
      const want = { processed: 0, receptions: 0, skipped: Object.fromEntries(REASONS.map((r) => [r, 0])), pending: 0, oldest_pending_ms: null };
      for (const a of doc.after) {
        const outs = outcomesOf[a];
        if (!outs) { fail(`fixtures/${f}: after names ${a}, not a process fixture`); continue; }
        for (const o of outs) { want.processed++; if (o.outcome === 'reception') want.receptions++; else want.skipped[o.reason]++; }
      }
      if (JSON.stringify(doc.counters) !== JSON.stringify(want)) fail(`fixtures/${f}: counters must be ${JSON.stringify(want)}`);
      const c = doc.counters;
      if (c.processed !== c.receptions + Object.values(c.skipped).reduce((s, n) => s + n, 0)) fail(`fixtures/${f}: processed is not receptions plus every skip`);
    } else if (doc.kind === 'invalid') {
      doc.cases.forEach((cs, i) => { if (v[cs.schema](cs.value)) fail(`fixtures/${f}: cases[${i}] (${cs.note}) passes ${cs.schema}, which must reject it`); });
    } else continue;
    if (failures === before) ok(`fixtures/${f}`);
  }
  return { checked, failures };
}
