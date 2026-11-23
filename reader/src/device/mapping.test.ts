import { afterEach, describe, expect, it } from 'vitest';
import { MockCompanion, MockTransport, type MockCompanionOptions } from '../ble/mockCompanion';
import type { BackendDest, DestinationToken } from './destinations';
import { TARGET_ID, authFor, companionRig, repeaterRig, wait } from './rig.test-util';
import { DeviceSession } from './session';
import { COLLISION_CONTACTS, DEFAULT_CHANNELS, DUPLICATE_HASH_CHANNELS, DUPLICATE_NAME_CHANNELS } from './sim/lists';

const S = 'SIMULATED — not hardware verified: Backend target to device destination at the session';
const sessions: DeviceSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

const contactDest = (prefix: string | null): BackendDest => ({ kind: 'contact', targetId: TARGET_ID, prefix });
const channelDest = (name: string | null, over: Partial<Extract<BackendDest, { kind: 'channel' }>> = {}): BackendDest => ({ kind: 'channel', targetId: TARGET_ID, name, ownLinked: true, sameNameCount: 1, hash: null, ...over });

async function usb(mock: MockCompanionOptions = {}, peer: { mecon?: boolean } = { mecon: true }) {
  const r = companionRig({ mock: { mecon: true, ...mock }, peer });
  sessions.push(r.session);
  expect(await r.session.connect()).toEqual({ ok: true, error: null });
  return r;
}
function bleRig(mockOpts: MockCompanionOptions) {
  const mock = new MockCompanion(mockOpts);
  const session = new DeviceSession(new MockTransport(mock), { detect: { stepTimeoutMs: 200 }, companion: { responseTimeoutMs: 200, connectTimeoutMs: 200, nowSec: () => 1700000000 } });
  sessions.push(session);
  return { mock, session };
}
type SendInput = Parameters<DeviceSession['sendDirect']>[0];
/** Inputs as an API caller could build them, including ones the types forbid. */
const direct = (id: string, extra: object = {}) => ({ clientDraftId: 'd', clientAttemptId: id, text: 'hi', auth: authFor(), ...extra }) as unknown as SendInput;
const channel = (id: string, extra: object = {}) => ({ clientDraftId: 'd', clientAttemptId: id, text: 'hi', auth: authFor('send.channel'), ...extra }) as unknown as SendInput;
/** The interface requests the simulated device received, wherever the rig records them. */
const asked = (r: { peer?: { ifaceRequests: Array<{ op?: string; args?: unknown }> }; mock: MockCompanion }) => (r.peer ?? r.mock).ifaceRequests;
const tokenOf = (s: DeviceSession, d: BackendDest): DestinationToken => {
  const m = s.mapDestination(d);
  if (!m.ok) throw new Error(m.reason);
  return m.token;
};
/** Nothing at all was written for the send: no send frame, and no frame of any kind since `before`. */
const untouched = (m: MockCompanion, before: number) => {
  expect(m.writes.length).toBe(before);
  expect(m.sendWrites()).toHaveLength(0);
  expect(m.rf).toHaveLength(0);
};

describe(`${S}: the device channel list is read with channel.list`, () => {
  it('a MECON Companion that lists channel.list: the table is read, paged, and ready', async () => {
    const r = await usb({ channels: DUPLICATE_NAME_CHANNELS, channelPageSize: 1 });
    expect(r.session.getSnapshot().deviceChannels).toEqual({ status: 'ready', channels: DUPLICATE_NAME_CHANNELS });
    expect(asked(r).filter((e) => e.op === 'channel.list').map((e) => e.args)).toEqual([undefined, { cursor: 1 }, { cursor: 2 }, { cursor: 3 }]); // read class, nothing but a cursor
    expect(asked(r).map((e) => e.op).filter((o) => o !== 'hello' && o !== 'channel.list')).toEqual([]);
  });

  it('the same over BLE (trust unknown: class read is allowed there)', async () => {
    const r = bleRig({ mecon: true, channels: DEFAULT_CHANNELS });
    expect((await r.session.connect()).ok).toBe(true);
    expect(r.session.getSnapshot().trust).toBe('unknown');
    expect(r.session.getSnapshot().deviceChannels).toEqual({ status: 'ready', channels: DEFAULT_CHANNELS });
  });

  it('the sims answer contact.list too (paged by 6) and a Repeater answers its one management slot but never contact.list', async () => {
    const mock = new MockCompanion({ mecon: true, channels: true, contacts: Array.from({ length: 8 }, (_, i) => ({ key: i.toString(16).padStart(2, '0').repeat(32), name: `C${i}` })) });
    const t = new MockTransport(mock);
    await t.requestDevice();
    await t.connect();
    const { encodeMeconFrames } = await import('./meconIface');
    for (const f of encodeMeconFrames(1, JSON.stringify({ v: 1, id: 'x', op: 'contact.list' }))) await t.write(f);
    await wait(10);
    expect(mock.ifaceRequests.at(-1)).toMatchObject({ op: 'contact.list' });
    const { answerList } = await import('./sim/lists');
    const page = answerList({ id: 'x', op: 'contact.list' }, mock.lists()!);
    expect((page!.result as { contacts: unknown[]; next: number }).contacts).toHaveLength(6);
    expect((page!.result as { next: number }).next).toBe(6);
    expect((answerList({ id: 'x', op: 'contact.list', args: { cursor: 6 } }, mock.lists()!)!.result as { next: unknown }).next).toBeNull();

    const rep = repeaterRig({ capabilities: ['hello', 'status.get'], managementChannel: { slot: 3, name: 'mgmt', hash: 'ab' } });
    sessions.push(rep.session);
    await rep.session.connect();
    expect(rep.session.getSnapshot().detected!.interfaceOps).toContain('channel.list');
    expect(rep.peer.ifaceRequests.map((e) => e.op)).toEqual(['hello']);
    expect(rep.session.can('message.send.channel')).toBe(false); // a Repeater sends no messages: no channel path from it
  });

  it('stock firmware: a Companion that does not speak the interface has no channel list, with the reason, and nothing was requested', async () => {
    const r = await usb({}, { mecon: false });
    const s = r.session.getSnapshot();
    expect(s.deviceChannels).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('stock Companion') });
    const m = r.session.mapDestination(channelDest('Crew'));
    expect(m).toMatchObject({ ok: false, code: 'channel_list_unavailable', reason: expect.stringContaining('stock Companion') });
    expect(asked(r)).toHaveLength(0);
    // and a DM to a contact still maps (native contacts)
    expect(r.session.mapDestination(contactDest('a1a1a1'))).toMatchObject({ ok: true });
  });

  it('MECON firmware that does not list channel.list: unavailable, and channel.list is never requested', async () => {
    const r = await usb({ mecon: true });
    expect(r.session.getSnapshot().deviceChannels).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('does not offer a channel list') });
    expect(asked(r).map((e) => e.op)).toEqual(['hello']);
    expect(r.session.mapDestination(channelDest('Crew'))).toMatchObject({ ok: false, code: 'channel_list_unavailable' });
  });

  it('a link the device does not trust (hello refused): unavailable, with the PIN advice', async () => {
    const r = bleRig({ mecon: true, helloRefused: true, channels: true });
    await r.session.connect();
    expect(r.session.getSnapshot().deviceChannels).toMatchObject({ status: 'unavailable', reason: expect.stringContaining("device's own PIN") });
    expect(r.mock.ifaceRequests.map((e) => e.op)).toEqual(['hello']);
  });

  it('a malformed or non-advancing list is an error, never a half-trusted table', async () => {
    const r = await usb({ channels: [{ slot: 0, name: '', hash: 'zz' }] });
    expect(r.session.getSnapshot().deviceChannels).toMatchObject({ status: 'error' });
    expect(r.session.mapDestination(channelDest('Crew'))).toMatchObject({ ok: false, code: 'channel_list_unavailable' });
    const dup = await usb({ channels: [{ slot: 1, name: 'A', hash: '11' }, { slot: 1, name: 'B', hash: '22' }] });
    expect(dup.session.getSnapshot().deviceChannels).toMatchObject({ status: 'error', reason: expect.stringContaining('twice') });
  });
});

describe(`${S}: contacts`, () => {
  it('unique prefix: the full device key is written; ambiguous prefix: refused with candidates, zero writes; none: refused', async () => {
    const r = await usb({ contacts: COLLISION_CONTACTS, channels: true });
    const ok = r.session.mapDestination(contactDest('b2b2b2'));
    expect(ok).toMatchObject({ ok: true, destination: { contactKey: 'b2'.repeat(32) } });
    await r.session.sendDirect(direct('a1', { mapping: (ok as { token: DestinationToken }).token }));
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(r.mock.rf).toEqual([expect.objectContaining({ kind: 'direct', target: 'b2b2b2b2b2b2' })]);

    const amb = r.session.mapDestination(contactDest('a1a1a1'));
    expect(amb).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(!amb.ok && amb.candidates).toHaveLength(2);
    expect(r.session.mapDestination(contactDest('c3c3c3'))).toMatchObject({ ok: false, code: 'not_on_device' });
    expect(r.mock.sendWrites()).toHaveLength(1);
  });
});

describe(`${S}: the send re-verifies the mapping, so an API caller cannot pass a slot or a key`, () => {
  it('an arbitrary slot or key, with no token or a forged one, is refused and writes nothing', async () => {
    const r = await usb({ channels: true });
    const before = r.mock.writes.length;
    const forged = [undefined, {}, { kind: 'channel', targetId: TARGET_ID, destination: { kind: 'channel', slot: 0, name: 'Public', hash: '11' } }, { kind: 'direct', targetId: TARGET_ID, destination: { kind: 'direct', contactKey: 'ee'.repeat(32), name: 'x', via: 'prefix' } }];
    for (const mapping of forged) {
      await expect(r.session.sendChannel(channel('c', { mapping, channelIndex: 0 }))).rejects.toMatchObject({ code: 'unmapped_destination' });
      await expect(r.session.sendDirect(direct('d', { mapping, contactKey: 'ee'.repeat(32) }))).rejects.toMatchObject({ code: 'unmapped_destination' });
    }
    // Slot and key alone, as the old API took them.
    await expect(r.session.sendChannel(channel('c2', { channelIndex: 2 }) as never)).rejects.toMatchObject({ code: 'unmapped_destination' });
    await expect(r.session.sendDirect(direct('d2', { contactKey: 'a1'.repeat(32) }) as never)).rejects.toMatchObject({ code: 'unmapped_destination' });
    untouched(r.mock, before);
    expect(r.session.getSnapshot().companion!.attempts).toHaveLength(0);
  });

  it('a genuine token cannot be used for another target, another kind of message, or from another session', async () => {
    const r = await usb({ channels: true });
    const other = await usb({ channels: true });
    const tok = tokenOf(r.session, channelDest('Crew'));
    const dm = tokenOf(r.session, contactDest('a1a1a1'));
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('t1', { mapping: tok, auth: authFor('send.channel', { targetId: 'another_channel' }) }))).rejects.toMatchObject({ code: 'unmapped_destination' });
    await expect(r.session.sendChannel(channel('t2', { mapping: dm }))).rejects.toMatchObject({ code: 'unmapped_destination' }); // a contact token on a channel send
    await expect(r.session.sendDirect(direct('t3', { mapping: tok }))).rejects.toMatchObject({ code: 'unmapped_destination' }); // a channel token on a DM
    await expect(other.session.sendChannel(channel('t4', { mapping: tok }))).rejects.toMatchObject({ code: 'unmapped_destination' }); // issued by a different session
    await expect(r.session.sendChannel(channel('t5', { mapping: { ...tok } }))).rejects.toMatchObject({ code: 'unmapped_destination' }); // a copy is not the token
    await expect(r.session.sendChannel(channel('t6', { mapping: tok, auth: authFor('send.channel', { targetId: '' }) }))).rejects.toMatchObject({ code: 'unmapped_destination' });
    untouched(r.mock, before);
  });

  it('a genuine token for the right target: one write, to the slot the device listed', async () => {
    const r = await usb({ channels: DUPLICATE_NAME_CHANNELS });
    const tok = tokenOf(r.session, channelDest('Crew'));
    const before = r.mock.writes.length;
    await r.session.sendChannel(channel('ok', { mapping: tok }));
    expect(r.mock.writes.length).toBe(before + 1);
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(r.mock.rf).toEqual([expect.objectContaining({ kind: 'channel', target: '3' })]);
  });

  it('a mapping that no longer holds when the send is made is refused: the device table changed after it was issued', async () => {
    const r = await usb({ channels: DEFAULT_CHANNELS });
    const tok = tokenOf(r.session, channelDest('Crew'));
    // The device now has a second channel named Crew (the user added one on the device), and the list is read again.
    r.mock.lists()!.channels.push({ slot: 5, name: 'Crew', hash: '77' });
    await r.session.refreshChannels();
    expect(r.session.getSnapshot().deviceChannels).toMatchObject({ status: 'ready' });
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('stale', { mapping: tok }))).rejects.toMatchObject({ code: 'unmapped_destination', message: expect.stringContaining('no longer matches') });
    untouched(r.mock, before);
    expect(r.session.mapDestination(channelDest('Crew'))).toMatchObject({ ok: false, code: 'channel_ambiguous' });
  });

  it('a token of the other kind is refused by the token check itself, in both directions', async () => {
    const r = await usb({ channels: true });
    const ch = tokenOf(r.session, channelDest('Crew'));
    const dm = tokenOf(r.session, contactDest('a1a1a1'));
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('k1', { mapping: dm }))).rejects.toMatchObject({ code: 'unmapped_destination', message: expect.stringContaining('another kind of message') });
    await expect(r.session.sendDirect(direct('k2', { mapping: ch }))).rejects.toMatchObject({ code: 'unmapped_destination', message: expect.stringContaining('another kind of message') });
    untouched(r.mock, before);
  });

  it('a token is refused when its channel is still found uniquely but now sits on another slot', async () => {
    const r = await usb({ channels: DEFAULT_CHANNELS });
    const tok = tokenOf(r.session, channelDest('Crew'));
    const crew = r.mock.lists()!.channels.find((c) => c.name === 'Crew')!;
    const oldSlot = crew.slot;
    crew.slot = 7; // moved on the device; the name is still unique, so the matcher still succeeds
    await r.session.refreshChannels();
    expect(r.session.mapDestination(channelDest('Crew'))).toMatchObject({ ok: true });
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('moved', { mapping: tok }))).rejects.toMatchObject({ code: 'unmapped_destination', message: expect.stringContaining('no longer matches') });
    untouched(r.mock, before);
    expect(oldSlot).not.toBe(7);
  });

  it('a token issued with a hash is re-checked with it: the device channel keeps its name and slot but its hash changes, so the write is refused', async () => {
    const r = await usb({ channels: DEFAULT_CHANNELS });
    const tok = tokenOf(r.session, channelDest('Crew', { hash: '5f' }));
    // The channel on slot 1 is re-keyed on the device: same name, same slot, another hash.
    r.mock.lists()!.channels.find((c) => c.slot === 1)!.hash = '77';
    await r.session.refreshChannels();
    expect(r.session.getSnapshot().deviceChannels).toMatchObject({ status: 'ready' });
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('rekeyed', { mapping: tok }))).rejects.toMatchObject({ code: 'unmapped_destination', message: expect.stringContaining('no longer matches') });
    untouched(r.mock, before);
  });

  it('two device channels on one hash: no token is issued, and none can be minted for a send', async () => {
    const r = await usb({ channels: DUPLICATE_HASH_CHANNELS });
    expect(r.session.mapDestination(channelDest('Crew', { hash: '5f' }))).toMatchObject({ ok: false, code: 'channel_hash_duplicate' });
  });

  it('a second device channel on the token’s hash appears after the token was issued: the write is refused', async () => {
    const r = await usb({ channels: DEFAULT_CHANNELS });
    const tok = tokenOf(r.session, channelDest('Crew', { hash: '5f' }));
    r.mock.lists()!.channels.push({ slot: 5, name: 'Crew copy', hash: '5f' });
    await r.session.refreshChannels();
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('dup', { mapping: tok }))).rejects.toMatchObject({ code: 'unmapped_destination' });
    untouched(r.mock, before);
  });

  it('a token issued with a hash writes once while the device still has that hash', async () => {
    const r = await usb({ channels: DEFAULT_CHANNELS });
    const tok = tokenOf(r.session, channelDest('Crew', { hash: '5f' }));
    await r.session.sendChannel(channel('hashed', { mapping: tok }));
    expect(r.mock.rf).toEqual([expect.objectContaining({ kind: 'channel', target: '1' })]);
  });

  it('the lease guard and the device identity still come first, and a mapping does not bypass them', async () => {
    const r = await usb({ channels: true });
    const tok = tokenOf(r.session, channelDest('Crew'));
    const before = r.mock.writes.length;
    await expect(r.session.sendChannel(channel('w', { mapping: tok, auth: authFor('send.channel', { identityKeyPrefix: 'ffffff' }) }))).rejects.toMatchObject({ code: 'wrong_device' });
    untouched(r.mock, before);
  });

  it('a device that is not ready refuses to map at all', async () => {
    const r = companionRig({ mock: { mecon: true, channels: true } });
    sessions.push(r.session);
    expect(r.session.mapDestination(contactDest('a1a1a1'))).toMatchObject({ ok: false, code: 'not_ready' });
    expect(r.mock.writes).toHaveLength(0);
  });
});
