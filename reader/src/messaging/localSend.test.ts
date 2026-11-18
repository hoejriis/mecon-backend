import { afterEach, describe, expect, it } from 'vitest';
import type { Identity, Target } from '../api/types';
import { SYNTHETIC_KEYS } from '../ble/fixtures/frames';
import { companionRig, wait } from '../device/rig.test-util';
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
const sessions: DeviceSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  registerGate(null);
});

async function ready() {
  const r = companionRig();
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
  localTarget: target.kind === 'contact' ? { contactKey: SYNTHETIC_KEYS.alice } : { channelIndex: 0 },
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
    await runLocalSend(r.session, t.get(), IDENT, t.patch);
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

  it('a channel send: accepted, no ACK is ever claimed', async () => {
    const r = await ready();
    const t = track(attempt('c1', CH));
    await runLocalSend(r.session, t.get(), IDENT, t.patch);
    const v = describeAttempt(t.get(), 'channel');
    expect(v.label).toBe('Accepted by the device');
    expect(v.facts).not.toContain('Recipient ACK');
    expect(v.terminal).toBe(true);
  });

  it('a lost reply is unknown: one write, no resend while time passes, nothing to the Backend, and "Send again" is offered', async () => {
    const r = await ready();
    r.mock.faults.dropNextSendReply = true;
    const t = track(attempt('u1'));
    await runLocalSend(r.session, t.get(), IDENT, t.patch);
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
    await runLocalSend(r.session, t.get(), IDENT, t.patch);
    expect(t.get().phase).toBe('ambiguous');
    expect(r.mock.rf).toHaveLength(1);
    await wait(200);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('a device that refuses is a definite "not sent", with its reason; nothing is retried', async () => {
    const r = await ready();
    const t = track(attempt('e1', DM, { localTarget: { contactKey: 'ee'.repeat(32) } })); // not a known contact: the device answers NOT_FOUND
    await runLocalSend(r.session, t.get(), IDENT, t.patch);
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
    await runLocalSend(r.session, t.get(), IDENT, t.patch);
    expect(t.get().phase).toBe('rejected');
    expect(r.mock.sendWrites()).toHaveLength(0);
    expect(describeAttempt(t.get(), 'contact')).toMatchObject({ label: 'Not sent', canSendAgain: true, terminal: true });
  });

  it('the same attempt id cannot be written twice; a new attempt for the same draft is a new, separate write', async () => {
    const r = await ready();
    const first = track(attempt('same'));
    await runLocalSend(r.session, first.get(), IDENT, first.patch);
    const dup = track(attempt('same'));
    await runLocalSend(r.session, dup.get(), IDENT, dup.patch);
    expect(dup.get().phase).toBe('rejected');
    expect(dup.get().error?.code).toBe('attempt_reused');
    expect(r.mock.sendWrites()).toHaveLength(1);
    const again = track(attempt('new_id'));
    await runLocalSend(r.session, again.get(), IDENT, again.patch);
    expect(again.get().draftId).toBe('draft_1');
    expect(r.mock.sendWrites()).toHaveLength(2);
  });
});

describe(`${S}: the preflight tells the truth and writes nothing`, () => {
  const to = { contactKey: SYNTHETIC_KEYS.alice };

  it('online: allowed with no lease at all', async () => {
    const r = await ready();
    registerGate(new OfflineGate(true));
    expect(preflightLocal(r.session, IDENT, DM, to).ok).toBe(true);
  });

  const reasons: Array<[string, Parameters<typeof leaseSource>, RegExp, Target?]> = [
    ['no lease', ['missing'], /No offline lease/],
    ['expired', ['expired', expiredPayload()], /expired/],
    ['identity not on the lease', ['valid', leaseFor({ identities: [{ identity_id: 'x', operations: ['send.direct'] }] })], /identity is not on your offline lease/],
    ['operation not permitted', ['valid', leaseFor({ identities: [{ identity_id: 'ident_t', operations: ['receive'] }] })], /does not allow send\.direct/],
    ['device not assigned', ['valid', leaseFor({ devices: ['other'] })], /device is not assigned/],
    ['channel not on the lease', ['valid', leaseFor({ channels: ['other'] })], /channel is not on your offline lease/, CH],
  ];
  for (const [name, args, re, target] of reasons) {
    it(`offline, ${name}: refused with the reason, zero device writes, draft untouched`, async () => {
      const r = await ready();
      const g = new OfflineGate(false);
      g.setLeases(leaseSource(...args));
      registerGate(g);
      const t = target ?? DM;
      const p = preflightLocal(r.session, IDENT, t, t.kind === 'contact' ? to : { channelIndex: 0 });
      expect(p.ok).toBe(false);
      expect(!p.ok && re.test(p.reason)).toBe(true);
      // And the send call itself, bypassing the preflight, is refused the same way with zero writes.
      const a = track(attempt('blocked', t, { localTarget: t.kind === 'contact' ? to : { channelIndex: 0 } }));
      const before = r.mock.writes.length;
      await runLocalSend(r.session, a.get(), IDENT, a.patch);
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
    const p = preflightLocal(r.session, IDENT, DM, to);
    expect(!p.ok && /locked/i.test(p.reason)).toBe(true);
  });

  it('no device, a disconnected device, the wrong identity, a device without the capability and a missing destination are each refused first', async () => {
    const r = await ready();
    registerGate(new OfflineGate(true));
    expect(preflightLocal(null, IDENT, DM, to)).toMatchObject({ ok: false, reason: 'No device is connected.' });
    expect(preflightLocal(r.session, { ...IDENT, public_key_prefix: 'fefefe' }, DM, to)).toMatchObject({ ok: false, reason: expect.stringContaining('not the one this identity belongs to') });
    expect(preflightLocal(r.session, IDENT, DM, {})).toMatchObject({ ok: false, reason: 'Choose which device contact to send to.' });
    expect(preflightLocal(r.session, IDENT, CH, {})).toMatchObject({ ok: false, reason: 'Choose the channel slot on the device.' });
    r.h.unplug();
    await wait(30);
    expect(preflightLocal(r.session, IDENT, DM, to)).toMatchObject({ ok: false, reason: 'The device is not connected.' });
  });
});
