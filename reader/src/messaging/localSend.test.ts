import { afterEach, describe, expect, it } from 'vitest';
import type { Identity, Target } from '../api/types';
import { companionRig, wait } from '../device/rig.test-util';
import type { BackendDest } from '../device/destinations';
import type { DeviceSession } from '../device/session';
import { OfflineGate, registerGate } from '../offline/gate';
import { expiredPayload, leaseSource } from '../offline/leaseSource.test-util';
import { leasePayload } from '../offline/testkit';
import { describeAttempt, isUncertainAttempt, type LocalAttempt } from './attemptStatus';
import { preflightLocal, runLocalSend } from './localSend';

const S = 'SIMULATED — not hardware verified: local send flow';
const IDENT: Identity = { id: 'ident_t', display_name: 'Mine', public_key_prefix: '111111', device_id: 'dev_t', can_send: true };
const DM: Target = { kind: 'contact', id: 'c_alice' };
const CH: Target = { kind: 'channel', id: 'chan_t' };
/** The Backend side of each send: Alice's key prefix, and the own, uniquely named channel `Crew` (the device's slot 1). */
const DM_DEST: BackendDest = { kind: 'contact', targetId: DM.id, prefix: 'a1a1a1' };
const CH_DEST: BackendDest = { kind: 'channel', targetId: CH.id, name: 'Crew', ownLinked: true, sameNameCount: 1, hash: null };
const destOf = (t: Target): BackendDest => (t.kind === 'contact' ? DM_DEST : CH_DEST);
const sessions: DeviceSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  registerGate(null);
});

async function ready() {
  const r = companionRig({ mock: { channels: true } });
  sessions.push(r.session);
  await r.session.connect();
  return r;
}
const attempt = (id: string, target: Target = DM, over: Partial<LocalAttempt> = {}): LocalAttempt => ({
  clientAttemptId: id,
  draftId: 'draft_1',
  request: { client_draft_id: 'draft_1', client_attempt_id: id, identity_id: IDENT.id, target, content: { kind: 'text', text: 'hello' } },
  phase: 'posting',
  attempt: null,
  error: null,
  supersededBy: null,
  createdAt: 1,
  path: 'usb',
  localTarget: {},
  local: null,
  ...over,
});
function track(a: LocalAttempt) {
  let cur = a;
  return { get: () => cur, patch: (p: Partial<LocalAttempt>) => (cur = { ...cur, ...p }) };
}
const leaseFor = (over: Parameters<typeof leasePayload>[0] = {}) =>
  leasePayload({ identities: [{ identity_id: 'ident_t', operations: ['receive', 'send.direct', 'send.channel'] }], devices: ['dev_t'], channels: ['chan_t'], ...over });

describe(`${S}: facts, and never a resend or a reroute`, () => {
  it('a DM: accepted, then the recipient ACK; the path is usb; radio transmission stays not observed', async () => {
    const r = await ready();
    const t = track(attempt('a1'));
    await runLocalSend(r.session, t.get(), IDENT, destOf(t.get().request.target), t.patch);
    await wait(40);
    const a = t.get();
    expect(a.path).toBe('usb');
    expect(a.phase).toBe('local');
    expect(a.local).toMatchObject({ deviceAccepted: true, dmAck: true, rfTransmitted: false, unknown: false });
    const v = describeAttempt(a, 'contact');
    expect(v.label).toBe('Acknowledged by the recipient device');
    expect(v.facts).toBe('Device accepted: yes · Radio transmitted: not observed · Recipient ACK: yes');
    expect(v.terminal).toBe(true);
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(r.backend.post).not.toHaveBeenCalled();
  });

  it('a channel attempt to a uniquely matched channel is written once, to the slot the device listed (never one from the record)', async () => {
    const r = await ready();
    const t = track(attempt('c1', CH, { localTarget: { channelIndex: 7 } as never })); // a stale slot in an old record is ignored
    await runLocalSend(r.session, t.get(), IDENT, CH_DEST, t.patch);
    expect(t.get().phase).toBe('local');
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(r.mock.rf).toEqual([expect.objectContaining({ kind: 'channel', target: '1' })]); // Crew is slot 1 on the device
  });

  it('a channel that does not match exactly one device channel is refused before any write', async () => {
    const r = await ready();
    for (const dest of [
      { ...CH_DEST, name: 'Nowhere' },
      { ...CH_DEST, ownLinked: false },
      { ...CH_DEST, sameNameCount: 2 },
    ]) {
      const t = track(attempt(`x${dest.name}${dest.ownLinked}${dest.sameNameCount}`, CH));
      await runLocalSend(r.session, t.get(), IDENT, dest, t.patch);
      expect(t.get().phase).toBe('rejected');
      expect(t.get().error?.code).toBe('unmapped_destination');
    }
    expect(r.mock.sendWrites()).toHaveLength(0);
  });

  it('a lost reply is unknown: one write, no resend while time passes, nothing to the Backend, and "Send again" is offered', async () => {
    const r = await ready();
    r.mock.faults.dropNextSendReply = true;
    const t = track(attempt('u1'));
    await runLocalSend(r.session, t.get(), IDENT, destOf(t.get().request.target), t.patch);
    const a = t.get();
    expect(a.phase).toBe('ambiguous');
    expect(a.local).toMatchObject({ unknown: true, deviceAccepted: false });
    expect(r.mock.sendWrites()).toHaveLength(1);
    await wait(400); // longer than every timer in this rig
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(r.backend.post).not.toHaveBeenCalled();
    const v = describeAttempt(a, 'contact');
    expect(v).toMatchObject({ label: 'Outcome unknown — not resent', canSendAgain: true, canRecheck: false, mayHaveTransmitted: true });
    expect(isUncertainAttempt(a)).toBe(true);
  });

  it('a link that drops after the device processed it is unknown too, and the device really did transmit once', async () => {
    const r = await ready();
    r.mock.faults.disconnectOnSend = 'after_device';
    const t = track(attempt('u2'));
    await runLocalSend(r.session, t.get(), IDENT, destOf(t.get().request.target), t.patch);
    expect(t.get().phase).toBe('ambiguous');
    expect(r.mock.rf).toHaveLength(1);
    await wait(200);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('a device that refuses is a definite "not sent", with its reason; nothing is retried', async () => {
    const r = await ready();
    r.mock.faults.forgetContacts = true; // mapped from the contacts the app read, then the device answers NOT_FOUND
    const t = track(attempt('e1', DM));
    await runLocalSend(r.session, t.get(), IDENT, destOf(t.get().request.target), t.patch);
    expect(t.get().phase).toBe('rejected');
    expect(describeAttempt(t.get(), 'contact').label).toBe('Refused by the device');
    expect(r.mock.rf).toHaveLength(0);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('a link that is down: nothing written, "not sent", and the user may send again', async () => {
    const r = await ready();
    r.h.unplug();
    await wait(30);
    const t = track(attempt('d1'));
    await runLocalSend(r.session, t.get(), IDENT, destOf(t.get().request.target), t.patch);
    expect(t.get().phase).toBe('rejected');
    expect(r.mock.sendWrites()).toHaveLength(0);
    expect(describeAttempt(t.get(), 'contact')).toMatchObject({ label: 'Not sent', canSendAgain: true, terminal: true });
  });

  it('the same attempt id cannot be written twice; a new attempt for the same draft is a new, separate write', async () => {
    const r = await ready();
    const first = track(attempt('same'));
    await runLocalSend(r.session, first.get(), IDENT, destOf(first.get().request.target), first.patch);
    const dup = track(attempt('same'));
    await runLocalSend(r.session, dup.get(), IDENT, destOf(dup.get().request.target), dup.patch);
    expect(dup.get().phase).toBe('rejected');
    expect(dup.get().error?.code).toBe('attempt_reused');
    expect(r.mock.sendWrites()).toHaveLength(1);
    const again = track(attempt('new_id'));
    await runLocalSend(r.session, again.get(), IDENT, destOf(again.get().request.target), again.patch);
    expect(again.get().draftId).toBe('draft_1');
    expect(r.mock.sendWrites()).toHaveLength(2);
  });
});

describe(`${S}: the preflight tells the truth and writes nothing`, () => {
  const to = {};

  it('online: allowed with no lease at all', async () => {
    const r = await ready();
    registerGate(new OfflineGate(true));
    expect(preflightLocal(r.session, IDENT, DM, to, DM_DEST).ok).toBe(true);
  });

  const reasons: Array<[string, Parameters<typeof leaseSource>, RegExp, Target?]> = [
    ['no lease', ['missing'], /No offline lease/],
    ['expired', ['expired', expiredPayload()], /expired/],
    ['identity not on the lease', ['valid', leaseFor({ identities: [{ identity_id: 'x', operations: ['send.direct'] }] })], /identity is not on your offline lease/],
    ['operation not permitted', ['valid', leaseFor({ identities: [{ identity_id: 'ident_t', operations: ['receive'] }] })], /does not allow send\.direct/],
    ['device not assigned', ['valid', leaseFor({ devices: ['other'] })], /device is not assigned/],
  ];
  for (const [name, args, re, target] of reasons) {
    it(`offline, ${name}: refused with the reason, zero device writes, draft untouched`, async () => {
      const r = await ready();
      const g = new OfflineGate(false);
      g.setLeases(leaseSource(...args));
      registerGate(g);
      const t = target ?? DM;
      const p = preflightLocal(r.session, IDENT, t, to, destOf(t));
      expect(p.ok).toBe(false);
      expect(!p.ok && re.test(p.reason)).toBe(true);
      // And the send call itself, bypassing the preflight, is refused the same way with zero writes.
      const a = track(attempt('blocked', t, { localTarget: to }));
      const before = r.mock.writes.length;
      await runLocalSend(r.session, a.get(), IDENT, destOf(a.get().request.target), a.patch);
      expect(a.get().phase).toBe('rejected');
      expect(a.get().error?.code).toBe('offline_blocked');
      expect(re.test(a.get().error?.message ?? '')).toBe(true);
      expect(r.mock.writes.length).toBe(before);
      expect(r.mock.sendWrites()).toHaveLength(0);
    });
  }

  it('locked (no lease source) offline is refused as locked', async () => {
    const r = await ready();
    const g = new OfflineGate(false);
    registerGate(g);
    const p = preflightLocal(r.session, IDENT, DM, to, DM_DEST);
    expect(!p.ok && /locked/i.test(p.reason)).toBe(true);
  });

  it('no device, a disconnected device, the wrong identity, a device without the capability and a missing destination are each refused first', async () => {
    const r = await ready();
    registerGate(new OfflineGate(true));
    expect(preflightLocal(null, IDENT, DM, to, DM_DEST)).toMatchObject({ ok: false, reason: 'No device is connected.' });
    expect(preflightLocal(r.session, { ...IDENT, public_key_prefix: 'fefefe' }, DM, to, DM_DEST)).toMatchObject({ ok: false, reason: expect.stringContaining('not the one this identity belongs to') });
    expect(preflightLocal(r.session, IDENT, DM, {}, { ...DM_DEST, prefix: null })).toMatchObject({ ok: false, reason: expect.stringContaining('not known to the Reader') });
    expect(preflightLocal(r.session, IDENT, CH, {}, { ...CH_DEST, name: 'Nowhere' })).toMatchObject({ ok: false, reason: expect.stringContaining('No channel named') });
    r.h.unplug();
    await wait(30);
    expect(preflightLocal(r.session, IDENT, DM, to, DM_DEST)).toMatchObject({ ok: false, reason: 'The device is not connected.' });
  });
});
