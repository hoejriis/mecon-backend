import { describe, expect, it } from 'vitest';
import { matchChannel, matchContact, matchDestination, MIN_PREFIX_HEX, type BackendDest, type DeviceChannelsState, type DeviceContactRef } from './destinations';
import { COLLISION_CONTACTS, DEFAULT_CHANNELS, DUPLICATE_NAME_CHANNELS } from './sim/lists';

const S = 'Backend target to device destination (pure matcher)';
const contacts: DeviceContactRef[] = COLLISION_CONTACTS.map((c) => ({ publicKey: c.key, name: c.name }));
const ready = (channels = DEFAULT_CHANNELS): DeviceChannelsState => ({ status: 'ready', channels });
const ch = (name: string | null, over: Partial<Extract<BackendDest, { kind: 'channel' }>> = {}): Extract<BackendDest, { kind: 'channel' }> => ({ kind: 'channel', targetId: 'chan_1', name, ownLinked: true, sameNameCount: 1, ...over });

describe(`${S}: contacts by public key prefix`, () => {
  it('exactly one device key starts with the prefix: that full key is used', () => {
    const m = matchContact('b2b2b2', contacts);
    expect(m).toEqual({ ok: true, destination: { kind: 'direct', contactKey: 'b2'.repeat(32), name: 'Bob Synthetic', via: 'prefix' } });
    // A longer prefix separates two keys that share a shorter one.
    expect(matchContact('a1a1a1a1a1', contacts)).toMatchObject({ ok: true, destination: { contactKey: 'a1'.repeat(32), name: 'Alice Synthetic' } });
  });

  it('case does not matter, and the same key listed twice is one contact', () => {
    expect(matchContact('B2B2B2', [...contacts, { publicKey: 'B2'.repeat(32), name: 'Bob again' }])).toMatchObject({ ok: true, destination: { contactKey: 'b2'.repeat(32) } });
  });

  it('two device keys start with the prefix: refused as ambiguous, with only those two as candidates', () => {
    const m = matchContact('a1a1a1', contacts);
    expect(m).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(!m.ok && m.candidates.map((c) => c.name)).toEqual(['Alice Synthetic', 'Alice Clone']);
    expect(!m.ok && m.reason).toMatch(/2 contacts on your device match/);
  });

  it('none: refused with the truthful reason', () => {
    expect(matchContact('c3c3c3', contacts)).toMatchObject({ ok: false, code: 'not_on_device', reason: "This contact isn't on your device." });
    expect(matchContact('a1a1a1', [])).toMatchObject({ ok: false, code: 'not_on_device' });
  });

  it('an unknown or too-short prefix is refused, never matched loosely', () => {
    expect(matchContact(null, contacts)).toMatchObject({ ok: false, code: 'no_prefix' });
    expect(matchContact('', contacts)).toMatchObject({ ok: false, code: 'no_prefix' });
    expect(matchContact('a1a1a', contacts)).toMatchObject({ ok: false, code: 'prefix_too_short' });
    expect(MIN_PREFIX_HEX).toBe(6);
    expect(matchContact('zzzzzz', contacts)).toMatchObject({ ok: false, code: 'prefix_too_short' });
    expect(matchContact('b2b2b2', [{ publicKey: 'b2'.repeat(32), name: 'Bob' }])).toMatchObject({ ok: true }); // sanity: a valid one passes
  });

  it('a pick resolves an ambiguity only among the matching candidates; any other key is still refused', () => {
    const alice = 'a1'.repeat(32);
    expect(matchContact('a1a1a1', contacts, alice)).toMatchObject({ ok: true, destination: { contactKey: alice, via: 'picked' } });
    expect(matchContact('a1a1a1', contacts, 'b2'.repeat(32))).toMatchObject({ ok: false, code: 'ambiguous' }); // Bob is on the device but does not match the prefix
    expect(matchContact('a1a1a1', contacts, 'ee'.repeat(32))).toMatchObject({ ok: false, code: 'ambiguous' }); // not on the device at all
    // A pick never overrides a unique match.
    expect(matchContact('b2b2b2', contacts, alice)).toMatchObject({ ok: true, destination: { contactKey: 'b2'.repeat(32), via: 'prefix' } });
  });
});

describe(`${S}: channels`, () => {
  it('own linked channel with exactly one namesake on the device: that slot', () => {
    expect(matchChannel(ch('Crew'), ready())).toEqual({ ok: true, destination: { kind: 'channel', slot: 1, name: 'Crew', hash: '5f' } });
  });

  it('a device with duplicate names is refused for the duplicated name, and still matches a unique one', () => {
    const m = matchChannel(ch('Ops'), ready(DUPLICATE_NAME_CHANNELS));
    expect(m).toMatchObject({ ok: false, code: 'channel_ambiguous' });
    expect(matchChannel(ch('Crew'), ready(DUPLICATE_NAME_CHANNELS))).toMatchObject({ ok: true, destination: { slot: 3 } });
  });

  it('no device channel with the name: refused, and never slot 0', () => {
    const m = matchChannel(ch('Nowhere'), ready());
    expect(m).toMatchObject({ ok: false, code: 'channel_not_on_device' });
    expect(m).not.toHaveProperty('destination');
  });

  it('names are exact: no case folding, no trimming, no prefix match', () => {
    for (const name of ['crew', 'Crew ', 'Cre', 'Crew2']) expect(matchChannel(ch(name), ready())).toMatchObject({ ok: false, code: 'channel_not_on_device' });
  });

  it('a Backend channel that is not the sender’s own linked one is not matched by name', () => {
    expect(matchChannel(ch('Crew', { ownLinked: false }), ready())).toMatchObject({ ok: false, code: 'channel_not_linked' });
  });

  it('two Backend channels with the same name (other fleets): refused even though the device has one', () => {
    expect(matchChannel(ch('Crew', { sameNameCount: 2 }), ready())).toMatchObject({ ok: false, code: 'channel_name_shared' });
    expect(matchChannel(ch('Crew', { sameNameCount: 0 }), ready())).toMatchObject({ ok: false, code: 'channel_name_shared' });
  });

  it('a channel the Reader does not hold is refused', () => {
    expect(matchChannel(ch(null), ready())).toMatchObject({ ok: false, code: 'channel_unknown' });
  });

  it('without a readable device channel list nothing matches, with the device’s reason', () => {
    for (const state of [{ status: 'idle' }, { status: 'unavailable', reason: 'stock Companion.' }, { status: 'error', reason: 'timed out.' }] as DeviceChannelsState[]) {
      const m = matchChannel(ch('Crew'), state);
      expect(m).toMatchObject({ ok: false, code: 'channel_list_unavailable' });
      expect(!m.ok && m.reason).toMatch(/needs the device's channel list/);
    }
    const stock = matchChannel(ch('Crew'), { status: 'unavailable', reason: 'stock Companion.' });
    expect(!stock.ok && stock.reason).toContain('stock Companion.');
  });

  it('matchDestination dispatches by kind', () => {
    expect(matchDestination({ kind: 'contact', targetId: 'c', prefix: 'b2b2b2' }, contacts, ready())).toMatchObject({ ok: true, destination: { kind: 'direct' } });
    expect(matchDestination(ch('Crew'), contacts, ready())).toMatchObject({ ok: true, destination: { kind: 'channel' } });
  });
});
