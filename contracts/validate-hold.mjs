// Validates the WebSocket hold contract (contracts/connector-hold/v1): every frame schema, every fixture
// (schema, then the protocol's own rules: framing, exactness, ack matching, the line filter), the frames the
// schemas must reject, and that the README references every schema and fixture file, so an unreferenced
// fixture fails CI. Called from validate.mjs. The Connector's tests replay the same fixtures.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const AGENT = ['iface_relay', 'status', 'iface_hello', 'iface_result', 'iface_event'];
const BACKEND = ['iface_req', 'iface_ack', 'refused'];
const STREAM = /^[a-z][a-z_]{0,31}$/;
const bytes = (s) => Buffer.from(s, 'utf8');

export function validateHold(dir = 'connector-hold/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', m); };
  const ok = (m) => { checked++; console.log('ok  ', m); };
  const readJson = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  // schemas: exactly one per frame type, no stray files
  const files = readdirSync(join(dir, 'schemas')).filter((f) => f.endsWith('.schema.json')).sort();
  const types = [...AGENT, ...BACKEND];
  for (const t of types) if (!files.includes(`${t}.schema.json`)) fail(`schemas/${t}.schema.json is missing`);
  for (const f of files) if (!types.includes(f.replace('.schema.json', ''))) fail(`schemas/${f} is not a frame type of the contract`);
  const validators = {};
  for (const f of files) {
    const t = f.replace('.schema.json', '');
    try {
      validators[t] = ajv.compile(readJson(`schemas/${f}`));
      ok(`connector-hold/v1/schemas/${f}`);
    } catch (e) { fail(`schemas/${f}: ${e.message}`); }
  }
  const check = (frame, direction) => {
    const allowed = direction === 'agent_to_backend' ? AGENT : BACKEND;
    const v = validators[frame.type];
    if (typeof frame.type !== 'string' || !allowed.includes(frame.type) || !v) return [`type ${JSON.stringify(frame.type)} is not a ${direction} frame`];
    return v(frame) ? [] : v.errors.map((e) => `${e.instancePath} ${e.message}`);
  };

  // every schema and fixture file is referenced by the README, and the README keeps to the editorial rules
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const fixtureFiles = readdirSync(join(dir, 'fixtures')).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) if (!readme.includes(`schemas/${f}`)) fail(`README.md does not reference schemas/${f}`);
  for (const f of fixtureFiles) if (!readme.includes(`fixtures/${f}`)) fail(`fixture not referenced by README.md: ${f}`);
  if (!readme.includes('fixtures.schema.json')) fail('README.md does not reference fixtures.schema.json');
  for (const m of readme.matchAll(/fixtures\/([A-Za-z0-9_.-]+\.json)/g)) {
    if (!fixtureFiles.includes(m[1])) fail(`README.md references a fixture that does not exist: ${m[1]}`);
  }
  const scanned = [['README.md', readme], ...fixtureFiles.map((f) => [`fixtures/${f}`, readFileSync(join(dir, 'fixtures', f), 'utf8')])];
  for (const [name, text] of scanned) {
    if (/#\d+/.test(text)) fail(`${name}: contains an issue-style number reference`);
    if (/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|cloud|dk|net|org|io|local|lan|invalid)\b/i.test(text)) fail(`${name}: contains a host name`);
    if (/bearer\.(?!<token>)[A-Za-z0-9._~-]{8,}/.test(text) || /Bearer (?!<token>)[A-Za-z0-9._~-]{8,}/.test(text)) fail(`${name}: contains a literal token`);
  }
  ok('README.md references every schema and fixture, and carries no host name, issue number or token');

  const fixtureSchema = ajv.compile(readJson('fixtures.schema.json'));
  for (const f of fixtureFiles) {
    const doc = readJson(`fixtures/${f}`);
    if (!fixtureSchema(doc)) { fail(`fixtures/${f}: ${JSON.stringify(fixtureSchema.errors)}`); continue; }
    if (doc.id === 'invalid') {
      for (const c of doc.cases) {
        const errs = check(c.frame, c.direction);
        if (errs.length === 0) fail(`fixtures/${f}: accepted but must be rejected (${c.why})`);
      }
      ok(`connector-hold/v1/fixtures/${f} (${doc.cases.length} frames rejected)`);
      continue;
    }
    const before = failures;
    scenario(doc, f, check, fail);
    if (failures === before) ok(`connector-hold/v1/fixtures/${f} (${doc.steps.length} steps)`);
  }
  return { checked, failures };
}

function scenario(doc, file, check, fail) {
  const at = (i, m) => fail(`fixtures/${file} step ${i + 1}: ${m}`);
  const maxWire = doc.link === 'console' ? 1600 : 4096;
  const sentRefs = new Map(); // ref -> type, awaiting an ack
  const usedRefs = new Set();
  let lastReq = null; // an iface_req whose wire has not been written yet
  let lastId = null;
  let pending = null; // a device message waiting for its upload: {text, kind}
  let sawSend = false;
  const steps = doc.steps;
  steps.forEach((s, i) => {
    switch (s.step) {
      case 'handshake':
        if (s.presentation === 'header') {
          if (JSON.stringify(s.offered) !== JSON.stringify(['Authorization: Bearer <token>']) || s.selected !== null) at(i, 'header form offers only the Authorization header and selects no subprotocol');
        } else if (JSON.stringify(s.offered) !== JSON.stringify(['mecon-bridge', 'bearer.<token>']) || s.selected !== 'mecon-bridge') {
          at(i, 'subprotocol form offers mecon-bridge and bearer.<token> and selects mecon-bridge only');
        }
        break;
      case 'send': {
        for (const e of check(s.frame, 'agent_to_backend')) at(i, `send: ${e}`);
        if (!sawSend && s.frame.type !== 'iface_relay') at(i, 'the first frame after the handshake must be iface_relay');
        sawSend = true;
        if ('ref' in s.frame) {
          const key = JSON.stringify(s.frame.ref);
          if (usedRefs.has(key)) at(i, `ref ${key} reused`);
          usedRefs.add(key);
          sentRefs.set(key, s.frame.type);
        }
        if (s.frame.type === 'iface_result' || s.frame.type === 'iface_event') {
          if (!pending) at(i, `${s.frame.type} without a device message to carry`);
          else {
            if (s.frame.message !== pending.text) at(i, 'message is not the exact device text');
            if (s.frame.type === 'iface_result') {
              let id; try { id = JSON.parse(pending.text).id; } catch { id = undefined; }
              if (id !== lastId) at(i, `result id ${JSON.stringify(id)} does not answer request ${JSON.stringify(lastId)}`);
            } else {
              let ev; try { ev = JSON.parse(pending.text).ev; } catch { ev = undefined; }
              if (ev !== s.frame.stream) at(i, 'stream is not the event\'s ev');
            }
            pending = null;
          }
        }
        break;
      }
      case 'recv': {
        if (s.ignored) {
          if (typeof s.frame.type !== 'string' || [...AGENT, ...BACKEND].includes(s.frame.type)) at(i, 'an ignored frame must have an unknown string type');
          break;
        }
        for (const e of check(s.frame, 'backend_to_agent')) at(i, `recv: ${e}`);
        if (s.frame.type === 'iface_req') {
          if (lastReq) at(i, 'a second request before the first was written');
          lastReq = s.frame;
          lastId = s.frame.id;
          if (bytes(s.frame.wire).length > maxWire) at(i, `wire over ${maxWire} bytes`);
          try { if (typeof JSON.parse(s.frame.wire) !== 'object') throw new Error(); } catch { at(i, 'wire is not a JSON object text'); }
          if (doc.link === 'console' && /[\r\n]/.test(s.frame.wire)) at(i, 'console wire contains CR or LF');
        } else if (s.frame.type === 'iface_ack') {
          const key = JSON.stringify(s.frame.ref);
          if (sentRefs.get(key) !== s.frame.of) at(i, `ack of ${s.frame.of} ref ${key} matches no upload`);
          sentRefs.delete(key);
        } else if (s.frame.type === 'refused') {
          const next = steps[i + 1];
          if (!next || next.step !== 'close' || next.code !== 1008) at(i, 'refused must be followed by close 1008');
        }
        break;
      }
      case 'device_write': {
        if (s.hex !== undefined) {
          if (doc.link !== 'console' || s.hex !== '0d') at(i, 'the only raw write is the console\'s bare CR (0d)');
          break;
        }
        if (!lastReq) at(i, 'device_write of a wire that was never requested');
        else if (lastReq.wire !== s.wire) at(i, 'the wire written is not the wire received, byte for byte');
        lastReq = null;
        if (s.frames_hex) {
          const w = bytes(s.wire);
          const n = Math.ceil(w.length / 168);
          const want = [...Array(n).keys()].map((k) => Buffer.concat([Buffer.from([0x7f, s.xid, k, n]), w.subarray(k * 168, (k + 1) * 168)]).toString('hex'));
          if (n < 1 || n > 25) at(i, 'frame count outside 1..25');
          if (JSON.stringify(want) !== JSON.stringify(s.frames_hex)) at(i, 'frames_hex is not 7F xid index count chunk of 168-byte chunks');
          if (s.xid === undefined) at(i, 'frames_hex needs xid');
        }
        break;
      }
      case 'device_read':
        if (s.not_sent) {
          let ev; try { ev = JSON.parse(s.text).ev; } catch { ev = undefined; }
          if (typeof ev === 'string' && STREAM.test(ev) && ev !== 'result') at(i, 'not_sent event has a valid stream');
          break;
        }
        pending = { text: s.text };
        break;
      case 'device_line': {
        const isIface = /^\r*mecon> \{/.test(s.text);
        if (s.skipped && isIface) at(i, 'a skipped line starts with mecon> {');
        if (!s.skipped && !isIface) at(i, 'a line that does not start with mecon> { is not an interface message');
        if (!s.skipped) pending = { text: s.text.replace(/^\r*mecon> /, '') };
        break;
      }
      case 'close':
        if (s.by === 'backend' && s.code === 1008) {
          const prev = steps[i - 1];
          if (!prev || prev.step !== 'recv' || prev.frame.type !== 'refused') { /* a bare 1008 is the bad-token form: allowed */ }
        }
        break;
      default:
        at(i, `unknown step ${s.step}`);
    }
  });
  if (lastReq) fail(`fixtures/${file}: a request was received and never written`);
  if (pending) fail(`fixtures/${file}: a device message was read and never uploaded`);
  if ([...sentRefs.keys()].length && doc.id !== 'E') fail(`fixtures/${file}: uploads without an ack: ${[...sentRefs.keys()].join(',')}`);
}
