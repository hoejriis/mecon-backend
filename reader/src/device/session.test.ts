import { afterEach, describe, expect, it } from 'vitest';
import { SYNTHETIC_KEYS } from '../ble/fixtures/frames';
import { authFor, companionRig, repeaterRig, wait } from './rig.test-util';
import type { DeviceSession } from './session';

const S = 'SIMULATED — not hardware verified: USB device session';
const alice = SYNTHETIC_KEYS.alice;
const sessions: DeviceSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

async function ready(o: Parameters<typeof companionRig>[0] = {}) {
  const r = companionRig(o);
  sessions.push(r.session);
  const res = await r.session.connect();
  expect(res).toEqual({ ok: true, error: null });
  return r;
}
const att = (r: { session: DeviceSession }, id: string) => r.session.getSnapshot().companion!.attempts.find((a) => a.clientAttemptId === id)!;
const dm = (id: string, draft = 'd1') => ({ clientDraftId: draft, clientAttemptId: id, contactKey: alice, text: 'hello dm', auth: authFor() });

describe(`${S}: connect, hello, contacts, send`, () => {
  it('connects, identifies a MECON Companion, runs the Companion hello and reads contacts over USB', async () => {
    const r = await ready();
    const s = r.session.getSnapshot();
    expect(s.link).toBe('connected');
    expect(s.phase).toBe('ready');
    expect(s.detected).toMatchObject({ firmware: 'mecon', role: 'companion' });
    expect(s.companion!.transportKind).toBe('usb');
    expect(s.companion!.helloComplete).toBe(true);
    expect(s.companion!.contacts.map((c) => c.name)).toEqual(['Alice Synthetic', 'Bob Synthetic']);
    expect(r.session.can('message.send.direct')).toBe(true);
  });

  it('a DM over USB: attempt records path usb; accepted, then ACK; RF transmit stays not observed', async () => {
    const r = await ready();
    const a = await r.session.sendDirect(dm('a1'));
    expect(a.path).toBe('usb');
    expect(a.deviceAccepted).toBe(true);
    expect(a.rfTransmitted).toBe(false); // accepted is not transmitted
    await wait(30);
    expect(att(r, 'a1').dmAck).toBe(true);
    expect(att(r, 'a1').rfTransmitted).toBe(false);
    expect(r.mock.rf).toHaveLength(1); // the device did transmit; the app has no evidence of it
    expect(r.backend.post).not.toHaveBeenCalled();
  });

  it('a channel message gets accepted and never an ACK', async () => {
    const r = await ready();
    const a = await r.session.sendChannel({ clientDraftId: 'd', clientAttemptId: 'c1', channelIndex: 0, text: 'hi all', auth: authFor('send.channel') });
    expect(a).toMatchObject({ path: 'usb', deviceAccepted: true, dmAck: false, rfTransmitted: false });
  });

  it('receives a message pushed by the device', async () => {
    const r = await ready();
    r.mock.queueDirectFromAlice('hi from alice');
    await wait(60);
    expect(r.session.getSnapshot().companion!.inbox.map((m) => m.message.text)).toEqual(['hi from alice']);
  });

  it('duplicate replies do not double count and do not break the send', async () => {
    const r = await ready();
    r.mock.faults.duplicateNotifications = true;
    const a = await r.session.sendDirect(dm('dup'));
    expect(a.deviceAccepted).toBe(true);
    await wait(30);
    expect(att(r, 'dup').dmAck).toBe(true);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('works with every frame split into single bytes, and with garbage and oversize-length noise between frames', async () => {
    const r = companionRig({ session: { detect: { stepTimeoutMs: 400, consoleWindowMs: 400 }, companion: { responseTimeoutMs: 500, connectTimeoutMs: 500, nowSec: () => 1700000000 } } });
    sessions.push(r.session);
    r.peer.faults = { splitBytes: 1, coalesce: false, garbageBeforeFrame: [0x00, 0x41, 0xff], oversizeLengthNoise: true };
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    const a = await r.session.sendDirect(dm('noisy'));
    expect(a.deviceAccepted).toBe(true);
    await wait(60);
    expect(att(r, 'noisy').dmAck).toBe(true);
  });

  it('works when the device coalesces several frames into one chunk', async () => {
    const r = companionRig();
    sessions.push(r.session);
    r.peer.faults = { splitBytes: null, coalesce: true, garbageBeforeFrame: [], oversizeLengthNoise: false };
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    expect(r.session.getSnapshot().companion!.contacts).toHaveLength(2);
  });
});

describe(`${S}: unplug and send safety`, () => {
  for (const when of ['before_device', 'after_device'] as const) {
    it(`unplug mid-send (${when}): unknown, one write, never resent, state unplugged, not rerouted`, async () => {
      const r = await ready();
      r.mock.faults.disconnectOnSend = when;
      const a = await r.session.sendDirect(dm('u1'));
      expect(a.unknown).toBe(true);
      expect(a.writeIssued).toBe(true);
      expect(a.deviceAccepted).toBe(false);
      expect(r.session.getSnapshot().link).toBe('unplugged');
      expect(r.mock.sendWrites()).toHaveLength(1);
      // The cable goes back in and the user reconnects: the old attempt is still unknown and nothing is resent.
      r.mock.faults.disconnectOnSend = null;
      r.h.replug();
      expect(await r.session.reconnect()).toEqual({ ok: true, error: null });
      await wait(60);
      expect(att(r, 'u1').unknown).toBe(true);
      expect(att(r, 'u1').deviceAccepted).toBe(false);
      expect(r.mock.sendWrites()).toHaveLength(1);
      expect(r.mock.rf).toHaveLength(when === 'after_device' ? 1 : 0);
      expect(r.backend.post).not.toHaveBeenCalled();
      // a new user action is a new attempt and writes once more
      await r.session.sendDirect(dm('u2'));
      expect(r.mock.sendWrites()).toHaveLength(2);
    });
  }

  it('a send reply that never arrives is unknown, written once, link reset', async () => {
    const r = await ready();
    r.mock.faults.dropNextSendReply = true;
    const a = await r.session.sendDirect(dm('lost'));
    expect(a).toMatchObject({ unknown: true, reason: 'response_timeout' });
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('a port write that hangs is unknown after the bounded wait, not an endless await', async () => {
    const r = await ready();
    r.h.faults.hangNextWrite = true;
    const a = await r.session.sendDirect(dm('hang'));
    expect(a.unknown).toBe(true);
    expect(r.mock.sendWrites()).toHaveLength(0); // the bytes never reached the device; the Reader still cannot tell, so it says unknown
  });

  it('sending while unplugged writes nothing and says not sent', async () => {
    const r = await ready();
    r.h.unplug();
    await wait(30);
    expect(r.session.getSnapshot().link).toBe('unplugged');
    await expect(r.session.sendDirect(dm('x'))).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(r.mock.sendWrites()).toHaveLength(0);
  });
});

describe(`${S}: connection states`, () => {
  it('unsupported browser', async () => {
    const r = companionRig();
    const { DeviceSession } = await import('./session');
    const { WebSerialTransport } = await import('./webSerialTransport');
    const s = new DeviceSession(new WebSerialTransport({}));
    expect(s.getSnapshot().link).toBe('unsupported');
    expect(await s.connect()).toEqual({ ok: false, error: 'unsupported' });
    r.session.dispose();
  });

  it('user cancels the chooser: idle, nothing opened; denied is its own state', async () => {
    const r = companionRig();
    sessions.push(r.session);
    r.h.faults.requestPort = 'cancel';
    expect(await r.session.connect()).toEqual({ ok: false, error: 'chooser_cancelled' });
    expect(r.session.getSnapshot().link).toBe('idle');
    r.h.faults.requestPort = 'denied';
    expect(await r.session.connect()).toEqual({ ok: false, error: 'permission_denied' });
    expect(r.session.getSnapshot().link).toBe('denied');
    expect(r.h.openCalls()).toBe(0);
    r.h.faults.requestPort = 'ok';
    expect((await r.session.connect()).ok).toBe(true);
  });

  it('a busy port is the busy state; retry is explicit and works once it is free', async () => {
    const r = companionRig();
    sessions.push(r.session);
    r.h.faults.open = 'busy';
    expect(await r.session.connect()).toEqual({ ok: false, error: 'port_busy' });
    expect(r.session.getSnapshot()).toMatchObject({ link: 'busy', phase: 'failed' });
    expect(r.h.openCalls()).toBe(1); // no automatic retry
    await wait(50);
    expect(r.h.openCalls()).toBe(1);
    r.h.faults.open = 'ok';
    expect((await r.session.reconnect()).ok).toBe(true);
    expect(r.h.requestPortCalls()).toBe(1); // same port, no chooser
  });

  it('unplug after connect: unplugged, no automatic reconnect, even after the cable returns', async () => {
    const r = await ready();
    expect(r.h.openCalls()).toBe(1);
    r.h.unplug();
    await wait(30);
    r.h.replug();
    await wait(80);
    expect(r.session.getSnapshot().link).toBe('unplugged');
    expect(r.h.openCalls()).toBe(1);
  });

  it('a user disconnect is disconnected, not unplugged', async () => {
    const r = await ready();
    await r.session.disconnect();
    await wait(20);
    expect(r.session.getSnapshot().link).toBe('disconnected');
  });

  it('never opens a different port: only the chosen one is ever opened', async () => {
    const r = await ready();
    r.h.unplug();
    await wait(20);
    r.h.replug();
    await r.session.reconnect();
    expect(r.h.requestPortCalls()).toBe(1);
    expect(r.h.openCalls()).toBe(2);
  });
});

describe(`${S}: capabilities, not roles, gate features`, () => {
  it('a MECON Repeater exposes identity and status reads and refuses message sends, writing nothing', async () => {
    const r = repeaterRig({ role: 'repeater' });
    sessions.push(r.session);
    expect((await r.session.connect()).ok).toBe(true);
    const before = r.peer.lines.length;
    expect(r.session.can('identity.read')).toBe(true);
    expect(r.session.can('status.read')).toBe(true);
    expect(r.session.can('message.send.direct')).toBe(false);
    expect(r.session.getSnapshot().companion).toBeNull();
    await expect(r.session.sendDirect(dm('r1'))).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(r.session.sendChannel({ clientDraftId: 'd', clientAttemptId: 'c', channelIndex: 0, text: 'x', auth: authFor('send.channel') })).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(r.peer.lines.length).toBe(before);
    expect(r.peer.executed).toEqual([]);
  });

  it('can() is false for everything once the link is gone', async () => {
    const r = repeaterRig();
    sessions.push(r.session);
    await r.session.connect();
    r.h.unplug();
    await wait(30);
    expect(r.session.can('identity.read')).toBe(false);
  });

  it('an unknown device connects at the transport level but offers nothing', async () => {
    const { silentRig } = await import('./rig.test-util');
    const { DeviceSession } = await import('./session');
    const r = silentRig();
    const s = new DeviceSession(r.bytes, { detect: { stepTimeoutMs: 40, consoleWindowMs: 40 } });
    sessions.push(s);
    expect((await s.connect()).ok).toBe(true);
    expect(s.getSnapshot().detected!.summary).toMatch(/^Unknown device/);
    expect(s.can('identity.read')).toBe(false);
    expect(s.can('message.send.direct')).toBe(false);
  });
});

describe(`${S}: duplicate notifications during hello`, () => {
  it('a duplicated contact frame does not list the contact twice', async () => {
    const r = companionRig();
    sessions.push(r.session);
    r.mock.faults.duplicateNotifications = true;
    expect(await r.session.connect()).toEqual({ ok: true, error: null });
    expect(r.session.getSnapshot().companion!.contacts.map((c) => c.name)).toEqual(['Alice Synthetic', 'Bob Synthetic']);
  });
});
