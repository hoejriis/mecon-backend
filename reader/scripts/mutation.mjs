#!/usr/bin/env node
/**
 * Mutation check for the Reader's security-sensitive rules (send safety, CSRF, probe allowlist).
 *
 * Each mutant breaks one rule in the source; the unit tests must then fail. The file is restored
 * afterwards whatever happens. Run from reader/:   node scripts/mutation.mjs
 *
 * Needs the installed dev dependencies (vitest). No new dependencies. A mutant counts as killed
 * only when vitest reports at least one failed test. A crash, a collection or compile error or a
 * timeout is "inconclusive", never a kill. Any survivor, inconclusive mutant or failing baseline
 * makes the exit code non-zero.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 10 * 60 * 1000;

// Test files that guard these rules. Each mutant runs this set (a superset of what it needs).
const T = {
  client: ['src/api/client.test.ts', 'src/api/m2client.test.ts', 'src/test/auth.test.tsx'],
  send: ['src/messaging', 'src/test/chats.test.tsx', 'src/test/localPaths.test.tsx'],
  device: ['src/device', 'src/messaging'],
  gate: ['src/offline', 'src/device', 'src/messaging'],
  probe: ['src/device'],
  ble: ['src/ble/adapter.test.ts'],
  cold: ['src/test/coldStart.test.tsx'],
};

/** @type {Array<{id:string, description:string, file:string, edits:Array<[string,string]>, tests:string[]}>} */
const MUTANTS = [
  // Capability check for Backend sends
  { id: 'cap1', description: 'need() accepts state "unknown" as available', file: 'src/api/client.ts', tests: T.client,
    edits: [["if (state !== 'available') throw new CapabilityError(name, state);", "if (state !== 'available' && state !== 'unknown') throw new CapabilityError(name, state);"]] },
  { id: 'cap2', description: 'need() never throws', file: 'src/api/client.ts', tests: T.client,
    edits: [["if (state !== 'available') throw new CapabilityError(name, state);", "if (false as boolean) throw new CapabilityError(name, state);"]] },
  { id: 'cap3', description: 'need() accepts state "unavailable" as available', file: 'src/api/client.ts', tests: T.client,
    edits: [["if (state !== 'available') throw new CapabilityError(name, state);", "if (state !== 'available' && state !== 'unavailable') throw new CapabilityError(name, state);"]] },
  { id: 'cap4', description: 'need() checks only the first capability asked for', file: 'src/api/client.ts', tests: T.client,
    edits: [["if (state !== 'available') throw new CapabilityError(name, state);", "if (state !== 'available') throw new CapabilityError(name, state);\n      break;"]] },

  // MessagingContext: Backend send and send-again
  { id: 'msg1', description: 'send-again skips the sendState check on the Backend path', file: 'src/messaging/MessagingContext.tsx', tests: T.send,
    edits: [["        if (sendState !== 'available') return { ok: false, reason: 'Sending through the Backend is not available.' };\n        next = startAttempt(", "        next = startAttempt("]] },
  { id: 'msg2', description: 'send skips the sendState check on the Backend path', file: 'src/messaging/MessagingContext.tsx', tests: T.send,
    edits: [["        if (sendState !== 'available') return { ok: false, reason: 'Sending through the Backend is not available.' };\n        consume();", "        consume();"]] },
  { id: 'msg3', description: 'send-again re-sends an attempt that was already sent again', file: 'src/messaging/MessagingContext.tsx', tests: T.send,
    edits: [["if (!old || old.supersededBy) return", "if (!old) return"]] },

  // Path offers
  { id: 'path1', description: 'availablePaths offers backend while offline', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["if (i.sendState === 'available' && i.online) out.push('backend');", "if (i.sendState === 'available') out.push('backend');"]] },
  { id: 'path2', description: 'availablePaths offers backend when send is not available', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["if (i.sendState === 'available' && i.online) out.push('backend');", "if (i.online) out.push('backend');"]] },
  { id: 'path3', description: 'availablePaths offers a local path for a device that is not connected', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["    const d = i.devices.find((x) => x.path === path);\n    if (!d || !d.connected || !d.capabilities.includes(need) || !ownsIdentity(d, i.identity)) continue;\n    // Only a target", "    const d = i.devices.find((x) => x.path === path);\n    if (!d || !d.capabilities.includes(need) || !ownsIdentity(d, i.identity)) continue;\n    // Only a target"]] },
  { id: 'path4', description: 'availablePaths offers a local path for a device without the send capability', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["    const d = i.devices.find((x) => x.path === path);\n    if (!d || !d.connected || !d.capabilities.includes(need) || !ownsIdentity(d, i.identity)) continue;\n    // Only a target", "    const d = i.devices.find((x) => x.path === path);\n    if (!d || !d.connected || !ownsIdentity(d, i.identity)) continue;\n    // Only a target"]] },
  { id: 'path5', description: 'availablePaths offers a local path for an unmapped destination', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["if (m && (m.ok || (i.target.kind === 'contact' && m.code === 'ambiguous'))) out.push(path);", "if (m || !m) out.push(path);"]] },

  // Device identity
  { id: 'own1', description: 'ownsIdentity always returns true', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["  if (!identity || !d.ownKey || identity.public_key_prefix === '') return false;\n  return d.ownKey.toLowerCase().startsWith(identity.public_key_prefix.toLowerCase());", "  return true;"]] },
  { id: 'own2', description: 'ownsIdentity accepts an empty identity prefix', file: 'src/messaging/localPath.ts', tests: T.send,
    edits: [["if (!identity || !d.ownKey || identity.public_key_prefix === '') return false;", "if (!identity || !d.ownKey) return false;"]] },
  { id: 'own3', description: 'DeviceSession.authorize skips the device-ownership check', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (!own || want === '' || !own.startsWith(want)) throw new BleError('wrong_device'", "if (false as boolean) throw new BleError('wrong_device'"]] },
  { id: 'own4', description: 'DeviceSession.authorize accepts an empty identity prefix', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (!own || want === '' || !own.startsWith(want)) throw new BleError('wrong_device'", "if (!own || !own.startsWith(want)) throw new BleError('wrong_device'"]] },

  // Destination token
  { id: 'tok1', description: 'verifyToken accepts a token this session did not mint', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (!token || typeof token !== 'object' || !this.minted.has(token)) return bad(", "if (!token) return bad("]] },
  { id: 'tok2', description: 'verifyToken accepts a token of another kind', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (token.kind !== kind) return bad(", "if (false as boolean) return bad("]] },
  { id: 'tok3', description: 'verifyToken accepts a token mapped for another target', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (!auth.targetId || token.targetId !== auth.targetId) return bad(", "if (false as boolean) return bad("]] },
  { id: 'tok4', description: 'verifyToken does not re-match against the device\'s current tables', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (!now.ok || !sameDestination(now.destination, token.destination)) return bad(", "if (!now.ok) return bad("]] },
  { id: 'tok5', description: 'verifyToken always succeeds', file: 'src/device/session.ts', tests: T.device,
    edits: [["    if (!token || typeof token !== 'object' || !this.minted.has(token)) return bad('the destination was not chosen by the device mapping for this target');\n    if (token.kind !== kind) return bad('the destination is for another kind of message');\n    if (!auth.targetId || token.targetId !== auth.targetId) return bad('the destination was mapped for another target');\n    const now = this.resolve(token.dest, token.pick);\n    if (!now.ok || !sameDestination(now.destination, token.destination)) return bad('the device no longer matches this target to that destination');\n    return now.destination;", "    return token!.destination;"]] },
  { id: 'tok6', description: 'authorize accepts a lease operation that does not match the send kind', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (auth.op !== (kind === 'direct' ? 'send.direct' : 'send.channel')) throw", "if (false as boolean) throw"]] },

  // Offline lease gate
  { id: 'gate1', description: 'DeviceSession.authorize ignores the offline guard decision', file: 'src/device/session.ts', tests: T.gate,
    edits: [["if (!decision.allowed) throw new OfflineSendBlocked(decision);", "void decision;"]] },
  { id: 'gate2', description: 'offlineSendGuard allows every send', file: 'src/offline/gate.ts', tests: T.gate,
    edits: [["return (current ?? new OfflineGate()).guard(q);", "return { allowed: true, basis: 'lease', reason: '' };"]] },
  { id: 'gate3', description: 'offline guard allows a send the lease does not permit', file: 'src/offline/gate.ts', tests: T.gate,
    edits: [["return { allowed: r.allowed, basis: r.allowed ? 'lease' : 'no-lease', reason: r.reason };", "return { allowed: true, basis: 'lease', reason: r.reason };"]] },
  { id: 'gate4', description: 'offline guard allows a send while locked (no lease attached)', file: 'src/offline/gate.ts', tests: T.gate,
    edits: [["if (!this.#leases) return { allowed: false, basis: 'locked', reason: 'Offline and locked: unlock first.' };", "if (!this.#leases) return { allowed: true, basis: 'lease', reason: '' };"]] },
  { id: 'gate5', description: 'offline mode treats a lease that is not valid as valid', file: 'src/offline/gate.ts', tests: T.gate,
    edits: [["if (s.lease?.state === 'valid') return", "if (s.lease) return"]] },
  { id: 'gate6', description: 'the local-send preflight ignores the offline guard', file: 'src/messaging/localSend.ts', tests: T.gate,
    edits: [["  if (!d.allowed) return { ok: false, reason: d.reason };\n  return { ok: true, auth, mapping: m.token };", "  return { ok: true, auth, mapping: m.token };"]] },

  // CSRF
  { id: 'csrf1', description: 'after csrf_failed the client retries without fetching the rotated token', file: 'src/api/client.ts', tests: T.client,
    edits: [["    await getSession();\n    return attempt();", "    return attempt();"]] },
  { id: 'csrf2', description: 'the client retries after any 403, not only csrf_failed', file: 'src/api/client.ts', tests: T.client,
    edits: [["if (err.code !== 'csrf_failed') return first;", "void err;"]] },
  { id: 'csrf3', description: 'the client sends no CSRF token on a state-changing request', file: 'src/api/client.ts', tests: T.client,
    edits: [["headers: { ...init.headers, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },", "headers: { ...init.headers },"]] },
  { id: 'csrf4', description: 'reset() keeps the CSRF token after sign-out', file: 'src/api/client.ts', tests: T.client,
    edits: [["    reset() {\n      csrfToken = null;\n", "    reset() {\n"]] },
  { id: 'csrf5', description: 'reset() keeps the capabilities after sign-out', file: 'src/api/client.ts', tests: T.client,
    edits: [["      csrfToken = null;\n      capabilities = null;", "      csrfToken = null;"]] },

  // Probe allowlist
  { id: 'probe1', description: 'probe allowlist admits a send-text command frame', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["Object.freeze([CMD.APP_START, CMD.DEVICE_QUERY])", "Object.freeze([CMD.APP_START, CMD.DEVICE_QUERY, CMD.SEND_TXT_MSG])"]] },
  { id: 'probe2', description: 'probe allowlist admits a send-channel-text command frame', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["Object.freeze([CMD.APP_START, CMD.DEVICE_QUERY])", "Object.freeze([CMD.APP_START, CMD.DEVICE_QUERY, CMD.SEND_CHANNEL_TXT_MSG])"]] },
  { id: 'probe3', description: 'probe admits any command code', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["  throw new BleError('bad_argument', `probe refused a write: command code ${code}`);", "  return { label: `frame:${code}` };"]] },
  { id: 'probe4', description: 'interface request is not checked against the read-only op list', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["MECON_READ_OPS.includes(e.op) &&", "true &&"]] },
  { id: 'probe5', description: 'interface request may carry arguments or auth fields', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["    keys.every((k) => k === 'v' || k === 'id' || k === 'op') && // no args, no auth: a read with nothing attached\n    keys.length === 3;", "    keys.length >= 3;"]] },
  { id: 'probe6', description: 'an interface request that fails the check is let through', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["  if (!ok) throw new BleError('bad_argument', `probe refused interface op", "  if (false as boolean) throw new BleError('bad_argument', `probe refused interface op"]] },
  { id: 'probe7', description: 'an interface request may be split over several frames', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["if (p.length < 5 || p[2] !== 0 || p[3] !== 1) throw", "if (p.length < 5) throw"]] },
  { id: 'probe8', description: 'a text line not on the CLI read-only list is let through', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["if (!CLI_READ_ONLY_LINES.includes(line)) return refuse(", "if (false as boolean) return refuse("]] },
  { id: 'probe9', description: 'a serial frame whose declared length does not match its bytes is let through', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["if (len > MAX_FRAME_SIZE || bytes.length !== SERIAL_HEADER_SIZE + len) return refuse(", "if (len > MAX_FRAME_SIZE) return refuse("]] },
  { id: 'probe10', description: 'a text line with a control or non-ASCII byte is let through', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["if (b < 0x20 || b > 0x7e) return refuse(", "if (false as boolean) return refuse("]] },
  { id: 'probe11', description: 'the BLE write guard does not classify frames', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["      const c = classifyProbeFrame(frame);", "      const c = { label: 'unchecked' };"]] },
  { id: 'probe12', description: 'the serial write guard does not classify bytes', file: 'src/device/guard.ts', tests: T.probe,
    edits: [["      const c = classifyProbeWrite(bytes);", "      const c = { label: 'unchecked' };"]] },
  // Exchange timers (reply timer after the write, bounded write, named op)
  { id: 'tmr1', description: 'reply timer started before the write (the old behaviour)', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["    try {\n      // The reply timer starts only", "    arm();\n    try {\n      // The reply timer starts only"],
      ["      if (this.inflight === me) arm();", "      if (false as boolean) arm();"]] },
  { id: 'tmr2', description: 'the write has no timeout', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["await this.withTimeout(this.transport.write(frame), this.writeTimeoutMs, 'write_timeout', `write of ${op} not completed (pairing not finished?)`);", "await this.transport.write(frame);"]] },
  { id: 'tmr3', description: 'response_timeout drops the op name', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["        fail(new BleError('response_timeout', `no answer to ${op}`));\n      }, this.responseTimeoutMs);", "        fail(new BleError('response_timeout'));\n      }, this.responseTimeoutMs);"]] },
  { id: 'tmr4', description: 'the write timeout reports response_timeout instead of write_timeout', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["this.writeTimeoutMs, 'write_timeout',", "this.writeTimeoutMs, 'response_timeout',"]] },
  { id: 'tmr5', description: 'the response timeout logs nothing', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["        console.warn(`[reader] response_timeout: no answer to ${op} within ${this.responseTimeoutMs} ms`);\n", ""]] },
  { id: 'tmr8', description: 'the reply bound is one total for a multi-frame reply, not a silence bound', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["        if (v === 'more' && t !== undefined) arm();", "        if (v === 'more' && t === undefined) arm();"]] },
  { id: 'ctc1', description: 'the contact list is awaited inside connect again', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["    void this.loadContacts().catch(() => undefined);", "    await this.loadContacts().catch(() => undefined);"]] },
  { id: 'ctc2', description: 'a failed contact load tears the connection down', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["      if (epoch === this.linkEpoch) this.set({ contactsState: 'failed' });", "      if (epoch === this.linkEpoch) this.set({ contactsState: 'failed' });\n      await this.transport.disconnect();"]] },
  { id: 'ctc3', description: 'a failed contact load is reported as loaded', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["      if (epoch === this.linkEpoch) this.set({ contactsState: 'failed' });", "      if (epoch === this.linkEpoch) this.set({ contactsState: 'loaded' });"]] },
  { id: 'ctc4', description: 'a direct destination maps while the contacts are still loading', file: 'src/device/session.ts', tests: T.device,
    edits: [["if (cs === 'loading' || cs === 'idle') return", "if (false as boolean) return"]] },
  { id: 'ctm1', description: 'the adapter connect step waits only 10 s', file: 'src/ble/adapter.ts', tests: T.ble,
    edits: [["opts.connectTimeoutMs ?? 20000", "opts.connectTimeoutMs ?? 10000"]] },
  { id: 'tmr9', description: 'BLE detection waits 3 s per step, not as long as the probe', file: 'src/device/detect.ts', tests: T.probe,
    edits: [["const timeout = opts.stepTimeoutMs ?? 8000;", "const timeout = opts.stepTimeoutMs ?? 3000;"]] },
  { id: 'tmr6', description: 'request() starts its reply timer before the writes (the old behaviour)', file: 'src/device/session.ts', tests: T.device,
    edits: [["    try {\n      // Each write is bounded", "    timer = setTimeout(() => fail(new BleError('response_timeout', `no answer to ${op}`)), timeoutMs);\n    try {\n      // Each write is bounded"],
      ["      timer = setTimeout(() => {\n        console.warn(`[reader] response_timeout: no answer to ${op} within ${timeoutMs} ms`);\n        fail(new BleError('response_timeout', `no answer to ${op}`));\n      }, timeoutMs);\n      return await answer;", "      return await answer;"]] },
  { id: 'tmr7', description: 'request() does not bound its writes', file: 'src/device/session.ts', tests: T.device,
    edits: [["              wt = setTimeout(() => {\n                console.warn(`[reader] write_timeout during", "              wt = setTimeout(() => {\n                if (true as boolean) return;\n                console.warn(`[reader] write_timeout during"]] },
  // Cold start with a hung session read
  { id: 'cold1', description: 'the app-start session read has no timeout', file: 'src/auth/AuthContext.tsx', tests: T.cold,
    edits: [["setTimeout(() => readCtl.abort(), SESSION_READ_TIMEOUT_MS)", "setTimeout(() => undefined, SESSION_READ_TIMEOUT_MS)"]] },
  { id: 'cold2', description: 'offline at start waits for the session read instead of showing the offline screen', file: 'src/App.tsx', tests: T.cold,
    edits: [["const offlineAtStart = status === 'loading' && !navigator.onLine;", "const offlineAtStart = false as boolean;"]] },
];

// ---------------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'reader-mutation-'));
let runNo = 0;

/** Run vitest on `tests` (or everything). Returns {kind: 'pass'|'fail'|'inconclusive', failed, detail}. */
function runVitest(tests) {
  const out = join(tmp, `report-${++runNo}.json`);
  const args = ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...tests];
  const r = spawnSync('npx', args, { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1 << 28, env: { ...process.env, CI: '1' } });
  if (r.error) return { kind: 'inconclusive', failed: [], detail: r.error.code === 'ETIMEDOUT' ? 'timeout' : `could not run: ${r.error.message}` };
  let rep;
  try {
    rep = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    return { kind: 'inconclusive', failed: [], detail: `no readable vitest report (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}` };
  }
  const failed = [];
  let emptyFailedSuites = 0;
  for (const f of rep.testResults ?? []) {
    const names = (f.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => `${f.name.replace(`${ROOT}/`, '')} > ${a.fullName ?? a.title}`);
    failed.push(...names);
    if (f.status === 'failed' && names.length === 0) emptyFailedSuites++;
  }
  if (failed.length > 0) return { kind: 'fail', failed, detail: '' };
  if (emptyFailedSuites > 0 || rep.success === false) return { kind: 'inconclusive', failed: [], detail: `suite error with no failed test (${emptyFailedSuites} suite(s)); exit ${r.status}` };
  if (!rep.numTotalTests) return { kind: 'inconclusive', failed: [], detail: 'no tests ran' };
  if (r.status !== 0) return { kind: 'inconclusive', failed: [], detail: `exit ${r.status} with no failed test` };
  return { kind: 'pass', failed: [], detail: `${rep.numPassedTests} passed` };
}

const originals = new Map();
function restoreAll() {
  for (const [path, text] of originals) writeFileSync(path, text);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}

// Static check first: every pattern must occur exactly once (a stale pattern must not pass as a kill).
const results = [];
function countOccurrences(text, needle) {
  return needle === '' ? 0 : text.split(needle).length - 1;
}

if (process.argv.includes('--check-patterns')) {
  // No vitest: only report patterns that do not occur exactly once, and edits that change nothing.
  let bad = 0;
  for (const m of MUTANTS) {
    let text = readFileSync(join(ROOT, m.file), 'utf8');
    for (const [oldS, newS] of m.edits) {
      const n = countOccurrences(text, oldS);
      if (n !== 1 || oldS === newS) {
        bad++;
        console.log(`${m.id}: ${n} occurrences of ${JSON.stringify(oldS.slice(0, 70))}`);
      } else text = text.replace(oldS, () => newS);
    }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad pattern(s)`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}

console.log('Control: unmutated suite');
const control = runVitest([]);
if (control.kind !== 'pass') {
  console.error(`CONTROL FAILED (${control.kind}): ${control.detail} ${control.failed.slice(0, 5).join('; ')}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
}
console.log(`control ok (${control.detail})\n`);

try {
  for (const m of MUTANTS) {
    const path = join(ROOT, m.file);
    const src = readFileSync(path, 'utf8');
    let text = src;
    let missing = null;
    for (const [oldS, newS] of m.edits) {
      const n = countOccurrences(text, oldS);
      if (n !== 1) {
        missing = `pattern not found exactly once (${n} occurrences): ${JSON.stringify(oldS.slice(0, 70))}`;
        break;
      }
      text = text.replace(oldS, () => newS);
    }
    if (missing) {
      results.push({ m, kind: 'survived', detail: missing });
      console.log(`SURVIVED ${m.id}: ${m.description} -- ${missing}`);
      continue;
    }
    if (text === src) {
      results.push({ m, kind: 'survived', detail: 'mutation changes nothing' });
      console.log(`SURVIVED ${m.id}: ${m.description} -- mutation changes nothing`);
      continue;
    }
    originals.set(path, src);
    let r;
    try {
      writeFileSync(path, text);
      r = runVitest(m.tests);
    } finally {
      writeFileSync(path, src);
      originals.delete(path);
    }
    if (r.kind === 'fail') {
      results.push({ m, kind: 'killed', detail: r.failed[0] });
      console.log(`killed ${m.id}: ${m.description} (${r.failed.length} failed; first: ${r.failed[0]})`);
    } else if (r.kind === 'pass') {
      results.push({ m, kind: 'survived', detail: `all tests passed (${r.detail})` });
      console.log(`SURVIVED ${m.id}: ${m.description} -- all tests passed`);
    } else {
      results.push({ m, kind: 'inconclusive', detail: r.detail });
      console.log(`INCONCLUSIVE ${m.id}: ${m.description} -- ${r.detail}`);
    }
  }
} finally {
  restoreAll();
}

const after = runVitest([]);
console.log(`\nrestored; baseline ${after.kind === 'pass' ? 'passes' : 'FAILS'}`);
rmSync(tmp, { recursive: true, force: true });

const killed = results.filter((r) => r.kind === 'killed').length;
const survivors = results.filter((r) => r.kind === 'survived');
const inconclusive = results.filter((r) => r.kind === 'inconclusive');
console.log(`${killed} of ${results.length} mutants killed`);
if (survivors.length) {
  console.log('Survivors:');
  for (const s of survivors) console.log(`  ${s.m.id} (${s.m.file}): ${s.m.description} -- ${s.detail}`);
}
if (inconclusive.length) {
  console.log('Inconclusive:');
  for (const s of inconclusive) console.log(`  ${s.m.id} (${s.m.file}): ${s.m.description} -- ${s.detail}`);
}
process.exit(survivors.length || inconclusive.length || after.kind !== 'pass' ? 1 : 0);
