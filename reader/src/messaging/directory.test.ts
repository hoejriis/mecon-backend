import { describe, expect, it } from 'vitest';
import type { Channel, Conversation } from '../api/types';
import { destFor, EMPTY_DIRECTORY } from './directory';

const S = 'Backend directory to the Backend side of a send';
const conv = (identity: string, channel: string): Conversation => ({ id: 'c1', identity_id: identity, target: { kind: 'channel', id: channel }, title: 't', unread_count: 0, last_activity_at: '2030-01-01T00:00:00Z' });
const dir = (channels: Channel[]) => ({ ...EMPTY_DIRECTORY, channels, conversations: [conv('idn_a', 'ch_1')] });

describe(S, () => {
  it('carries the channel hash the Backend sent', () => {
    const d = destFor(dir([{ id: 'ch_1', name: 'Crew', visibility: 'private', hash: '5f' }]), { kind: 'channel', id: 'ch_1' }, { id: 'idn_a' });
    expect(d).toMatchObject({ kind: 'channel', name: 'Crew', ownLinked: true, sameNameCount: 1, hash: '5f' });
  });

  it('a null or absent hash is null (the name rule applies)', () => {
    for (const ch of [{ id: 'ch_1', name: 'Crew', visibility: 'private' as const }, { id: 'ch_1', name: 'Crew', visibility: 'private' as const, hash: null }]) {
      expect(destFor(dir([ch]), { kind: 'channel', id: 'ch_1' }, { id: 'idn_a' })).toMatchObject({ hash: null });
    }
  });

  it('a malformed hash is kept as sent, so it matches no device channel instead of reading as no hash', () => {
    expect(destFor(dir([{ id: 'ch_1', name: 'Crew', visibility: 'private', hash: 'ZZ' }]), { kind: 'channel', id: 'ch_1' }, { id: 'idn_a' })).toMatchObject({ hash: 'ZZ' });
  });

  it('a channel the Reader does not hold has no hash', () => {
    expect(destFor(EMPTY_DIRECTORY, { kind: 'channel', id: 'ch_9' }, { id: 'idn_a' })).toMatchObject({ name: null, hash: null });
  });
});
