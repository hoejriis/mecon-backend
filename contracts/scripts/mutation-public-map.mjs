#!/usr/bin/env node
/**
 * Mutation check for the public map case checks (absent-check.mjs, their wiring in validate-reader-cases.mjs and
 * the contract's own rules in validate-public-map.mjs). Run from contracts/:   node scripts/mutation-public-map.mjs
 *
 * It runs the unmutated tests first as a control and aborts if they fail. Each mutant then breaks one rule in the
 * source (the pattern must occur exactly once) and runs `node --test absent-check.test.mjs`. A mutant counts as
 * killed only when the run names at least one failing test; a crash, a syntax error or a timeout is
 * "inconclusive", never a kill. Each file is compared with its backup and restored in a `finally`. Any survivor,
 * inconclusive mutant or failing control makes the exit code non-zero.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const A = 'absent-check.mjs';
const R = 'validate-reader-cases.mjs';
const P = 'validate-public-map.mjs';

/** @type {Array<{id:string, description:string, file:string, edits:Array<[string,string]>}>} */
const MUTANTS = [
  { id: 'abs1', description: 'schemaKeys does not follow $ref', file: A, edits: [["    if (s.$ref) {\n      if (seen.has(s.$ref)) return;\n      seen.add(s.$ref);\n      walk(components.schemas[s.$ref.split('/').pop()]);\n      return;\n    }\n", ""]] },
  { id: 'abs2', description: 'schemaKeys does not descend into array items', file: A, edits: [["    walk(s.items);\n  };\n  walk(schema);", "  };\n  walk(schema);"]] },
  { id: 'abs3', description: 'schemaKeys does not descend into oneOf/anyOf/allOf', file: A, edits: [["    for (const part of ['allOf', 'oneOf', 'anyOf']) for (const v of s[part] ?? []) walk(v);\n    walk(s.items);", "    walk(s.items);"]] },
  { id: 'abs4', description: 'schemaKeys keeps property names case-sensitive', file: A, edits: [["out.add(k.toLowerCase()); walk(v);", "out.add(k); walk(v);"]] },
  { id: 'abs5', description: 'an absent key is compared case-sensitively', file: A, edits: [["if (carried.has(k.toLowerCase()))", "if (carried.has(k))"]] },
  { id: 'abs6', description: 'a key the schema allows is accepted', file: A, edits: [["    if (carried.has(k.toLowerCase())) errors.push(", "    if (false) errors.push("]] },
  { id: 'abs7', description: 'an open schema no longer voids a key absence', file: A, edits: [["if (keys.length && carried.has('*'))", "if (false)"]] },
  { id: 'abs8', description: 'a marker the world lacks is accepted', file: A, edits: [["if (!world.includes(v.toLowerCase()))", "if (false)"]] },
  { id: 'abs9', description: 'the world marker match is case-sensitive', file: A, edits: [["const world = ctx.worldText.toLowerCase();", "const world = ctx.worldText;"]] },
  { id: 'abs10', description: 'an absence with nothing positive beside it is accepted', file: A, edits: [["  if (!ctx.positive) errors.push(", "  if (false) errors.push("]] },
  { id: 'abs11', description: 'an empty absent is accepted', file: A, edits: [["if (!keys.length && !values.length) errors.push(", "if (false) errors.push("]] },
  { id: 'spn1', description: 'spans accepts a pointer that is not a date-time', file: A, edits: [["if (!found.some((f) => f.type === 'string' && f.format === 'date-time'))", "if (!found.length)"]] },
  { id: 'spn2', description: 'spans accepts an `at` that is not an array', file: A, edits: [["const items = schemasAt(ctx.schema, s.at, ctx.components).filter((a) => a.type === 'array');", "const items = schemasAt(ctx.schema, s.at, ctx.components);"]] },
  { id: 'spn3', description: 'spans accepts zero seconds', file: A, edits: [["if (!(s.seconds > 0))", "if (false)"]] },
  { id: 'wire1', description: 'the case validator never runs the absent check', file: R, edits: [["if (s.expect.absent) for (const e of checkAbsent(", "if (false) for (const e of checkAbsent("]] },
  { id: 'wire2', description: 'the case validator never runs the spans check', file: R, edits: [["if (s.expect.spans) for (const e of checkSpans(", "if (false) for (const e of checkSpans("]] },
  { id: 'wire3', description: 'the case validator counts any body check as positive even when empty', file: R, edits: [["|| Object.keys(s.expect.body ?? {}).length > 0;", "|| true;"]] },
  { id: 'wire4', description: 'a header expected absent must be declared too', file: R, edits: [["&& want !== 'absent')", "&& want !== null)"]] },
  { id: 'rule1', description: 'an open object schema is accepted', file: P, edits: [["s.additionalProperties !== false) open.push(name);", "s.additionalProperties === 1) open.push(name);"]] },
  { id: 'rule2', description: 'a schema property the feed never publishes is accepted', file: P, edits: [["if (FORBIDDEN_KEY.test(k)) forbidden.push(", "if (false) forbidden.push("]] },
  { id: 'rule3', description: 'a fixture field the feed never publishes is accepted', file: P, edits: [["if (bad.length) fail(`fixtures/${f} has fields", "if (false) fail(`fixtures/${f} has fields"]] },
  { id: 'rule4', description: 'a missing absence category is accepted', file: P, edits: [["if (!absentKeys.has(k)) fail(", "if (false) fail("]] },
  { id: 'rule5', description: 'a missing 404/410/429 case is accepted', file: P, edits: [["if (!statuses.has(st)) fail(", "if (false) fail("]] },
];

const runTests = () => {
  const r = spawnSync('node', ['--test', '--test-reporter=spec', 'absent-check.test.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const named = [...new Set([...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]))].filter((n) => n !== 'failing tests:');
  return { status: r.status, signal: r.signal, named, out };
};

console.log('control: unmutated tests');
const control = runTests();
if (control.status !== 0 || control.named.length) {
  console.error('control failed; aborting\n', control.out.slice(-2000));
  process.exit(2);
}
console.log('control passed');

let killed = 0;
const survivors = [];
const inconclusive = [];
for (const m of MUTANTS) {
  const path = join(ROOT, m.file);
  const backup = readFileSync(path, 'utf8');
  try {
    let text = backup;
    for (const [from, to] of m.edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) throw new Error(`${m.id}: pattern occurs ${n} times, not once: ${from.slice(0, 60)}`);
      text = text.replace(from, () => to);
    }
    if (text === backup) throw new Error(`${m.id}: mutation changed nothing`);
    writeFileSync(path, text);
    console.log(`applied ${m.id}: ${m.description}`);
    const r = runTests();
    if (r.named.length) { killed++; console.log(`  killed by: ${r.named.join('; ')}`); }
    else if (r.status === 0) { survivors.push(m.id); console.log('  SURVIVED'); }
    else { inconclusive.push(m.id); console.log(`  inconclusive (exit ${r.status} ${r.signal ?? ''}, no named failing test)`); }
  } finally {
    writeFileSync(path, backup);
    if (readFileSync(path, 'utf8') !== backup) throw new Error(`${m.file} was not restored`);
  }
}
const after = runTests();
console.log(`${killed} of ${MUTANTS.length} mutants killed; survivors: ${survivors.join(', ') || 'none'}; inconclusive: ${inconclusive.join(', ') || 'none'}; baseline after: ${after.status === 0 ? 'passes' : 'FAILS'}`);
process.exit(killed === MUTANTS.length && after.status === 0 ? 0 : 1);
