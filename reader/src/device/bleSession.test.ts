import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockCompanion, MockTransport, type MockCompanionOptions } from '../ble/mockCompanion';
import { SYNTHETIC_KEYS } from '../ble/fixtures/frames';
import { CMD } from '../ble/protocol';
import { detectBleDevice } from './detect';
import { authFor, companionRig, wait } from './rig.test-util';
import { DeviceSession, type SessionOptions } from './session';

const S = 'SIMULATED — not hardware verified: Bluetooth device session';
const alice = SYNTHETIC_KEYS.alice;
const sessions: DeviceSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

const OPTS: SessionOptions = { detect: { stepTimeoutMs: 120 }, companion: { responseTimeoutMs: 150, connectTimeoutMs: 150, nowSec: () => 1700000000 } };

function bleRig(mockOpts: MockCompanionOptions = {}) {
  const mock = new MockCompanion(mockOpts);
  const transport = new MockTransport(mock);
  const backend = { post: vi.fn(async () => undefined) };
  const session = new DeviceSession(transport, { ...OPTS, companion: { ...OPTS.companion, backendPath: backend } });
  sessions.push(session);
  return { mock, transport, session, backend };
}
const MECON: MockCompanionOptions = { mecon: true };
const dm = (id: string) => ({ clientDraftId: 'd1', clientAttemptId: id, contactKey: alice, text: 'hello dm', auth: authFor() });
const ifaceOps = (m: MockCompanion) => m.ifaceRequests.map((r) => r.op);

describe(`${S}: detection`, () => {
  it('MECON Companion: hello as 0x7F frames, then the device query; firmware, role and capabilities come from the answers', async () => {
    const r = bleRig(MECON);
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    const s = r.session.getSnapshot();
    expect(s.detected).toMatchObject({ transport: 'ble', trust: 'unknown', firmware: 'mecon', role: 'companion', roleSource: 'hello', carriage: 'companion-frames', companionBinary: true, interfaceRefused: false });
    expect(s.detected!.summary).toMatch(/^MECON firmware v1\.18\.0-mecon.*role companion.*interface 1\.0.*capabilities: identity\.read, status\.read, clock\.read/);
    expect(s.detected!.capabilities).toEqual(expect.arrayContaining(['identity.read', 'status.read', 'config.read', 'message.send.direct']));
    expect(s.detected!.commandsSent).toEqual(['frame-iface:hello', 'frame:22']); // hello first, no console step
    expect(s.trust).toBe('unknown');
    // The first bytes the device saw are detection's: 0x7F hello, then the device query. The adapter's own hello (app start, device query, contacts) follows.
    expect(r.mock.writes.map((w) => w[0])).toEqual([0x7f, CMD.DEVICE_QUERY, CMD.APP_START, CMD.DEVICE_QUERY, CMD.GET_CONTACTS]);
    expect(ifaceOps(r.mock)).toEqual(['hello']);
  });

  it('stock Companion: no interface answer, so not MECON; role only from answering Companion frames; messaging driver works', async () => {
    const r = bleRig({});
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    const s = r.session.getSnapshot();
    expect(s.detected).toMatchObject({ transport: 'ble', firmware: 'unknown', firmwareVersion: null, role: 'companion', roleSource: 'companion frames', companionBinary: true, interfaceVersion: null });
    expect(s.detected!.summary).toMatch(/^Not MECON firmware or older/);
    expect(s.companion!.helloComplete).toBe(true);
    expect(r.session.can('status.read')).toBe(false); // gated on capabilities: no interface, no status
    expect(r.session.can('message.send.direct')).toBe(true);
    const a = await r.session.sendDirect(dm('a1'));
    expect(a).toMatchObject({ path: 'ble', deviceAccepted: true, rfTransmitted: false });
    await wait(30);
    expect(r.session.getSnapshot().companion!.attempts[0]!.dmAck).toBe(true);
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(r.backend.post).not.toHaveBeenCalled();
  });

  it('unknown device: nothing answers; unknown role, no capabilities, no driver, nothing sendable', async () => {
    const r = bleRig({ silent: true });
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    const s = r.session.getSnapshot();
    expect(s.detected).toMatchObject({ firmware: 'unknown', role: 'unknown', roleSource: null, companionBinary: false, capabilities: [] });
    expect(s.detected!.summary).toMatch(/^Unknown device/);
    expect(s.companion).toBeNull();
    expect(r.session.can('message.send.direct')).toBe(false);
    await expect(r.session.sendDirect(dm('x'))).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(r.mock.sendWrites()).toHaveLength(0);
  });

  it('the BLE device name never decides anything: role comes from hello, or stays unknown', async () => {
    const a = bleRig({ ...MECON, deviceName: 'Repeater-North', helloRole: 'companion' });
    await a.session.connect();
    expect(a.session.getSnapshot().detected).toMatchObject({ role: 'companion', roleSource: 'hello' });
    const b = bleRig({ ...MECON, deviceName: 'Companion-Alice', helloRole: 'room' });
    await b.session.connect();
    expect(b.session.getSnapshot().detected).toMatchObject({ role: 'room', roleSource: 'hello' });
    const c = bleRig({ silent: true, deviceName: 'MeshCore Repeater' });
    await c.session.connect();
    expect(c.session.getSnapshot().detected).toMatchObject({ role: 'unknown', roleSource: null });
    const d = bleRig({ deviceName: 'Room Server 1' }); // stock Companion with a misleading name
    await d.session.connect();
    expect(d.session.getSnapshot().detected).toMatchObject({ role: 'companion', roleSource: 'companion frames', firmware: 'unknown' });
  });

  it('a hello the device refuses (a link it does not trust) is not an identification, and is reported as refused', async () => {
    const r = bleRig({ ...MECON, helloRefused: true });
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    const d = r.session.getSnapshot().detected!;
    expect(d).toMatchObject({ firmware: 'unknown', interfaceRefused: true, companionBinary: true, role: 'companion', roleSource: 'companion frames', capabilities: expect.not.arrayContaining(['status.read']) });
    expect(d.summary).toMatch(/^Untrusted link \(default PIN or Hardened device\)/);
    expect(d.summary).toMatch(/Pair with the device.s own PIN/);
    expect(d.evidence.join(' ')).toMatch(/refused by the device \(untrusted-transport\)/);
    expect(r.session.can('status.read')).toBe(false);
  });

  it('detection sends the hello: skipping it leaves a MECON Companion unidentified (guards the step order)', async () => {
    const mock = new MockCompanion(MECON);
    const t = new MockTransport(mock);
    await t.requestDevice();
    await t.connect();
    const d = await detectBleDevice(t, { stepTimeoutMs: 100 });
    expect(d.firmware).toBe('mecon');
    expect(d.commandsSent[0]).toBe('frame-iface:hello');
    expect(ifaceOps(mock)).toEqual(['hello']);
    expect(mock.writes[0]![0]).toBe(0x7f);
  });

  it('the link drops during detection: reported, not hung', async () => {
    const mock = new MockCompanion({ ...MECON, silent: true });
    const t = new MockTransport(mock);
    const s = new DeviceSession(t, OPTS);
    sessions.push(s);
    const p = s.connect();
    await wait(40);
    mock.dropLink();
    expect(await p).toEqual({ ok: false, error: 'disconnected' });
    expect(s.getSnapshot()).toMatchObject({ link: 'disconnected', phase: 'closed' });
  });

  it('chooser cancelled and Web Bluetooth missing keep the shared states', async () => {
    const c = bleRig({});
    c.mock.faults.requestDevice = 'cancel';
    expect(await c.session.connect()).toEqual({ ok: false, error: 'chooser_cancelled' });
    expect(c.session.getSnapshot()).toMatchObject({ link: 'idle', phase: 'idle' });
    const mock = new MockCompanion();
    const u = new DeviceSession(new MockTransport(mock, { unsupported: true }), OPTS);
    sessions.push(u);
    expect(u.getSnapshot().link).toBe('unsupported');
    expect(await u.connect()).toEqual({ ok: false, error: 'unsupported' });
  });

  it('reconnect after a loss detects again without a chooser', async () => {
    const r = bleRig(MECON);
    await r.session.connect();
    r.mock.dropLink();
    await wait(10);
    expect(r.session.getSnapshot().link).toBe('disconnected');
    expect(await r.session.reconnect()).toEqual({ ok: true, error: null });
    expect(r.session.getSnapshot().detected).toMatchObject({ firmware: 'mecon', role: 'companion' });
    expect(r.session.getSnapshot().companion!.helloComplete).toBe(true);
    expect(ifaceOps(r.mock)).toEqual(['hello', 'hello']);
  });
});

describe(`${S}: one session surface for USB and BLE`, () => {
  it('the same MECON Companion detected over USB and over BLE gives the same result apart from the link facts', async () => {
    const usb = companionRig();
    sessions.push(usb.session);
    await usb.session.connect();
    const ble = bleRig(MECON);
    await ble.session.connect();
    const u = usb.session.getSnapshot().detected!;
    const b = ble.session.getSnapshot().detected!;
    const link = (d: typeof u) => ({ ...d, transport: 'x', trust: 'x', commandsSent: [], evidence: [], summary: '', deviceInfo: null });
    expect(link(b)).toEqual(link(u));
    expect(u).toMatchObject({ transport: 'usb', trust: 'trusted' });
    expect(b).toMatchObject({ transport: 'ble', trust: 'unknown' });
    for (const cap of ['status.read', 'message.send.direct', 'message.send.channel'] as const) expect(ble.session.can(cap)).toBe(usb.session.can(cap));
    expect(Object.keys(ble.session.getSnapshot()).sort()).toEqual(Object.keys(usb.session.getSnapshot()).sort());
  });
});

describe(`${S}: link trust (read-only on an unknown link)`, () => {
  const refusedCode = async (r: ReturnType<typeof bleRig>, op: string) => r.session.request(op).then(() => 'sent', (e: { code?: string }) => e.code);

  it('a BLE link is trust unknown and says so before and after connecting', async () => {
    const r = bleRig(MECON);
    expect(r.session.getSnapshot().trust).toBe('unknown');
    await r.session.connect();
    expect(r.session.getSnapshot().trust).toBe('unknown');
  });

  it('never requests a non-read operation, even one the device lists as a capability: refused before anything is written', async () => {
    const r = bleRig({ ...MECON, capabilities: ['hello', 'status.get', 'clock.get', 'config.apply', 'device.reboot', 'device.reset', 'message.send', 'identity.rotate', 'update.offer', 'ble.pin.get'] });
    await r.session.connect();
    const before = r.mock.writes.length;
    for (const op of ['config.apply', 'device.reboot', 'device.reset', 'message.send', 'identity.rotate', 'update.offer', 'ble.pin.get', 'channel.put', 'contact.put', 'nonsense.op']) {
      expect(await refusedCode(r, op), op).toBe('link_not_trusted');
    }
    expect(r.mock.writes.length).toBe(before);
    expect(ifaceOps(r.mock)).toEqual(['hello']);
  });

  it('a read operation the device lists is requested and answered', async () => {
    const r = bleRig(MECON);
    await r.session.connect();
    const hello = await r.session.request('hello');
    expect(hello.status).toBe('ok');
    const st = await r.session.request('status.get');
    expect(st).toMatchObject({ status: 'ok', result: { uptime_s: 12 } });
    expect(ifaceOps(r.mock)).toEqual(['hello', 'hello', 'status.get']);
  });

  it('a read the device did not list is gated on capabilities, not sent', async () => {
    const r = bleRig({ ...MECON, capabilities: ['hello'] });
    await r.session.connect();
    expect(await refusedCode(r, 'status.get')).toBe('unsupported_capability');
    expect(ifaceOps(r.mock)).toEqual(['hello']);
  });

  it('a stock Companion has no interface at all: nothing to request', async () => {
    const r = bleRig({});
    await r.session.connect();
    expect(await refusedCode(r, 'status.get')).toBe('unsupported_capability');
    expect(r.mock.ifaceRequests).toHaveLength(0);
  });

  it('an unconnected session writes nothing', async () => {
    const r = bleRig(MECON);
    expect(await refusedCode(r, 'status.get')).toBe('not_connected');
    expect(r.mock.writes).toHaveLength(0);
  });
});
