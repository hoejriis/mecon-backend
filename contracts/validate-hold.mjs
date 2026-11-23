// Validates the WebSocket hold contract (contracts/connector-hold/v1): every frame schema, every fixture
// (schema, then the protocol's own rules: framing, exactness, ack matching, the line filter), the frames the
// schemas must reject, and that the README references every schema and fixture file, so an unreferenced
// fixture fails CI. Called from validate.mjs. The Connector's tests replay the same fixtures.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const AGENT = ['iface_relay', 'status', 'iface_hello', 'iface_result', 'iface_event', 'dfu_state'];
const BACKEND = ['iface_req', 'iface_ack', 'refused', 'dfu_job'];
// dfu_state order (section 12): each state may follow only these
const DFU_NEXT = {
  start: ['fetching'],
  fetching: ['ready', 'failed'],
  ready: ['waiting-bootloader', 'failed'],
  'waiting-bootloader': ['transferring', 'failed'],
  transferring: ['transferring', 'rebooting', 'failed'],
  rebooting: ['installed-pending-hello', 'failed'],
  'installed-pending-hello': [],
  failed: ['fetching'],
};
const OPCODE = { 3: 'start', 1: 'init', 4: 'data', 5: 'stop' };
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

// ---- legacy Nordic serial DFU, written here independently of the Connector and the fixture generator ----

function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// One SLIP frame (C0 ... C0) to its bytes, or a reason it is not one.
function unslip(buf) {
  if (buf.length < 2 || buf[0] !== 0xc0 || buf[buf.length - 1] !== 0xc0) return { err: 'not framed by C0' };
  const out = [];
  for (let k = 1; k < buf.length - 1; k++) {
    const b = buf[k];
    if (b === 0xc0) return { err: 'C0 inside a frame' };
    if (b === 0xdb) {
      const n = buf[++k];
      if (n === 0xdc) out.push(0xc0); else if (n === 0xdd) out.push(0xdb); else return { err: 'bad escape' };
    } else out.push(b);
  }
  return { bytes: Buffer.from(out) };
}

function headerOk(h) { return h.length >= 4 && ((h[0] + h[1] + h[2] + h[3]) & 0xff) === 0; }

// The stored entries of a zip (no compression), by local file header.
function storedZip(buf) {
  const files = {};
  let k = 0;
  while (k + 30 <= buf.length && buf.readUInt32LE(k) === 0x04034b50) {
    const method = buf.readUInt16LE(k + 8);
    const size = buf.readUInt32LE(k + 18);
    const nlen = buf.readUInt16LE(k + 26);
    const xlen = buf.readUInt16LE(k + 28);
    const name = buf.subarray(k + 30, k + 30 + nlen).toString('utf8');
    const start = k + 30 + nlen + xlen;
    if (method !== 0) return null;
    files[name] = buf.subarray(start, start + size);
    k = start + size;
  }
  return files;
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
  // section 12
  let declaredDfu = false;
  let dfu = null; // the armed job
  let dfuState = 'start';
  let appUp = true;
  let bootOpen = false;
  let reopened = false; // the application port came back; iface_relay must come again before iface_hello
  let relayedAgain = false;
  let pkgFiles = null;
  const packets = [];
  let image = Buffer.alloc(0);
  let startSize = null;
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
        if (s.frame.type === 'iface_relay') {
          if (s.frame.serial_dfu === true) declaredDfu = true;
          if (reopened) relayedAgain = true;
        }
        if (s.frame.type === 'iface_hello' && reopened && !relayedAgain) at(i, 'after the application port returns, iface_relay comes before iface_hello');
        if (s.frame.type === 'dfu_state') {
          if (!dfu) at(i, 'dfu_state without a dfu_job');
          else if (s.frame.job !== dfu.job) at(i, 'dfu_state for another job');
          const st = s.frame.state;
          if (!(DFU_NEXT[dfuState] || []).includes(st)) at(i, `dfu_state ${st} may not follow ${dfuState}`);
          if (st === 'waiting-bootloader' && appUp) at(i, 'waiting-bootloader before the application port dropped');
          if (st === 'transferring' && !bootOpen) at(i, 'transferring without the bootloader port open');
          if (st === 'rebooting' && packets.at(-1) !== 'stop') at(i, 'rebooting before the stop packet was acknowledged');
          if (st === 'installed-pending-hello' && !appUp) at(i, 'installed-pending-hello before the application port returned');
          dfuState = st;
        }
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
        if (s.frame.type === 'dfu_job') {
          if (!declaredDfu) at(i, 'dfu_job on a socket that did not declare serial_dfu');
          dfu = { job: s.frame.job, sha256: s.frame.sha256, size: s.frame.size };
          dfuState = 'start';
        }
        if (s.frame.type === 'iface_req') {
          let op; try { op = JSON.parse(JSON.parse(s.frame.wire).body).op; } catch { op = undefined; }
          if (op === 'update.offer' && dfu && dfuState !== 'ready') at(i, 'the offer is relayed only after dfu_state ready for the job');
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
        if (!appUp) at(i, 'nothing is written while the application port is down');
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
      case 'package_get': {
        if (!dfu) { at(i, 'package_get without a dfu_job'); break; }
        if (s.path !== `/gateway/dfu-package/${dfu.job}`) at(i, 'package path is not the job\'s');
        if (s.size !== dfu.size || s.sha256 !== dfu.sha256) at(i, 'package size or sha256 differs from dfu_job');
        const body = Buffer.from(s.body_base64, 'base64');
        if (body.length !== dfu.size) at(i, 'package body length is not dfu_job.size');
        if (createHash('sha256').update(body).digest('hex') !== dfu.sha256) at(i, 'package body sha256 is not dfu_job.sha256');
        pkgFiles = storedZip(body);
        if (!pkgFiles) { at(i, 'the fixture package is not a stored zip'); break; }
        try {
          const man = JSON.parse(pkgFiles['manifest.json'].toString('utf8')).manifest.application;
          pkgFiles = { bin: pkgFiles[man.bin_file], dat: pkgFiles[man.dat_file] };
          if (!pkgFiles.bin || !pkgFiles.dat) throw new Error();
        } catch { at(i, 'the package has no application bin_file and dat_file'); pkgFiles = null; }
        break;
      }
      case 'device_link':
        if (s.port === 'application' && s.event === 'lost') {
          if (!dfu || dfuState !== 'ready') at(i, 'the socket stays only for a job that is ready; otherwise the agent closes it');
          appUp = false;
        } else if (s.port === 'application' && s.event === 'opened') {
          appUp = true;
          reopened = true;
          relayedAgain = false;
        } else if (s.port === 'bootloader' && s.event === 'opened') {
          if (!dfu || appUp) at(i, 'the bootloader port is opened only for an armed job after the application port dropped');
          bootOpen = true;
        } else if (s.port === 'bootloader' && s.event === 'closed') {
          bootOpen = false;
        } else at(i, 'unknown device_link event');
        break;
      case 'bootloader_write': {
        if (!bootOpen) at(i, 'bootloader_write while the bootloader port is not open');
        const f = unslip(Buffer.from(s.hex, 'hex'));
        if (f.err) { at(i, f.err); break; }
        const b = f.bytes;
        if (b.length < 10 || !headerOk(b)) { at(i, 'bad HCI header'); break; }
        const seq = b[0] & 7;
        const len = (b[1] >> 4) | (b[2] << 4);
        if (seq !== s.seq || ((b[0] >> 3) & 7) !== (seq + 1) % 8 || (b[0] >> 6) !== 3 || (b[1] & 0xf) !== 14) at(i, 'HCI header fields');
        const payload = b.subarray(4, b.length - 2);
        if (len !== payload.length) at(i, 'HCI length');
        if (crc16(b.subarray(0, b.length - 2)) !== b.readUInt16LE(b.length - 2)) at(i, 'HCI CRC16');
        const kind = OPCODE[payload.readUInt32LE(0)];
        if (kind !== s.packet) at(i, `opcode is ${kind}, the step says ${s.packet}`);
        const want = { start: [undefined], init: ['start'], data: ['init', 'data'], stop: ['data'] }[s.packet];
        if (!want.includes(packets.at(-1))) at(i, `${s.packet} after ${packets.at(-1)}`);
        if (packets.length && s.seq !== (packets.length + 1) % 8) at(i, 'sequence numbers are not consecutive from 1');
        if (!packets.length && s.seq !== 1) at(i, 'the first packet has sequence number 1');
        packets.push(s.packet);
        if (kind === 'start') {
          if (payload.length !== 20 || payload.readUInt32LE(4) !== 4 || payload.readUInt32LE(8) || payload.readUInt32LE(12)) at(i, 'start: application mode 4, no SoftDevice or bootloader');
          startSize = payload.readUInt32LE(16);
        } else if (kind === 'init') {
          if (payload.readUInt16LE(payload.length - 2) !== 0) at(i, 'init: two zero bytes after the init packet');
          if (pkgFiles && !payload.subarray(4, payload.length - 2).equals(pkgFiles.dat)) at(i, 'init packet is not the package\'s dat_file');
        } else if (kind === 'data') {
          if (payload.length - 4 > 512 || payload.length <= 4) at(i, 'data: 1 to 512 bytes');
          image = Buffer.concat([image, payload.subarray(4)]);
        } else if (kind === 'stop') {
          if (payload.length !== 4) at(i, 'stop: the opcode only');
          if (startSize !== image.length) at(i, 'the image sent is not the size start announced');
          if (pkgFiles && !image.equals(pkgFiles.bin)) at(i, 'the image sent is not the package\'s bin_file');
        }
        const a = unslip(Buffer.from(s.ack_hex, 'hex'));
        if (a.err || !headerOk(a.bytes) || ((a.bytes[0] >> 3) & 7) !== (seq + 1) % 8) at(i, 'ack_hex is not the acknowledgement of this packet');
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
  if (packets.length && packets.at(-1) !== 'stop') fail(`fixtures/${file}: the transfer does not end with stop`);
  if (!appUp) fail(`fixtures/${file}: ends with the application port down`);
  if (pending) fail(`fixtures/${file}: a device message was read and never uploaded`);
  if ([...sentRefs.keys()].length && doc.id !== 'E') fail(`fixtures/${file}: uploads without an ack: ${[...sentRefs.keys()].join(',')}`);
}
