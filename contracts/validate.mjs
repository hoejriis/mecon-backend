// Validates every fixture referenced by `externalValue` in each OpenAPI
// document against the schema of the response or request it illustrates,
// and fails on any fixture file that no operation references.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateHold } from './validate-hold.mjs';
import { validateObservationSubscription } from './validate-observation-subscription.mjs';
import { validateRawCapture } from './validate-raw-capture.mjs';

const docs = ['reader-api/v1/openapi.yaml', 'observations/v1/openapi.yaml'];
// Privacy: no observation fixture or schema may carry these fields (see the contract's description).
const FORBIDDEN_KEY = /route|path|hop|relay|hash|payload|content|text|transmitter|sender|raw|bytes/i;
const forbiddenKeys = (v, trail = '') =>
  v && typeof v === 'object'
    ? Object.entries(v).flatMap(([k, c]) => (FORBIDDEN_KEY.test(k) ? [trail + k] : []).concat(forbiddenKeys(c, `${trail}${k}.`)))
    : [];
let failures = 0;
let checked = 0;

for (const docPath of docs) {
  const base = dirname(resolve(docPath));
  const doc = parse(readFileSync(docPath, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // Register components so $refs resolve inside Ajv.
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const fixRef = (s) =>
    JSON.parse(JSON.stringify(s).replaceAll('"#/components/', '"openapi#/components/'));

  const used = new Set();
  const visit = (node, schema) => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref?.startsWith('#/components/responses/')) {
      visit(doc.components.responses[node.$ref.split('/').pop()], schema);
      return;
    }
    for (const media of Object.values(node.content ?? {})) {
      for (const ex of Object.values(media.examples ?? {})) {
        if (!ex.externalValue) continue;
        const file = join(base, ex.externalValue);
        used.add(resolve(file));
        const validate = ajv.compile(fixRef(media.schema));
        const data = JSON.parse(readFileSync(file, 'utf8'));
        checked++;
        if (!validate(data)) {
          failures++;
          console.error(`FAIL ${ex.externalValue}:`, JSON.stringify(validate.errors));
        } else {
          console.log(`ok   ${ex.externalValue}`);
        }
      }
    }
  };
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) {
      visit(op.requestBody);
      for (const r of Object.values(op.responses ?? {})) visit(r);
    }
  }
  // The lease token's payload is not a response body, so decode and check it separately.
  const issuedPath = join(base, 'fixtures/lease-issued.json');
  if (doc.components.schemas.LeasePayload) {
    const token = JSON.parse(readFileSync(issuedPath, 'utf8')).lease;
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    const validate = ajv.compile(fixRef({ $ref: '#/components/schemas/LeasePayload' }));
    checked++;
    const days = (Date.parse(payload.expires_at) - Date.parse(payload.issued_at)) / 86_400_000;
    if (!validate(payload) || days > 7 || days <= 0) {
      failures++;
      console.error('FAIL lease payload:', JSON.stringify(validate.errors), `lifetime ${days} days`);
    } else {
      console.log('ok   lease payload decoded from fixtures/lease-issued.json');
    }
  }
  if (docPath.startsWith('observations/')) {
    const schemaKeys = forbiddenKeys(
      Object.fromEntries(Object.entries(doc.components.schemas).map(([k, v]) => [k, v.properties ?? {}])),
    );
    if (schemaKeys.length) {
      failures++;
      console.error('FAIL observation schema has forbidden fields:', schemaKeys.join(', '));
    }
    for (const f of readdirSync(join(base, 'fixtures')).filter((f) => f.endsWith('.json'))) {
      const bad = forbiddenKeys(JSON.parse(readFileSync(join(base, 'fixtures', f), 'utf8')));
      if (bad.length) {
        failures++;
        console.error(`FAIL ${f} has forbidden fields: ${bad.join(', ')}`);
      }
    }
    checked++;
    console.log('ok   observation schemas and fixtures carry no route/content/hash/transmitter fields');
  }
  const fixturesDir = join(base, 'fixtures');
  for (const f of readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))) {
    if (!used.has(resolve(join(fixturesDir, f)))) {
      failures++;
      console.error(`FAIL fixture not referenced by any operation: ${f}`);
    }
  }
}
// The WebSocket hold contract: frame schemas, fixtures A-E, rejected frames, and the README's references.
const hold = validateHold();
checked += hold.checked;
failures += hold.failures;
// The receive-only observation subscription profile and the raw capture append: schemas, fixtures, their rules.
for (const r of [validateObservationSubscription(), validateRawCapture()]) {
  checked += r.checked;
  failures += r.failures;
}
console.log(`${checked} fixtures checked, ${failures} failures`);
process.exit(failures ? 1 : 0);
