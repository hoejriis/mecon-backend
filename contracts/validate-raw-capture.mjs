// Validates the raw capture append contract (contracts/raw-capture/v1): every schema, every fixture against
// fixtures.schema.json, each append's request and result (which captures are rejected and why, the commit
// arithmetic), the counters after a run of appends, the documents the schemas reject, and the README's
// references. Called from validate.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkReadme } from './validate-common.mjs';

const SCHEMAS = ['capture', 'append-request', 'append-result', 'counters'];

export function validateRawCapture(dir = 'raw-capture/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', `raw-capture/v1: ${m}`); };
  const ok = (m) => { checked++; console.log('ok  ', `raw-capture/v1/${m}`); };
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

  // What an archive must answer for a request: the captures it must reject (malformed), and the valid ones
  // past the payload limit that it commits as a stub.
  const expectedRejections = (request) => request.captures.flatMap((c, index) => (v.capture(c) ? [] : [{ index, reason: 'malformed' }]));
  const expectedStubs = (request, limits) => request.captures.flatMap((c, index) =>
    (v.capture(c) && Buffer.from(c.payload_b64, 'base64').length > limits.max_payload_bytes ? [index] : []));

  const fixtureSchema = ajv.compile(readJson('fixtures.schema.json'));
  const outcomes = {};
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) { fail(`fixtures/${f}: ${JSON.stringify(fixtureSchema.errors)}`); continue; }
    const before = failures;
    if (doc.kind === 'append') {
      const { request, result, limits } = doc;
      if (!v['append-request'](request)) fail(`fixtures/${f}: request ${JSON.stringify(v['append-request'].errors)}`);
      if (!v['append-result'](result)) fail(`fixtures/${f}: result ${JSON.stringify(v['append-result'].errors)}`);
      if (result.batch_id !== request.batch_id) fail(`fixtures/${f}: the result names another batch`);
      const n = request.captures.length;
      if (result.storage === 'available') {
        const want = expectedRejections(request);
        if (JSON.stringify(result.rejected) !== JSON.stringify(want)) fail(`fixtures/${f}: rejected must be ${JSON.stringify(want)}, got ${JSON.stringify(result.rejected)}`);
        const stubs = expectedStubs(request, limits);
        if (JSON.stringify(result.stubbed) !== JSON.stringify(stubs)) fail(`fixtures/${f}: stubbed must be ${JSON.stringify(stubs)}, got ${JSON.stringify(result.stubbed)}`);
        if (result.committed + result.rejected.length !== n) fail(`fixtures/${f}: committed plus rejected must equal the ${n} captures`);
        const seen = new Set(result.rejected.map((r) => r.index));
        if (seen.size !== result.rejected.length || [...seen].some((i) => i >= n)) fail(`fixtures/${f}: each rejected index once, inside the batch`);
        const rejectedIdx = new Set(result.rejected.map((r) => r.index));
        if (new Set(result.stubbed).size !== result.stubbed.length || result.stubbed.some((i) => i >= n || rejectedIdx.has(i))) fail(`fixtures/${f}: each stubbed index once, inside the batch, not rejected`);
      } else if (result.committed !== 0 || result.rejected.length || result.stubbed.length) {
        fail(`fixtures/${f}: storage unavailable commits, rejects and stubs nothing`);
      }
      outcomes[f] = { received: result.storage === 'available' ? n : 0, committed: result.committed, rejected: result.rejected.length, stubbed: result.stubbed.length, unavailable: result.storage === 'unavailable' ? 1 : 0 };
    }
    if (failures === before && doc.kind === 'append') ok(`fixtures/${f}`);
  }
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) continue;
    const before = failures;
    if (doc.kind === 'counters') {
      if (!v.counters(doc.counters)) fail(`fixtures/${f}: counters ${JSON.stringify(v.counters.errors)}`);
      const sum = { received: 0, committed: 0, rejected: 0, stubbed: 0, unavailable: 0 };
      for (const a of doc.after) {
        const o = outcomes[a];
        if (!o) { fail(`fixtures/${f}: after names ${a}, not an append fixture`); continue; }
        for (const k of Object.keys(sum)) sum[k] += o[k];
      }
      const c = doc.counters;
      const want = { received: sum.received, committed: sum.committed, rejected: sum.rejected, stubbed: sum.stubbed, unavailable_batches: sum.unavailable };
      for (const [k, x] of Object.entries(want)) if (c[k] !== x) fail(`fixtures/${f}: ${k} must be ${x}, got ${c[k]}`);
      if (c.received !== c.committed + c.rejected + c.buffered + c.dropped) fail(`fixtures/${f}: received must equal committed + rejected + buffered + dropped`);
      if (c.stubbed > c.committed) fail(`fixtures/${f}: stubbed is part of committed, never more`);
      if (c.buffered === 0 && c.oldest_buffered_ms !== null && c.oldest_buffered_ms !== undefined) fail(`fixtures/${f}: no lag with nothing buffered`);
    } else if (doc.kind === 'invalid') {
      doc.cases.forEach((cs, i) => { if (v[cs.schema](cs.value)) fail(`fixtures/${f} case ${i} (${cs.note}): ${cs.schema} accepted it`); });
    } else continue;
    if (failures === before) ok(`fixtures/${f}`);
  }
  return { checked, failures };
}
