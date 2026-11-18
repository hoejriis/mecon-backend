import { describe, expect, it } from 'vitest';
import { WebSerialTransport, detectSerialSupport } from './webSerialTransport';
import { installFakeSerial } from './sim/fakeSerial';
import { CompanionSerialPeer, MockRepeater } from './sim/serialPeers';

const S = 'SIMULATED — not hardware verified: WebSerialTransport';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (s: string) => new TextEncoder().encode(s);

function rig(opts: { active?: boolean; peer?: MockRepeater | CompanionSerialPeer } = {}) {
  const nav: Record<string, unknown> = { userActivation: { isActive: opts.active ?? true }, isSecureContext: true };
  const peer = opts.peer ?? new MockRepeater();
  const h = installFakeSerial(nav, peer);
  return { nav, peer, h, t: new WebSerialTransport(nav, { writeTimeoutMs: 80 }) };
}

describe(S, () => {
  it('feature-detects: no navigator.serial, or an insecure context, is unsupported and requestPort refuses', async () => {
    expect(detectSerialSupport({})).toBe('unsupported');
    const { nav } = rig();
    nav.isSecureContext = false;
    expect(detectSerialSupport(nav)).toBe('unsupported');
    const t = new WebSerialTransport({});
    expect(t.support).toBe('unsupported');
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses requestPort without a user gesture before reaching the chooser', async () => {
    const { t, h } = rig({ active: false });
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'gesture_required' });
    expect(h.requestPortCalls()).toBe(0);
  });

  it('maps cancel and denied', async () => {
    const { t, h } = rig();
    h.faults.requestPort = 'cancel';
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'chooser_cancelled' });
    h.faults.requestPort = 'denied';
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('opens the chosen port at 115200, delivers bytes as copies, writes once per call', async () => {
    const { t, h, peer } = rig();
    const got: number[] = [];
    t.onBytes((c) => got.push(...c));
    expect(await t.requestDevice()).toMatchObject({ id: 'serial-port', name: null, usbVendorId: 0x303a });
    await t.connect();
    expect(t.isOpen()).toBe(true);
    await t.writeBytes(text('ver\r'));
    expect(h.hostWrites).toHaveLength(1);
    await wait(10);
    expect(new TextDecoder().decode(Uint8Array.from(got))).toContain('ver');
    expect((peer as MockRepeater).lines).toEqual(['ver']);
  });

  it('a busy port (already open) is port_busy; a failed open is connect_failed', async () => {
    const { t, h } = rig();
    await t.requestDevice();
    h.faults.open = 'busy';
    await expect(t.connect()).rejects.toMatchObject({ code: 'port_busy' });
    h.faults.open = 'fail';
    await expect(t.connect()).rejects.toMatchObject({ code: 'connect_failed' });
    expect(t.isOpen()).toBe(false);
  });

  it('refuses an oversize or empty write and a write while closed', async () => {
    const { t } = rig();
    await expect(t.writeBytes(text('x'))).rejects.toMatchObject({ code: 'not_connected' });
    await t.requestDevice();
    await t.connect();
    await expect(t.writeBytes(new Uint8Array(0))).rejects.toMatchObject({ code: 'frame_too_large' });
    await expect(t.writeBytes(new Uint8Array(5000))).rejects.toMatchObject({ code: 'frame_too_large' });
  });

  it('a write that never settles is bounded by the timeout and reported write_failed', async () => {
    const { t, h } = rig();
    await t.requestDevice();
    await t.connect();
    h.faults.hangNextWrite = true;
    await expect(t.writeBytes(text('ver\r'))).rejects.toMatchObject({ code: 'write_failed' });
  });

  it('unplug: the disconnect event ends the link with reason port_lost, exactly once', async () => {
    const { t, h } = rig();
    const reasons: Array<string | undefined> = [];
    t.onDisconnect((r) => reasons.push(r));
    await t.requestDevice();
    await t.connect();
    h.unplug();
    await wait(20);
    expect(reasons).toEqual(['port_lost']);
    expect(t.isOpen()).toBe(false);
    await expect(t.writeBytes(text('ver\r'))).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('revoked permission looks like the same disconnect event', async () => {
    const { t, h } = rig();
    const reasons: Array<string | undefined> = [];
    t.onDisconnect((r) => reasons.push(r));
    await t.requestDevice();
    await t.connect();
    h.revoke();
    await wait(20);
    expect(reasons).toEqual(['port_lost']);
  });

  it('never reopens by itself: after an unplug and a replug (browser connect event) open is not called again', async () => {
    const { t, h } = rig();
    await t.requestDevice();
    await t.connect();
    expect(h.openCalls()).toBe(1);
    h.unplug();
    await wait(20);
    h.replug();
    await wait(50);
    expect(h.openCalls()).toBe(1);
    expect(t.isOpen()).toBe(false);
    // an explicit connect() reopens the same chosen port only
    await t.connect();
    expect(h.openCalls()).toBe(2);
    expect(h.requestPortCalls()).toBe(1);
  });

  it('a user close reports reason closed and releases the port', async () => {
    const { t, h } = rig();
    const reasons: Array<string | undefined> = [];
    t.onDisconnect((r) => reasons.push(r));
    await t.requestDevice();
    await t.connect();
    await t.disconnect();
    await wait(20);
    expect(reasons).toEqual(['closed']);
    expect(h.closeCalls()).toBe(1);
  });

  it('a recoverable read error (buffer overrun) keeps the link and keeps delivering', async () => {
    const { t, h, peer } = rig();
    const got: number[] = [];
    t.onBytes((c) => got.push(...c));
    await t.requestDevice();
    await t.connect();
    h.faults.recoverableReadErrorNext = true;
    await t.writeBytes(text('ver\r'));
    await wait(30);
    await t.writeBytes(text('board\r'));
    await wait(30);
    expect(t.isOpen()).toBe(true);
    expect(t.recoveredReadErrors).toBe(1);
    expect(new TextDecoder().decode(Uint8Array.from(got))).toContain('Synthetic Board');
    expect((peer as MockRepeater).lines).toEqual(['ver', 'board']);
  });

  it('asserts DTR and RTS together, both true, in one call right after open (boards auto-reset on unequal lines)', async () => {
    const { t, h } = rig();
    await t.requestDevice();
    await t.connect();
    expect(h.signalCalls()).toEqual([{ dataTerminalReady: true, requestToSend: true }]);
  });
});

