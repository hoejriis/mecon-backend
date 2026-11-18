import { describe, expect, it } from 'vitest';
import { detectDevice } from './detect';
import { companionRig, repeaterRig, silentRig } from './rig.test-util';

const S = 'SIMULATED — not hardware verified: device detection';

async function detect(r: { bytes: { requestDevice(): Promise<unknown>; connect(): Promise<void> } }, ms = 80) {
  await r.bytes.requestDevice();
  await r.bytes.connect();
  return detectDevice(r.bytes as never, { stepTimeoutMs: ms });
}

describe(S, () => {
  it('MECON Repeater: role from hello over the console line; only the interface hello is written', async () => {
    const r = repeaterRig({ role: 'repeater' });
    const d = await detect(r);
    expect(d).toMatchObject({ firmware: 'mecon', role: 'repeater', roleSource: 'hello', carriage: 'console-line', interfaceVersion: '1.0', companionBinary: false, consoleCli: false });
    expect(d.capabilities).toEqual(['identity.read', 'status.read', 'clock.read', 'config.read']);
    expect(d.capabilities).not.toContain('message.send.direct');
    expect(d.summary).toMatch(/^MECON firmware v1\.18\.0-mecon.*role repeater.*interface 1\.0/);
    expect(d.commandsSent).toEqual(['iface:hello']);
    expect(r.peer.executed).toEqual([]);
    expect(r.peer.lines).toHaveLength(1);
  });

  it('MECON Room server is a room, by hello', async () => {
    expect(await detect(repeaterRig({ role: 'room' }))).toMatchObject({ role: 'room', firmware: 'mecon' });
  });

  it('MECON Companion: hello over 0x7F frames, then the binary driver is proven; messaging capabilities appear', async () => {
    const r = companionRig();
    const d = await detect(r, 150);
    expect(d).toMatchObject({ firmware: 'mecon', role: 'companion', roleSource: 'hello', carriage: 'companion-frames', companionBinary: true });
    expect(d.capabilities).toEqual(expect.arrayContaining(['identity.read', 'status.read', 'message.send.direct', 'contacts.read']));
    expect(d.commandsSent).toEqual(['iface:hello', 'frame-iface:hello', 'frame:22']);
  });

  it('stock Companion (no interface): not MECON, role from answering Companion frames, binary driver only', async () => {
    const d = await detect(companionRig({ peer: { mecon: false } }), 150);
    expect(d).toMatchObject({ firmware: 'unknown', role: 'companion', roleSource: 'companion frames', companionBinary: true, interfaceVersion: null });
    expect(d.summary).toMatch(/^Not MECON firmware or older/);
  });

  it('stock Repeater console: CLI fallback ver / get role / board, firmware unknown', async () => {
    const r = repeaterRig({ mecon: false });
    const d = await detect(r);
    expect(d).toMatchObject({ firmware: 'unknown', role: 'repeater', roleSource: 'get role', consoleCli: true, interfaceVersion: null, carriage: null });
    expect(d.commandsSent).toEqual(['iface:hello', 'cli:ver', 'cli:get role', 'cli:board']);
    expect(r.peer.executed).toEqual([]);
  });

  it('a console that reports a MECON build but does not answer the interface is said so', async () => {
    const d = await detect(repeaterRig({ mecon: false, ver: 'v1.18.0-mecon.0.1.3 (Build: 1 Jan 2026)' }));
    expect(d.firmware).toBe('mecon');
    expect(d.summary).toMatch(/device interface did not answer/);
  });

  it('stock Sensor is a sensor only by its get role answer (a Sensor never answers hello)', async () => {
    expect(await detect(repeaterRig({ mecon: false, role: 'sensor' }))).toMatchObject({ role: 'sensor', firmware: 'unknown' });
  });

  it('role is never inferred from the board name: an unrecognised get role stays unknown', async () => {
    const d = await detect(repeaterRig({ mecon: false, boardName: 'Acme Repeater Board', roleReply: null }));
    expect(d.role).toBe('unknown');
    expect(d.hardware).toBe('Acme Repeater Board'); // reported, not used
    expect(d.roleSource).toBeNull();
  });

  it('the hello role wins over a misleading board name', async () => {
    const d = await detect(repeaterRig({ role: 'room', boardName: 'Companion Pro Repeater' }));
    expect(d.role).toBe('room');
  });

  it('an unknown role string in hello is reported unknown, not mapped', async () => {
    const d = await detect(repeaterRig({ helloRole: 'gateway' }));
    expect(d).toMatchObject({ firmware: 'mecon', role: 'unknown' });
  });

  it('a silent device (with boot noise) is reported unknown and every write was read-only', async () => {
    const r = silentRig('boot: v1 Repeater ready\r\n');
    const d = await detect(r, 40);
    expect(d).toMatchObject({ firmware: 'unknown', role: 'unknown', companionBinary: false, consoleCli: false, capabilities: [] });
    expect(d.summary).toMatch(/^Unknown device/);
    expect(d.commandsSent).toEqual(['iface:hello', 'frame-iface:hello', 'frame:22']);
  });

  it('survives split chunks, coalesced frames and garbage on the line', async () => {
    const r = companionRig();
    r.peer.faults = { splitBytes: 1, coalesce: false, garbageBeforeFrame: [0, 0xff, 0x41], oversizeLengthNoise: true };
    expect(await detect(r, 300)).toMatchObject({ role: 'companion', companionBinary: true, firmware: 'mecon' });
    const r2 = companionRig();
    r2.peer.faults = { splitBytes: null, coalesce: true, garbageBeforeFrame: [], oversizeLengthNoise: false };
    expect(await detect(r2, 300)).toMatchObject({ role: 'companion', companionBinary: true });
  });

  it('a link lost during detection is reported, not hidden', async () => {
    const r = silentRig();
    await r.bytes.requestDevice();
    await r.bytes.connect();
    const p = detectDevice(r.bytes, { stepTimeoutMs: 400 });
    setTimeout(() => r.h.unplug(), 30);
    const d = await p;
    expect(d.linkLost).toBe(true);
    expect(d.evidence.join(' ')).toMatch(/link was lost/);
  });

  it('a hello the device refuses is not a MECON identification', async () => {
    const r = repeaterRig({ mecon: true, ver: 'v1.18.0 (Build: 1 Jan 2026)' });
    const orig = r.peer.receiveBytes.bind(r.peer);
    r.peer.receiveBytes = (b) => {
      const s = new TextDecoder().decode(b);
      if (s.startsWith('mecon> ')) {
        const id = /"id":"([^"]+)"/.exec(s)![1];
        const out = `mecon> {"v":1,"id":"${id}","status":"refused","error":"untrusted-transport"}\r\n`;
        (r.peer as unknown as { emitBytes(b: Uint8Array): void }).emitBytes(new TextEncoder().encode(out));
        return;
      }
      orig(b);
    };
    const d = await detect(r);
    expect(d.firmware).toBe('unknown');
    expect(d.evidence.join(' ')).toMatch(/refused/);
  });
});
