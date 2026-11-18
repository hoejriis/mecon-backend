import type { Envelope } from '../meconIface';

/**
 * SIMULATED `channel.list` and `contact.list` answers (hoejriis/mecon-firmware docs/contract, schema
 * channel.list.result.json and contact.list.result.json, both class read, no secret). Synthetic data
 * only. The default tables are small and unambiguous; the named tables below are the awkward ones the
 * matcher must refuse: duplicate channel names, and contact keys that share a prefix.
 */
export interface SimChannel {
  slot: number;
  name: string;
  hash: string;
}
export interface SimContact {
  key: string;
  name: string;
}
export interface ListTables {
  channels: SimChannel[];
  contacts: SimContact[];
  /** Used slots per channel.list page (the firmware pages by 8). Smaller values exercise paging. */
  channelPageSize?: number;
}

/** The synthetic Companion's contacts today: the two fixture contacts. */
export const DEFAULT_CONTACTS: SimContact[] = [
  { key: 'a1'.repeat(32), name: 'Alice Synthetic' },
  { key: 'b2'.repeat(32), name: 'Bob Synthetic' },
];
/** Prefix collisions: `a1a1a1` and `a1a1a1a1` match Alice and Alice Clone; `a1a1a1a1a1` only Alice; `b2b2b2` only Bob. */
export const COLLISION_CONTACTS: SimContact[] = [
  { key: 'a1'.repeat(32), name: 'Alice Synthetic' },
  { key: `${'a1'.repeat(4)}${'e0'.repeat(28)}`, name: 'Alice Clone' },
  { key: 'b2'.repeat(32), name: 'Bob Synthetic' },
];
export const DEFAULT_CHANNELS: SimChannel[] = [
  { slot: 0, name: 'Public', hash: '11' },
  { slot: 1, name: 'Crew', hash: '5f' },
  { slot: 2, name: 'Ops', hash: 'a3' },
];
/** Two device channels named `Ops`, on different keys (different hashes). */
export const DUPLICATE_NAME_CHANNELS: SimChannel[] = [
  { slot: 0, name: 'Public', hash: '11' },
  { slot: 1, name: 'Ops', hash: '3c' },
  { slot: 2, name: 'Ops', hash: '9e' },
  { slot: 3, name: 'Crew', hash: '5f' },
];

export const defaultTables = (): ListTables => ({ channels: DEFAULT_CHANNELS.map((c) => ({ ...c })), contacts: DEFAULT_CONTACTS.map((c) => ({ ...c })) });

const cursorOf = (env: Envelope): number => {
  const c = (env.args as { cursor?: unknown } | undefined)?.cursor;
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 ? c : 0;
};

/** The reply to channel.list / contact.list, or null for any other op. */
export function answerList(env: Envelope, t: ListTables): Envelope | null {
  const id = env.id;
  if (env.op === 'channel.list') {
    const size = t.channelPageSize ?? 8;
    const used = t.channels.filter((c) => c.slot >= cursorOf(env)).sort((a, b) => a.slot - b.slot);
    const page = used.slice(0, size);
    const rest = used[size];
    return {
      v: 1,
      id,
      status: 'ok',
      result: { capacity: 8, channels: page.map((c) => ({ slot: c.slot, name: c.name, hash: c.hash, key_bits: 128 })), next: rest ? rest.slot : null },
    };
  }
  if (env.op === 'contact.list') {
    const from = cursorOf(env);
    const page = t.contacts.slice(from, from + 6);
    return {
      v: 1,
      id,
      status: 'ok',
      result: {
        capacity: 350,
        count: t.contacts.length,
        contacts: page.map((c) => ({ key: c.key, name: c.name, type: 'chat', fav: false, last_advert: 1700000000, hops: -1 })),
        next: from + 6 < t.contacts.length ? from + 6 : null,
      },
    };
  }
  return null;
}
