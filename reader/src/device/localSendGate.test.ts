import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineGate, OfflineSendBlocked, offlineSendGuard, registerGate } from '../offline/gate';
import { expiredPayload, leaseSource } from '../offline/leaseSource.test-util';
import { leasePayload } from '../offline/testkit';
import { authFor, companionRig, mapChannel, mapDirect } from './rig.test-util';
import type { DeviceSession } from './session';

const S = 'SIMULATED — not hardware verified: offline gate on local sends';
const sessions: DeviceSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  registerGate(null);
});

// The gate is offline; the lease source decides. The synthetic device is identity ident_test on dev_test.
const lease = (over: Parameters<typeof leasePayload>[0] = {}) =>
  leasePayload({
    identities: [{ identity_id: 'ident_test', operations: ['receive', 'send.direct', 'send.channel'] }],
    devices: ['dev_test'],
    channels: ['chan_test'],
    ...over,
  });

async function ready() {
  const r = companionRig({ mock: { channels: true } });
  sessions.push(r.session);
  expect(await r.session.connect()).toEqual({ ok: true, error: null });
  return r;
}
const dm = (s: DeviceSession, id: string, auth = authFor()) => ({ clientDraftId: 'd1', clientAttemptId: id, mapping: mapDirect(s), text: 'hello dm', auth });
const ch = (s: DeviceSession, id: string, auth = authFor('send.channel')) => ({ clientDraftId: 'd1', clientAttemptId: id, mapping: mapChannel(s), text: 'hi all', auth });

function offline(source: ReturnType<typeof leaseSource> | null): OfflineGate {
  const g = new OfflineGate(false);
  g.setLeases(source);
  registerGate(g);
  return g;
}

/** Nothing may reach the device and nothing may be recorded as an attempt. */
async function expectRefusedWithoutWriting(r: Awaited<ReturnType<typeof ready>>, call: () => Promise<unknown>, reason: RegExp) {
  const before = r.mock.writes.length;
  await expect(call()).rejects.toSatisfy((e: unknown) => e instanceof OfflineSendBlocked && reason.test(e.decision.reason));
  expect(r.mock.writes.length).toBe(before);
  expect(r.mock.sendWrites()).toHaveLength(0);
  expect(r.mock.rf).toHaveLength(0);
  expect(r.session.getSnapshot().companion!.attempts).toHaveLength(0);
}

describe(`${S}: every gate reason refuses before a single byte is written`, () => {
  const cases: Array<[string, () => ReturnType<typeof offline>, RegExp]> = [
    ['locked', () => offline(null), /locked/i],
    ['no lease', () => offline(leaseSource('missing')), /No offline lease/],
    ['expired lease', () => offline(leaseSource('expired', expiredPayload())), /expired/],
    ['browser cannot verify leases (unsupported)', () => offline(leaseSource('unsupported')), /cannot verify offline leases/],
    ['bad lease signature', () => offline(leaseSource('invalid-signature')), /signature is not valid/],
    ['identity not on the lease', () => offline(leaseSource('valid', lease({ identities: [{ identity_id: 'someone_else', operations: ['send.direct'] }] }))), /identity is not on your offline lease/],
    ['operation not permitted for the identity', () => offline(leaseSource('valid', lease({ identities: [{ identity_id: 'ident_test', operations: ['receive'] }] }))), /does not allow send\.direct/],
    ['device not assigned on the lease', () => offline(leaseSource('valid', lease({ devices: ['another_device'] }))), /device is not assigned/],
  ];
  for (const [name, setup, reason] of cases) {
    it(`a DM while offline is refused: ${name}`, async () => {
      const r = await ready();
      setup();
      await expectRefusedWithoutWriting(r, () => r.session.sendDirect(dm(r.session, 'x')), reason);
    });
  }

  it('a channel send while offline is refused when the channel is not on the lease', async () => {
    const r = await ready();
    offline(leaseSource('valid', lease({ channels: ['some_other_channel'] })));
    await expectRefusedWithoutWriting(r, () => r.session.sendChannel(ch(r.session, 'c1')), /channel is not on your offline lease/);
  });

  it('a channel send must name its channel, or it is refused (an unnamed channel cannot be checked)', async () => {
    const r = await ready();
    offline(leaseSource('valid', lease()));
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(ch(r.session, 'c2', authFor('send.channel', { channelId: undefined })))).rejects.toMatchObject({ code: 'bad_argument' });
    expect(r.mock.writes.length).toBe(before);
  });

  it('the lease operation must match the send (a DM cannot ride on a channel permit)', async () => {
    const r = await ready();
    offline(leaseSource('valid', lease()));
    const before = r.mock.writes.length;
    await expect(r.session.sendDirect(dm(r.session, 'x', authFor('send.channel')))).rejects.toMatchObject({ code: 'bad_argument' });
    expect(r.mock.writes.length).toBe(before);
  });
});

describe(`${S}: a caller that skips the UI is refused the same way`, () => {
  it('calling the session directly, offline with no lease, writes nothing (no UI involved)', async () => {
    const r = await ready();
    offline(leaseSource('missing'));
    await expectRefusedWithoutWriting(r, () => r.session.sendDirect(dm(r.session, 'bypass')), /No offline lease/);
  });

  it('with no gate registered at all, an offline browser is blocked (the default is closed, not open)', async () => {
    const r = await ready();
    registerGate(null);
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      expect(offlineSendGuard(authFor()).allowed).toBe(false);
      await expectRefusedWithoutWriting(r, () => r.session.sendDirect(dm(r.session, 'nogate')), /locked/i);
    } finally {
      spy.mockRestore();
    }
  });
});

describe(`${S}: what is permitted`, () => {
  it('offline with a valid lease that names this operation, identity, device and channel: the DM and the channel send are written once each', async () => {
    const r = await ready();
    offline(leaseSource('valid', lease()));
    const a = await r.session.sendDirect(dm(r.session, 'ok1'));
    expect(a).toMatchObject({ path: 'usb', deviceAccepted: true, writeIssued: true });
    const c = await r.session.sendChannel(ch(r.session, 'okc'));
    expect(c).toMatchObject({ deviceAccepted: true });
    expect(r.mock.sendWrites()).toHaveLength(2);
    expect(r.backend.post).not.toHaveBeenCalled();
  });

  it('online, the lease is not required: a send with no lease at all goes through', async () => {
    const r = await ready();
    const g = new OfflineGate(true);
    g.setLeases(null);
    registerGate(g);
    expect((await r.session.sendDirect(dm(r.session, 'online1'))).deviceAccepted).toBe(true);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('a device that is not the identity’s own is refused, online or offline, with nothing written', async () => {
    const r = await ready();
    registerGate(new OfflineGate(true));
    const before = r.mock.writes.length;
    await expect(r.session.sendDirect(dm(r.session, 'wrong', authFor('send.direct', { identityKeyPrefix: 'ffffff' })))).rejects.toMatchObject({ code: 'wrong_device' });
    await expect(r.session.sendDirect(dm(r.session, 'empty', authFor('send.direct', { identityKeyPrefix: '' })))).rejects.toMatchObject({ code: 'wrong_device' });
    expect(r.mock.writes.length).toBe(before);
    expect(r.session.getSnapshot().companion!.attempts).toHaveLength(0);
  });

  it('a lease that expires between two sends stops the second one (expiry is checked at every call)', async () => {
    const r = await ready();
    const clock = { t: Date.parse('2030-01-03T00:00:00Z') };
    const p = lease();
    const status = leaseSource('valid', p).status;
    const { permits } = await import('../offline/lease');
    const g = new OfflineGate(false);
    g.setLeases({ status, permits: (q) => permits(status, q, { now: clock.t }) });
    registerGate(g);
    await r.session.sendDirect(dm(r.session, 'before'));
    clock.t = Date.parse(p.expires_at) + 1;
    const writesBefore = r.mock.writes.length;
    await expect(r.session.sendDirect(dm(r.session, 'after'))).rejects.toSatisfy((e: unknown) => e instanceof OfflineSendBlocked && /expired/.test(e.decision.reason));
    expect(r.mock.writes.length).toBe(writesBefore);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });
});
