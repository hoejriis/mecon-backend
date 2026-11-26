// Validates the USB Connector contract (contracts/connector/v1): mapping.json against its
// schema, every fixture against the fixture schema, and cross-checks that fixtures only name
// metrics and drop reasons the contract defines. The Connector's own tests check the code
// against the same files (connector/tests/test_contract_matches_code.py).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const dir = 'connector/v1';
const read = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };

const mapping = read('mapping.json');
if (!ajv.validate(read('mapping.schema.json'), mapping)) fail(`mapping.json: ${JSON.stringify(ajv.errors)}`);
else console.log('ok   connector/v1/mapping.json');

const metricValues = new Map(mapping.metrics.map((m) => [m.name, m]));
if (metricValues.size !== mapping.metrics.length) fail('duplicate metric names in mapping.json');
const dropReasons = new Set(metricValues.get('downlink_dropped_total').labels.reason);

const fixtureSchema = read('fixtures.schema.json');
const validateFixture = ajv.compile(fixtureSchema);
for (const f of readdirSync(join(dir, 'fixtures')).filter((x) => x.endsWith('.json')).sort()) {
  const doc = read(join('fixtures', f));
  if (!validateFixture(doc)) { fail(`fixtures/${f}: ${JSON.stringify(validateFixture.errors)}`); continue; }
  const ids = new Set();
  for (const c of doc.cases) {
    if (ids.has(c.id)) fail(`fixtures/${f}: duplicate case id ${c.id}`);
    ids.add(c.id);
    if (doc.direction === 'device_to_broker') {
      if (c.expect === undefined || !c.serial_chunks_hex) fail(`fixtures/${f}/${c.id}: not an upstream case`);
      for (const key of Object.keys(c.expect?.metrics ?? {})) {
        const [name, label] = key.split('/');
        const m = metricValues.get(name);
        const allowed = m && Object.values(m.labels)[0];
        if (!m || (label ? !allowed?.includes(label) : Object.keys(m.labels).length > 0)) fail(`fixtures/${f}/${c.id}: metric ${key} is not in the contract`);
      }
    } else if (doc.direction === 'enrolment_gate') {
      const probes = metricValues.get('downlink_gate_probes_total').labels.result;
      if (!probes.includes(c.expect.probe_result)) fail(`fixtures/${f}/${c.id}: probe result ${c.expect.probe_result} is not in the contract`);
      for (const s of c.then.filter((x) => 'probe_after_s' in x)) {
        if (!probes.includes(s.probe_result_after)) fail(`fixtures/${f}/${c.id}: probe result ${s.probe_result_after} is not in the contract`);
      }
    } else if (c.expect?.dropped_reason && !dropReasons.has(c.expect.dropped_reason)) {
      fail(`fixtures/${f}/${c.id}: drop reason ${c.expect.dropped_reason} is not in the contract`);
    }
  }
  console.log(`ok   connector/v1/fixtures/${f} (${doc.cases.length} cases)`);
}
if (failures) process.exit(1);
