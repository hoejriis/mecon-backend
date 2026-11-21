// Shared by the contract validators: the README must reference every schema and fixture (and nothing that is
// not there), and README and fixtures carry no host name, issue-style number or literal token.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function checkReadme(dir, schemaFiles, fail) {
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const fixtureFiles = readdirSync(join(dir, 'fixtures')).filter((f) => f.endsWith('.json')).sort();
  for (const f of schemaFiles) if (!readme.includes(`schemas/${f}`)) fail(`README.md does not reference schemas/${f}`);
  for (const f of fixtureFiles) if (!readme.includes(`fixtures/${f}`)) fail(`fixture not referenced by README.md: ${f}`);
  if (!readme.includes('fixtures.schema.json')) fail('README.md does not reference fixtures.schema.json');
  for (const m of readme.matchAll(/fixtures\/([A-Za-z0-9_.-]+\.json)/g)) {
    if (!fixtureFiles.includes(m[1])) fail(`README.md references a fixture that does not exist: ${m[1]}`);
  }
  const scanned = [['README.md', readme], ...fixtureFiles.map((f) => [`fixtures/${f}`, readFileSync(join(dir, 'fixtures', f), 'utf8')])];
  for (const [name, text] of scanned) {
    if (/#\d+/.test(text)) fail(`${name}: contains an issue-style number reference`);
    if (/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|cloud|dk|net|org|io|local|lan|invalid)\b/i.test(text)) fail(`${name}: contains a host name`);
    if (/Bearer (?!<token>)[A-Za-z0-9._~-]{8,}/.test(text)) fail(`${name}: contains a literal token`);
  }
  return fixtureFiles;
}
