import { describe, expect, it } from 'vitest';
import { MockCompanion } from '../../ble/mockCompanion';
import { guardBytes } from '../guard';
import { companionRig, repeaterRig, serialRig, silentRig } from '../rig.test-util';
import { CompanionSerialPeer, MockRepeater } from '../sim/serialPeers';
import { collectUsbEnvironment, runUsbProbe, sanitizeUsbReport } from './usbProbeCore';

const S = 'SIMULATED — not hardware verified: USB probe';
const run = (r: { bytes: Parameters<typeof runUsbProbe>[0]['transport']; nav: unknown }, ms = 80) =>
  runUsbProbe({ transport: r.bytes, env: collectUsbEnvironment(r.nav), stepTimeoutMs: ms, consoleWindowMs: ms, disconnectWaitMs: 200, now: () => 0 });
const status = (raw: { steps: Array<{ id: string; status: string }> }, id: string) => raw.steps.find((s) => s.id === id)!.status;
const SENSITIVE = ['ab'.repeat(16), 'cd'.repeat(32), 'Synthetic Node', '1111111111111111', 'serial-port'];

describe(S, () => {
  it('Repeater: probe passes, sends only the interface hello, executes nothing, report is sanitized', async () => {
    const r = repeaterRig({ role: 'repeater' });
    const raw = await run(r);
    for (const id of ['environment', 'chooser', 'open', 'identify', 'disconnect']) expect(status(raw, id), id).toBe('pass');
    const rep = sanitizeUsbReport(raw, { now: () => new Date(0), commit: 'abc' });
    expect(rep.readOnly).toBe(true);
    expect(rep.commandsSent).toEqual(['iface:hello']);
    expect(rep.detected).toMatchObject({ firmware: 'mecon', role: 'repeater', carriage: 'console-line', deviceIdPresent: true, nodeKeyPresent: true });
    expect(rep.usb).toEqual({ vendorId: '303a', productId: '1001' });
    const text = JSON.stringify(rep);
    for (const bad of SENSITIVE) expect(text, bad).not.toContain(bad);
    expect(r.peer.executed).toEqual([]);
    expect(r.peer.lines).toHaveLength(1);
  });

  it('Companion: only hello (console), hello (frames) and the device query are written', async () => {
    const r = companionRig();
    const rep = sanitizeUsbReport(await run(r, 150));
    expect(rep.commandsSent).toEqual(['iface:hello', 'frame-iface:hello', 'frame:22']);
    expect(rep.detected).toMatchObject({ role: 'companion', companionBinary: true });
    expect(r.mock.sendWrites()).toHaveLength(0);
    expect(r.mock.rf).toHaveLength(0);
    expect(r.mock.writes.map((w) => w[0])).toEqual([22]); // the only native command the device saw
  });

  it('stock Repeater console: CLI fallback lines only, all read-only', async () => {
    const r = repeaterRig({ mecon: false });
    const rep = sanitizeUsbReport(await run(r));
    expect(rep.commandsSent).toEqual(['iface:hello', 'cli:ver', 'cli:get role', 'cli:board']);
    expect(rep.detected).toMatchObject({ firmware: 'unknown', role: 'repeater', consoleCli: true });
    expect(r.peer.executed).toEqual([]);
  });

  it('unknown device: identify is unknown, never a guess', async () => {
    const raw = await run(silentRig('garbage\r\n'), 40);
    expect(status(raw, 'identify')).toBe('unknown');
    const rep = sanitizeUsbReport(raw);
    expect(rep.detected).toMatchObject({ role: 'unknown', firmware: 'unknown', capabilities: [] });
  });

  it('chooser cancelled: fail with later steps unknown, nothing opened or written', async () => {
    const r = repeaterRig();
    r.h.faults.requestPort = 'cancel';
    const raw = await run(r);
    expect(status(raw, 'chooser')).toBe('fail');
    expect(status(raw, 'open')).toBe('unknown');
    expect(r.h.openCalls()).toBe(0);
    expect(r.peer.lines).toEqual([]);
  });

  it('busy port: open fails with a hint, nothing written', async () => {
    const r = repeaterRig();
    r.h.faults.open = 'busy';
    const raw = await run(r);
    expect(status(raw, 'open')).toBe('fail');
    expect(raw.steps.find((s) => s.id === 'open')!.error?.code).toBe('port_busy');
    expect(r.peer.lines).toEqual([]);
  });

  it('browser without Web Serial: unsupported, nothing crashes', async () => {
    const { WebSerialTransport } = await import('../webSerialTransport');
    const nav = {};
    const raw = await runUsbProbe({ transport: new WebSerialTransport(nav), env: collectUsbEnvironment(nav), now: () => 0 });
    expect(status(raw, 'environment')).toBe('unsupported');
    expect(status(raw, 'chooser')).toBe('unsupported');
  });

  it('unplug during identification is reported as a failed identify', async () => {
    const r = silentRig();
    setTimeout(() => r.h.unplug(), 30);
    const raw = await run(r, 300);
    expect(status(raw, 'identify')).toBe('fail');
  });
});

describe(`${S}: the guard is on the write path`, () => {
  it('a guarded transport refuses every non-allowlisted write before the port, for each role protocol', async () => {
    const peers = [new MockRepeater({ mecon: false }), new CompanionSerialPeer(new MockCompanion(), { mecon: true })];
    for (const peer of peers) {
      const r = serialRig(peer);
      await r.bytes.requestDevice();
      await r.bytes.connect();
      const g = guardBytes(r.bytes, []);
      const bad = [
        new TextEncoder().encode('reboot\r'),
        new TextEncoder().encode('advert\r'),
        new TextEncoder().encode('set name x\r'),
        new TextEncoder().encode('erase\r'),
        new TextEncoder().encode('mecon> {"v":1,"id":"a","op":"device.reboot"}\r'),
        new TextEncoder().encode('mecon> {"v":1,"id":"a","op":"config.apply","args":{}}\r'),
        Uint8Array.of(0x3c, 2, 0, 2, 0), // CMD_SEND_TXT_MSG frame
      ];
      for (const b of bad) await expect(g.writeBytes(b)).rejects.toMatchObject({ code: 'bad_argument' });
      expect(r.h.hostWrites).toHaveLength(0);
    }
  });
});
