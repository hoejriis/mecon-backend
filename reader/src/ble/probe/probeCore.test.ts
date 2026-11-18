import { describe, expect, it } from 'vitest';
import { MockCompanion, MockTransport } from '../mockCompanion';
import { installFakeBluetooth } from '../fakeBluetooth';
import { CMD, encodeSendChannel, encodeSendDirect, encodeGetContacts, encodeSyncNextMessage, hexOf } from '../protocol';
import { SYNTHETIC_KEYS } from '../fixtures/frames';
import { WebBluetoothTransport } from '../webBluetoothTransport';
import { encodeMeconFrames } from '../../device/meconIface';
import {
  ALLOWED_CMD_CODES,
  guardTransport,
  runProbe,
  sanitizeReport,
  scrubText,
  type Environment,
  type RawProbe,
  type Step,
  type StepId,
} from './probeCore';

const env: Environment = { userAgent: 'TestAgent/1.0', bluetoothPresent: true, availability: 'true' };
const fast = { connectTimeoutMs: 80, responseTimeoutMs: 80, disconnectWaitMs: 40 };
const byId = (steps: Step[], id: StepId) => steps.find((s) => s.id === id)!;
const statuses = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.id, s.status]));

describe('read-only allowlist', () => {
  it('holds exactly the two read-only hello commands', () => {
    expect([...ALLOWED_CMD_CODES].sort((a, b) => a - b)).toEqual([CMD.APP_START, CMD.DEVICE_QUERY]);
  });

  it('refuses every non-allowlisted frame before the transport sees it', async () => {
    const mock = new MockCompanion();
    const g = guardTransport(new MockTransport(mock));
    await g.requestDevice();
    await g.connect();
    const frames = [
      encodeSendChannel(0, 'x', 1, 'Synth'),
      encodeSendDirect(SYNTHETIC_KEYS.alice, 'x', 1),
      encodeGetContacts(),
      encodeSyncNextMessage(),
      Uint8Array.of(0x99),
      new Uint8Array(0),
    ];
    for (const f of frames) await expect(g.write(f)).rejects.toMatchObject({ code: 'bad_argument' });
    expect(mock.writes).toHaveLength(0);
  });

  it('a full probe run writes only allowlisted codes and causes no RF', async () => {
    const mock = new MockCompanion();
    const raw = await runProbe({ transport: new MockTransport(mock), env, ...fast });
    expect(mock.writes.length).toBeGreaterThan(0);
    // The native codes are the two allowlisted; the interface carrier 0x7F is allowed only as one read-only hello (see the BLE detection tests).
    for (const w of mock.writes) expect([...ALLOWED_CMD_CODES, 0x7f]).toContain(w[0]);
    expect(mock.sendWrites()).toHaveLength(0);
    expect(mock.rf).toHaveLength(0);
    expect(raw.commandCodesSent.sort((a, b) => a - b)).toEqual([CMD.APP_START, CMD.DEVICE_QUERY, 0x7f]);
    expect(raw.commandsSent).toEqual(['frame-iface:hello', 'frame:22', 'frame:1']);
  });
});

describe('step reporting (MockTransport)', () => {
  it('reports every step on the happy path', async () => {
    const updates: RawProbe[] = [];
    const raw = await runProbe({ transport: new MockTransport(new MockCompanion()), env, ...fast, onUpdate: (r) => updates.push(r) });
    expect(statuses(raw.steps)).toEqual({
      environment: 'pass',
      chooser: 'pass',
      connect: 'pass',
      service: 'unknown', // the mock transport reports no sub-steps
      notifications: 'unknown',
      deviceQuery: 'pass',
      selfInfo: 'pass',
      battery: 'unsupported',
      disconnect: 'pass',
    });
    expect(raw.deviceInfo?.firmwareVersion).toBe(10);
    expect(raw.selfInfo?.name).toBe('Synthetic Node');
    expect(updates.length).toBeGreaterThan(5);
    for (const s of raw.steps.filter((x) => x.status === 'pass')) expect(s.ms).not.toBeNull();
  });

  it('chooser cancelled: later steps unknown, no link made', async () => {
    const mock = new MockCompanion();
    mock.faults.requestDevice = 'cancel';
    const raw = await runProbe({ transport: new MockTransport(mock), env, ...fast });
    expect(byId(raw.steps, 'chooser')).toMatchObject({ status: 'fail', error: { code: 'chooser_cancelled' } });
    expect(byId(raw.steps, 'connect').status).toBe('unknown');
    expect(byId(raw.steps, 'deviceQuery').status).toBe('unknown');
    expect(byId(raw.steps, 'disconnect').status).toBe('unknown');
    expect(mock.writes).toHaveLength(0);
  });

  it('unsupported browser is reported as unsupported', async () => {
    const raw = await runProbe({ transport: new MockTransport(new MockCompanion(), { unsupported: true }), env: { ...env, bluetoothPresent: false, availability: 'not_available' }, ...fast });
    expect(byId(raw.steps, 'environment').status).toBe('unsupported');
    expect(byId(raw.steps, 'chooser').status).toBe('unsupported');
  });

  it('connect failure and connect timeout fail the connect step', async () => {
    for (const f of ['fail', 'timeout'] as const) {
      const mock = new MockCompanion();
      mock.faults.connect = f;
      const raw = await runProbe({ transport: new MockTransport(mock), env, ...fast });
      expect(byId(raw.steps, 'connect').status).toBe('fail');
      expect(byId(raw.steps, 'connect').error?.code).toBe(f === 'fail' ? 'connect_failed' : 'connect_timeout');
      expect(byId(raw.steps, 'deviceQuery').status).toBe('unknown');
      expect(mock.writes).toHaveLength(0);
    }
  });

  it('a silent device fails hello with response_timeout and still disconnects', async () => {
    const mock = new MockCompanion();
    const t = new MockTransport(mock);
    t.write = async () => undefined; // frame accepted, never answered
    const raw = await runProbe({ transport: t, env, ...fast });
    expect(byId(raw.steps, 'deviceQuery')).toMatchObject({ status: 'fail', error: { code: 'response_timeout' } });
    expect(byId(raw.steps, 'selfInfo').status).toBe('unknown');
    expect(byId(raw.steps, 'disconnect').status).toBe('pass');
  });

  it('an error frame from the device fails the step with its name', async () => {
    const mock = new MockCompanion();
    const t = new MockTransport(mock);
    // Replace the device query with an unsupported-command reply path: wrong first byte is refused by the guard.
    const orig = mock.receive.bind(mock);
    mock.receive = (f: Uint8Array) => orig(f[0] === CMD.DEVICE_QUERY ? Uint8Array.of(0x7f) : f);
    const raw = await runProbe({ transport: t, env, ...fast });
    expect(byId(raw.steps, 'deviceQuery').status).toBe('fail');
    expect(byId(raw.steps, 'deviceQuery').error?.message).toContain('unsupported_cmd');
  });

  it('reports connect sub-steps from the Web Bluetooth transport', async () => {
    const nav: Record<string, unknown> = {};
    installFakeBluetooth(nav, new MockCompanion());
    const raw = await runProbe({ transport: new WebBluetoothTransport(nav), env, ...fast });
    expect(statuses(raw.steps)).toMatchObject({ connect: 'pass', service: 'pass', notifications: 'pass', deviceQuery: 'pass', selfInfo: 'pass', disconnect: 'pass' });
  });

  it('asks for the chooser synchronously, before any await', () => {
    let called = false;
    const t = new MockTransport(new MockCompanion());
    const orig = t.requestDevice.bind(t);
    t.requestDevice = () => {
      called = true;
      return orig();
    };
    const p = runProbe({ transport: t, env, ...fast });
    expect(called).toBe(true);
    return p;
  });
});

describe('sanitizer', () => {
  const SECRET_NAME = 'Zed-Private-Radio';
  const SECRET_NODE = 'Kitchen Node 7';
  const SECRET_ID = 'AA:BB:CC:DD:EE:FF';
  const SECRET_KEY = '11'.repeat(32);
  const fixture = (): RawProbe => ({
    startedAt: 0,
    env,
    device: { id: SECRET_ID, name: SECRET_NAME },
    deviceInfo: { firmwareVersion: 10, maxContacts: 100, maxChannels: 8, firmwareBuild: '01 Jan 2026', model: 'Board for Zed-Private-Radio', version: 'v1.2.3', clientRepeat: false, pathHashMode: 1 },
    selfInfo: {
      advType: 1, txPower: 22, maxTxPower: 30, publicKey: SECRET_KEY, advLat: 55.123456, advLon: -12.345678, multiAcks: 0, advLocPolicy: 0,
      telemetryMode: 0, manualAddContacts: false, radioFreqMHz: 869.618, radioBwKHz: 62.5, radioSf: 8, radioCr: 8, name: SECRET_NODE,
    },
    steps: [
      {
        id: 'connect', label: 'Connect', status: 'fail', ms: 12,
        error: { name: 'BleError', code: 'connect_failed', message: `Failed ${SECRET_NAME} ${SECRET_ID} id ${SECRET_ID.toLowerCase()} pin 123456 key ${SECRET_KEY}` },
        note: `device ${SECRET_NODE}`,
      },
    ],
    commandCodesSent: [22, 1],
  });

  it('removes keys, names, ids, coordinates and PINs and keeps presence and lengths', () => {
    const rep = sanitizeReport(fixture(), { now: () => new Date('2026-01-02T03:04:05Z'), commit: 'abc123' });
    const json = JSON.stringify(rep);
    for (const bad of [SECRET_NAME, SECRET_NODE, SECRET_ID, SECRET_ID.toLowerCase(), SECRET_KEY, '55.123456', '12.345678', '123456', 'Private']) {
      expect(json, bad).not.toContain(bad);
    }
    expect(rep.device).toEqual({ chosen: true, idPresent: true, nameLength: SECRET_NAME.length });
    expect(rep.selfInfo).toMatchObject({ publicKeyPresent: true, publicKeyHexLength: 64, nodeNamePresent: true, nodeNameLength: SECRET_NODE.length, locationPresent: true });
    expect(rep.selfInfo).not.toHaveProperty('publicKey');
    expect(rep.selfInfo).not.toHaveProperty('name');
    expect(rep.selfInfo).not.toHaveProperty('advLat');
    expect(rep.hello).toMatchObject({ firmwareVersion: 10, maxChannels: 8, version: 'v1.2.3', firmwareBuild: '01 Jan 2026' });
    expect(rep.probe.buildCommit).toBe('abc123');
    expect(rep.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(rep.userAgent).toBe('TestAgent/1.0');
    expect(rep.readOnly).toBe(true);
  });

  it('scrubText redacts hex runs, MACs and 6-digit numbers', () => {
    expect(scrubText('a1b2c3d4e5f6a7b8 00:11:22:33:44:55 pin 654321', [])).not.toMatch(/a1b2c3d4|00:11|654321/);
  });

  it('a real probe run over the mock yields a report with no mock secrets', async () => {
    const raw = await runProbe({ transport: new MockTransport(new MockCompanion()), env, ...fast });
    const json = JSON.stringify(sanitizeReport(raw));
    for (const bad of ['Synthetic Node', 'MeshCore-Synthetic', 'synthetic-device-1', hexOf(new Uint8Array(32).fill(0x11)), '55.123456', '123456']) {
      expect(json, bad).not.toContain(bad);
    }
  });
});

describe('probe with the shared detection (MockTransport, SIMULATED)', () => {
  const run = (o: ConstructorParameters<typeof MockCompanion>[0]) => {
    const mock = new MockCompanion(o);
    return runProbe({ transport: new MockTransport(mock), env, ...fast }).then((raw) => ({ mock, raw }));
  };
  const ops = (m: MockCompanion) => m.ifaceRequests.map((r) => r.op);

  it('MECON Companion: detected firmware, role and capabilities in the report; only read requests reach the device', async () => {
    const { mock, raw } = await run({ mecon: true });
    expect(statuses(raw.steps)).toMatchObject({ deviceQuery: 'pass', selfInfo: 'pass', disconnect: 'pass' });
    const rep = sanitizeReport(raw, { commit: 'x' });
    expect(rep.probe.version).toBe(2);
    expect(rep.linkTrust).toBe('unknown');
    expect(rep.commandsSent).toEqual(['frame-iface:hello', 'frame:22', 'frame:1']);
    expect(rep.detected).toMatchObject({ transport: 'ble', trust: 'unknown', firmware: 'mecon', role: 'companion', roleSource: 'hello', interfaceVersion: '1.0', companionBinary: true, interfaceRefused: false });
    expect(rep.detected!.capabilities).toEqual(expect.arrayContaining(['identity.read', 'status.read', 'clock.read']));
    expect(rep.detected!.firmwareVersion).toMatch(/^v1\.18\.0-mecon/);
    expect(ops(mock)).toEqual(['hello']);
    for (const w of mock.writes) expect([1, 22, 0x7f]).toContain(w[0]);
    expect(mock.sendWrites()).toHaveLength(0);
    expect(mock.rf).toHaveLength(0);
  });

  it('stock Companion: reported as not MECON, the probe still passes its native steps', async () => {
    const { mock, raw } = await run({});
    const rep = sanitizeReport(raw, { commit: 'x' });
    expect(rep.detected).toMatchObject({ firmware: 'unknown', role: 'companion', roleSource: 'companion frames', companionBinary: true, interfaceVersion: null });
    expect(rep.detected!.summary).toMatch(/^Not MECON firmware or older/);
    expect(statuses(raw.steps)).toMatchObject({ deviceQuery: 'pass', selfInfo: 'pass' });
    expect(mock.ifaceRequests).toHaveLength(0);
  });

  it('unknown device: nothing answers, the steps fail truthfully and the report says unknown', async () => {
    const { raw } = await run({ silent: true });
    const rep = sanitizeReport(raw, { commit: 'x' });
    expect(rep.detected).toMatchObject({ firmware: 'unknown', role: 'unknown', capabilities: [] });
    expect(rep.detected!.summary).toMatch(/^Unknown device/);
    expect(byId(raw.steps, 'deviceQuery')).toMatchObject({ status: 'fail', error: { code: 'response_timeout' } });
    expect(byId(raw.steps, 'selfInfo').status).toBe('unknown');
  });

  it('the report holds no device name, id, key or node name, and the detected block is sanitized', async () => {
    const { raw } = await run({ mecon: true, deviceName: 'Zed-Private-Radio' });
    const text = JSON.stringify(sanitizeReport(raw, { commit: 'x' }));
    for (const bad of ['Zed-Private-Radio', 'synthetic-device-1', 'ab'.repeat(16), 'cd'.repeat(32), 'Synthetic Node']) expect(text, bad).not.toContain(bad);
  });

  it('a hello the device refuses is shown as refused, and the native steps still run', async () => {
    const { raw } = await run({ mecon: true, helloRefused: true });
    const rep = sanitizeReport(raw, { commit: 'x' });
    expect(rep.detected).toMatchObject({ firmware: 'unknown', interfaceRefused: true });
    expect(statuses(raw.steps)).toMatchObject({ deviceQuery: 'pass', selfInfo: 'pass' });
  });

  it('the guard refuses a non-read interface request before the transport, so the device never sees it', async () => {
    const mock = new MockCompanion({ mecon: true });
    const g = guardTransport(new MockTransport(mock));
    await g.requestDevice();
    await g.connect();
    for (const op of ['config.apply', 'device.reboot', 'message.send', 'advert.send']) {
      const [f] = encodeMeconFrames(1, JSON.stringify({ v: 1, id: 'z', op }));
      await expect(g.write(f!), op).rejects.toMatchObject({ code: 'bad_argument' });
    }
    expect(mock.writes).toHaveLength(0);
  });
});
