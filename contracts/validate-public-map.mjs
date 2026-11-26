// The anonymous public map feed contract's own rules, beside the shared ones (fixtures against their schemas in
// validate.mjs; conformance cases against the document in validate-reader-cases.mjs, including `absent` and
// `spans`):
// - every object schema is closed, so a payload carries exactly the allow-listed fields;
// - no schema property, fixture key or fixture value names what the feed never publishes (observer, signal,
//   packet, source, gateway, fleet, topic, route, content);
// - no document, case or fixture carries a host name, an issue-style number or a literal token;
// - the cases, together, assert the absence of every category the contract promises, and exercise the 404, 410
//   and 429 answers.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateReaderCases } from './validate-reader-cases.mjs';

const DEFAULT_DIR = 'public-map/v1';
const FORBIDDEN_KEY = /observer|rssi|snr|packet|hash|source|gateway|fleet|topic|route|path|hop|payload|content|text|raw|bytes|sender|transmitter|contact|label/i;
const keysOf = (v, trail = '') =>
  v && typeof v === 'object'
    ? Object.entries(v).flatMap(([k, c]) => [`${trail}${k}`].concat(keysOf(c, `${trail}${k}.`)))
    : [];

// What the cases must collectively say is absent: keys, and markers of values.
const REQUIRED_ABSENT_KEYS = ['observer', 'observer_id', 'observer_key', 'rssi', 'snr', 'packet_id', 'packet_hash', 'source', 'gateway', 'fleet', 'topic'];
const REQUIRED_ABSENT_VALUE_MARKERS = [
  ['an observer key', /^[0-9a-f]{64}$/],
  ['a private observer name', /observer-name/],
  ['an operator-set observer position', /^57\.123456$/],
  ['an inferred observer position', /^58\.234567$/],
  ['a signal strength', /^-113\.5$/],
  ['a signal-to-noise ratio', /^7\.25$/],
  ['a topic', /topic/],
  ['a source name', /^source-name/],
  ['a gateway label', /gateway-label/],
  ['a fleet name', /^Fleet /],
  ['a packet hash', /^[0-9a-f]{64}$/],
  ['an operator-typed contact label', /^Operator label/],
];

export function validatePublicMap(DIR = DEFAULT_DIR) {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', m); };
  const ok = (m) => { checked++; console.log('ok  ', m); };
  const doc = parse(readFileSync(join(DIR, 'openapi.yaml'), 'utf8'));

  const cases = validateReaderCases(DIR, 'mecon-public-map');
  checked += cases.checked;
  failures += cases.failures;

  // Closed schemas, and no forbidden property name.
  const open = [];
  const forbidden = [];
  const walk = (s, name) => {
    if (!s || typeof s !== 'object') return;
    if (s.type === 'object' && s.properties && s.additionalProperties !== false) open.push(name);
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (FORBIDDEN_KEY.test(k)) forbidden.push(`${name}.${k}`);
      walk(v, `${name}.${k}`);
    }
    for (const part of ['oneOf', 'anyOf', 'allOf']) (s[part] ?? []).forEach((v, i) => walk(v, `${name}.${part}[${i}]`));
    walk(s.items, `${name}[]`);
  };
  for (const [n, s] of Object.entries(doc.components.schemas)) walk(s, n);
  if (open.length) fail(`schemas not closed with additionalProperties: false: ${open.join(', ')}`);
  else if (forbidden.length) fail(`schema properties the feed never publishes: ${forbidden.join(', ')}`);
  else ok('every public map object schema is closed and names no field the feed never publishes');

  // Fixtures: no forbidden key anywhere.
  const fixturesDir = join(DIR, 'fixtures');
  const texts = [['openapi.yaml', readFileSync(join(DIR, 'openapi.yaml'), 'utf8')]];
  for (const f of readdirSync(fixturesDir)) {
    const text = readFileSync(join(fixturesDir, f), 'utf8');
    texts.push([`fixtures/${f}`, text]);
    if (f.endsWith('.json')) {
      const bad = keysOf(JSON.parse(text)).filter((k) => FORBIDDEN_KEY.test(k.split('.').pop()));
      if (bad.length) fail(`fixtures/${f} has fields the feed never publishes: ${bad.join(', ')}`);
    }
  }
  for (const f of readdirSync(join(DIR, 'cases')).filter((f) => f !== 'cases.schema.json')) texts.push([`cases/${f}`, readFileSync(join(DIR, 'cases', f), 'utf8')]);
  for (const [name, text] of texts) {
    if (/#\d+/.test(text)) fail(`${name}: contains an issue-style number reference`);
    if (/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|cloud|dk|net|org|io|local|lan|invalid|test)\b/i.test(text)) fail(`${name}: contains a host name`);
    if (/Bearer (?!<token>)[A-Za-z0-9._~-]{8,}/.test(text)) fail(`${name}: contains a literal token`);
  }
  ok('no public map document, case or fixture carries a host name, issue-style number or literal token');

  // What the cases say, together.
  const absentKeys = new Set();
  const absentValues = new Set();
  const statuses = new Set();
  for (const f of readdirSync(join(DIR, 'cases')).filter((f) => f.endsWith('.json') && !['worlds.json', 'cases.schema.json'].includes(f))) {
    for (const c of JSON.parse(readFileSync(join(DIR, 'cases', f), 'utf8')).cases) {
      for (const s of c.steps) {
        if (!s.request) continue;
        statuses.add(s.expect.status);
        for (const k of s.expect.absent?.keys ?? []) absentKeys.add(k.toLowerCase());
        for (const v of s.expect.absent?.values ?? []) absentValues.add(v);
      }
    }
  }
  for (const k of REQUIRED_ABSENT_KEYS) if (!absentKeys.has(k)) fail(`no case asserts the key ${k} is absent`);
  for (const [what, re] of REQUIRED_ABSENT_VALUE_MARKERS) if (![...absentValues].some((v) => re.test(v))) fail(`no case asserts ${what} is absent`);
  for (const st of [200, 404, 410, 429]) if (!statuses.has(st)) fail(`no case expects status ${st}`);
  ok('the cases assert every absence the contract promises and expect 200, 404, 410 and 429');
  return { checked, failures };
}
