import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAbsent, checkSpans, schemaKeys, schemasAt } from './absent-check.mjs';

const components = {
  schemas: {
    Item: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'string', format: 'date-time' }, until: { type: 'string', format: 'date-time' }, note: { type: 'string' } } },
    Other: { type: 'object', properties: { Deep: { type: 'string' } } },
    Wrapper: { type: 'object', properties: { items: { type: 'array', items: { oneOf: [{ $ref: '#/components/schemas/Item' }, { $ref: '#/components/schemas/Other' }] } } } },
    Loop: { type: 'object', properties: { next: { $ref: '#/components/schemas/Loop' } } },
    Free: { type: 'object', additionalProperties: true },
  },
};
const wrapper = { $ref: '#/components/schemas/Wrapper' };
const base = { schema: wrapper, components, worldText: 'marker-one marker-two', positive: true };

test('schemaKeys follows refs, oneOf and array items, lowercases, survives a cycle', () => {
  const k = schemaKeys(wrapper, components);
  assert.ok(k.has('items') && k.has('id') && k.has('note') && k.has('deep'));
  assert.deepEqual([...schemaKeys({ $ref: '#/components/schemas/Loop' }, components)], ['next']);
});

test('a key the schema carries anywhere is refused, whatever its case', () => {
  assert.equal(checkAbsent({ keys: ['note'] }, base).length, 1);
  assert.equal(checkAbsent({ keys: ['NOTE'] }, base).length, 1);
  assert.equal(checkAbsent({ keys: ['deep'] }, base).length, 1, 'a key only in a oneOf branch of the items');
  assert.equal(checkAbsent({ keys: ['Deep'] }, base).length, 1, 'a schema key written in capitals');
});

test('a key the schema cannot carry is accepted', () => {
  assert.deepEqual(checkAbsent({ keys: ['rssi', 'snr'] }, base), []);
});

test('open schemas make a key absence meaningless', () => {
  assert.equal(checkAbsent({ keys: ['rssi'] }, { ...base, schema: { $ref: '#/components/schemas/Free' } }).length, 1);
});

test('a value missing from the world is refused, one present is accepted regardless of case', () => {
  assert.equal(checkAbsent({ values: ['marker-three'] }, base).length, 1);
  assert.deepEqual(checkAbsent({ values: ['MARKER-ONE'] }, base), []);
});

test('an absence without a positive expectation is refused', () => {
  assert.equal(checkAbsent({ keys: ['rssi'] }, { ...base, positive: false }).length, 1);
});

test('an empty absent is refused', () => {
  assert.equal(checkAbsent({}, base).length, 1);
});

test('schemasAt reaches the items of an array property', () => {
  assert.equal(schemasAt(wrapper, '/items', components)[0].type, 'array');
  assert.equal(schemasAt(wrapper, '/nothing', components).length, 0);
});

test('spans accepts two date-times of the items and refuses anything else', () => {
  const ok = { at: '/items', from: '/at', to: '/until', seconds: 45 };
  assert.deepEqual(checkSpans([ok], base), []);
  assert.equal(checkSpans([{ ...ok, from: '/note' }], base).length, 1, 'a string that is not a date-time');
  assert.equal(checkSpans([{ ...ok, to: '/missing' }], base).length, 1);
  assert.equal(checkSpans([{ ...ok, at: '/nothing' }], base).length, 1);
  assert.match(checkSpans([{ ...ok, at: '/items/0' }], base)[0], /is not an array/, 'an item is not an array');
  assert.equal(checkSpans([{ ...ok, seconds: 0 }], base).length, 1);
});

// --- the checks as wired into the case validator, on a scratch copy of the contract -------------------------
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReaderCases } from './validate-reader-cases.mjs';
import { validatePublicMap } from './validate-public-map.mjs';

function scratch(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'public-map-'));
  cpSync('public-map/v1', dir, { recursive: true });
  const file = (f) => join(dir, f);
  const edit_ = (f, fn) => { const j = JSON.parse(readFileSync(file(f), 'utf8')); fn(j); writeFileSync(file(f), JSON.stringify(j)); };
  edit?.(edit_, file);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const quiet = (fn) => { const e = console.error; const l = console.log; console.error = () => {}; console.log = () => {}; try { return fn(); } finally { console.error = e; console.log = l; } };
const firstStep = (j, id, pick = (s) => s.request) => j.cases.find((c) => c.id === id).steps.find(pick);
const run = (edit) => { const s = scratch(edit); try { return quiet(() => validateReaderCases(s.dir, 'mecon-public-map')); } finally { s.done(); } };
const runRules = (edit) => { const s = scratch(edit); try { return quiet(() => validatePublicMap(s.dir)); } finally { s.done(); } };
const messages = (edit) => {
  const s = scratch(edit); const seen = []; const e = console.error; const l = console.log;
  console.error = (...a) => seen.push(a.join(' ')); console.log = () => {};
  try { validatePublicMap(s.dir); } finally { console.error = e; console.log = l; s.done(); }
  return seen;
};

test('control: the unchanged public map cases and rules pass', () => {
  assert.equal(run().failures, 0);
  assert.equal(runRules().failures, 0);
});

test('a case whose absent key is a property the response allows fails', () => {
  assert.ok(run((ed) => ed('cases/nodes.json', (j) => { firstStep(j, 'nodes-03', (s) => s.expect.absent).expect.absent.keys.push('name'); })).failures > 0);
});

test('a case whose absent marker is not in the world fails', () => {
  assert.ok(run((ed) => ed('cases/nodes.json', (j) => { firstStep(j, 'nodes-03', (s) => s.expect.absent).expect.absent.values.push('marker-the-world-lacks'); })).failures > 0);
});

test('an absent with nothing positive beside it fails', () => {
  assert.ok(run((ed) => ed('cases/nodes.json', (j) => { const s = firstStep(j, 'nodes-03', (x) => x.expect.absent); delete s.expect.match; })).failures > 0);
});

test('a spans check on something that is not a date-time fails', () => {
  assert.ok(run((ed) => ed('cases/events.json', (j) => { firstStep(j, 'events-02', (s) => s.expect?.spans).expect.spans[0].to = '/event_id'; })).failures > 0);
});

test('a header expected absent need not be declared, a header expected present must be', () => {
  assert.ok(run((ed) => ed('cases/events.json', (j) => { firstStep(j, 'events-02', (s) => s.expect?.spans).expect.headers = { 'X-Undeclared': 'present' }; })).failures > 0);
  assert.equal(run((ed) => ed('cases/events.json', (j) => { firstStep(j, 'events-02', (s) => s.expect?.spans).expect.headers = { 'X-Undeclared': 'absent' }; })).failures, 0);
});

test('the rules fail when no case asserts an observer key absent any more', () => {
  const r = runRules((ed) => {
    for (const f of ['nodes', 'events', 'access']) ed(`cases/${f}.json`, (j) => { for (const c of j.cases) for (const s of c.steps) if (s.expect?.absent?.keys) s.expect.absent.keys = s.expect.absent.keys.filter((k) => k !== 'observer_key'); });
  });
  assert.ok(r.failures > 0);
});

test('the rules fail on an open object schema', () => {
  const r = runRules((ed, file) => {
    const p = file('openapi.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('Line:\n      type: object\n      required: [ref, lat, lon]\n      additionalProperties: false', 'Line:\n      type: object\n      required: [ref, lat, lon]'));
  });
  assert.ok(r.failures > 0);
});

test('the rules fail on a fixture that names a field the feed never publishes', () => {
  const r = runRules((ed) => ed('fixtures/nodes-empty.json', (j) => { j.rssi = -90; }));
  assert.ok(r.failures > 0);
});

test('the rules fail when a case no longer expects 429', () => {
  const r = runRules((ed) => ed('cases/access.json', (j) => { for (const c of j.cases) for (const s of c.steps) if (s.expect?.status === 429) s.expect.status = 404; }));
  assert.ok(r.failures > 0);
});

test('the rules fail on a schema property the feed never publishes, and say so', () => {
  const edit = (ed, file) => { const p = file('openapi.yaml'); writeFileSync(p, readFileSync(p, 'utf8').replace("        ref:\n          type: string", "        observer_id: { type: string }\n        ref:\n          type: string")); };
  assert.ok(messages(edit).some((m) => /schema properties the feed never publishes: Line\.observer_id/.test(m)));
});

test('the rules name each status no case expects', () => {
  const m = messages((ed) => ed('cases/access.json', (j) => { for (const c of j.cases) for (const s of c.steps) if (s.expect?.status === 429) s.expect.status = 404; }));
  assert.ok(m.some((x) => /no case expects status 429/.test(x)));
  assert.ok(!m.some((x) => /no case expects status 404/.test(x)));
});
