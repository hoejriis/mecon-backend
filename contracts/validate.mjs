// Validates every fixture referenced by `externalValue` in each OpenAPI
// document against the schema of the response or request it illustrates,
// and fails on any fixture file that no operation references.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const docs = ['reader-api/v1/openapi.yaml'];
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
  const fixturesDir = join(base, 'fixtures');
  for (const f of readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))) {
    if (!used.has(resolve(join(fixturesDir, f)))) {
      failures++;
      console.error(`FAIL fixture not referenced by any operation: ${f}`);
    }
  }
}
console.log(`${checked} fixtures checked, ${failures} failures`);
process.exit(failures ? 1 : 0);
