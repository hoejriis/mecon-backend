// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../api/types';
import type { LocalAttempt } from '../messaging/attemptStatus';
import type { KvStore } from '../storage/migrations';
import { OfflineCache, StorageFullError } from './cache';
import { CryptoFailure, openJson } from './crypto';
import { fakePasskey, freshStore } from './testkit';
import { LockedError, setupWithPasskey, type OfflineKeys } from './unlock';

const SENTINEL = 'SYNTHETIC-PRIVATE-TEXT-7d1c';

const conv = (n: number, extra: Partial<Conversation> = {}): Conversation => ({
  id: `conv_${n}`,
  identity_id: 'idn_a',
  target: { kind: 'contact', id: `ct_${n}` },
  title: `Synthetic Peer ${n} ${SENTINEL}`,
  unread_count: 0,
  last_activity_at: `2030-01-01T00:00:${String(n).padStart(2, '0')}Z`,
  ...extra,
});
const msg = (c: string, n: number, text = `hello ${n}`): Message => ({
  message_id: `m_${c}_${n}`,
  conversation_id: c,
  identity_id: 'idn_a',
  direction: 'inbound',
  sender_label: null,
  source_path: 'backend',
  observed_at: `2030-01-01T00:${String(n % 60).padStart(2, '0')}:00Z`,
  content: { kind: 'text', text },
});
const attempt = (id: string, phase: LocalAttempt['phase'] = 'ambiguous'): LocalAttempt => ({
  clientAttemptId: id,
  draftId: `d_${id}`,
  request: {
    client_draft_id: `d_${id}`,
    client_attempt_id: id,
    identity_id: 'idn_a',
    target: { kind: 'contact', id: 'ct_1' },
    content: { kind: 'text', text: `attempt text ${SENTINEL}` },
  },
  phase,
  attempt: null,
  error: null,
  supersededBy: null,
  createdAt: 1,
});

async function setup(userId = 'usr_a', store?: KvStore, opts: ConstructorParameters<typeof Object>[0] = {}) {
  const s = store ?? (await freshStore());
  const keys: OfflineKeys = await setupWithPasskey(s, userId, { webauthn: fakePasskey() });
  let clock = 1000;
  const r = await OfflineCache.open(s, keys, { now: () => clock++, ...(opts as object) });
  if (!r.ok) throw new Error('quarantined');
  return { store: s, keys, cache: r.cache };
}

const dumpAll = async (s: KvStore) => JSON.stringify(await Promise.all((await s.keys('')).map(async (k) => [k, await s.get(k)])));

describe('encrypted cache', () => {
  it('round trips conversations, messages, drafts and attempts', async () => {
    const { cache } = await setup();
    await cache.putConversations([conv(1), conv(2)]);
    await cache.putMessages('conv_1', [msg('conv_1', 1), msg('conv_1', 2)]);
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'draft body', updatedAt: 5 });
    await cache.saveAttempt(attempt('a1'));
    expect((await cache.listConversations()).map((c) => c.conversation.id).sort()).toEqual(['conv_1', 'conv_2']);
    expect((await cache.getMessages('conv_1')).map((m) => m.message_id)).toEqual(['m_conv_1_2', 'm_conv_1_1']);
    expect((await cache.listDrafts())[0]!.text).toBe('draft body');
    expect((await cache.listAttempts())[0]!.clientAttemptId).toBe('a1');
  });

  it('writes no plaintext private data to IndexedDB ', async () => {
    const { cache, store } = await setup();
    await cache.putConversations([conv(1)]);
    await cache.putMessages('conv_1', [msg('conv_1', 1, `body ${SENTINEL}`)]);
    await cache.saveDraft({ draftId: 'draft_syn_9', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: `draft ${SENTINEL}`, updatedAt: 5 });
    await cache.saveAttempt(attempt('a1'));
    await cache.putLease('payload.signature');
    const dump = await dumpAll(store);
    expect(dump).not.toContain(SENTINEL);
    expect(dump).not.toContain('Synthetic Peer');
    expect(dump).not.toContain('conv_1'); // record key names are opaque HMAC slots
    expect(dump).not.toContain('payload.signature');
    expect(dump).not.toContain('draft_syn_9');
  });

  it('a tampered record fails to decrypt and is counted, never silently accepted', async () => {
    const { cache, store } = await setup();
    await cache.putConversations([conv(1)]);
    await cache.putMessages('conv_1', [msg('conv_1', 1)]);
    const k = (await store.keys('')).find((x) => x.includes('/msgs/'))!;
    const rec = (await store.get(k)) as { ct: string };
    await store.put(k, { ...rec, ct: (rec.ct[0] === 'A' ? 'B' : 'A') + rec.ct.slice(1) });
    await expect(cache.getMessages('conv_1')).rejects.toBeInstanceOf(CryptoFailure);
    const ck = (await store.keys('')).find((x) => x.includes('/conv/'))!;
    await store.put(ck, { ...((await store.get(ck)) as object), ct: 'AAAA' });
    expect(await cache.listConversations()).toEqual([]);
    expect(cache.unreadable).toBe(1);
  });

  it("another user's keys cannot read, list or decrypt this user's records", async () => {
    const a = await setup('usr_a');
    await a.cache.putConversations([conv(1)]);
    await a.cache.putMessages('conv_1', [msg('conv_1', 1)]);
    const b = await setup('usr_b', a.store);
    expect(await b.cache.listConversations()).toEqual([]);
    expect(await b.cache.getMessages('conv_1')).toEqual([]);
    // Even a record copied under B's own key name does not open: B's key and B's AAD differ.
    const aKey = (await a.store.keys('')).find((x) => x.includes('/msgs/'))!;
    const bKey = aKey.replace(/\/r\/[^/]+\//, (m) => m); // same slot under another user's prefix cannot be built; copy raw instead
    void bKey;
    const raw = await a.store.get(aKey);
    await expect(openJson(b.keys.cache, 'usr_b', 'cache', `msgs/${aKey.split('/').pop()}`, raw as never)).rejects.toBeInstanceOf(CryptoFailure);
  });

  it('a locked cache refuses every operation', async () => {
    const { cache, keys } = await setup();
    await cache.putConversations([conv(1)]);
    keys.lock();
    expect(cache.locked).toBe(true);
    await expect(cache.listConversations()).rejects.toBeInstanceOf(LockedError);
    await expect(cache.saveDraft({ draftId: 'd', target: { kind: 'contact', id: 'x' }, identityId: null, text: 't', updatedAt: 1 })).rejects.toBeInstanceOf(LockedError);
  });

  it('uses the migration runner: schema marker v1, and a newer schema quarantines without deleting', async () => {
    const { cache, store, keys } = await setup();
    await cache.putConversations([conv(1)]);
    expect(await store.get('meta/schema')).toMatchObject({ version: 1 });
    const marker = (await store.get('meta/schema')) as { generation: number };
    await store.put('meta/schema', { version: 99, generation: marker.generation, previousGeneration: null });
    const r = await OfflineCache.open(store, keys);
    expect(r.ok).toBe(false);
    expect((await store.keys(`g${marker.generation}/r/`)).length).toBeGreaterThan(0);
  });
});

describe('bounds and eviction', () => {
  it('evicts least recently used conversations past the cap, with their messages', async () => {
    const { cache } = await setup('usr_a', undefined, { caps: { maxConversations: 3 } });
    for (let i = 1; i <= 3; i++) {
      await cache.putConversations([conv(i)]);
      await cache.putMessages(`conv_${i}`, [msg(`conv_${i}`, 1)]);
    }
    await cache.getMessages('conv_1'); // reading makes conv_1 the most recently used
    await cache.putConversations([conv(4)]);
    await cache.putMessages('conv_4', [msg('conv_4', 1)]);
    const ids = (await cache.listConversations()).map((c) => c.conversation.id).sort();
    expect(ids).toEqual(['conv_1', 'conv_3', 'conv_4']);
    expect(await cache.getMessages('conv_2')).toEqual([]);
  });

  it('keeps only the newest messages per conversation', async () => {
    const { cache } = await setup('usr_a', undefined, { caps: { maxMessagesPerConversation: 3 } });
    await cache.putConversations([conv(1)]);
    await cache.putMessages('conv_1', [1, 2, 3, 4, 5].map((n) => msg('conv_1', n)));
    expect((await cache.getMessages('conv_1')).map((m) => m.message_id)).toEqual(['m_conv_1_5', 'm_conv_1_4', 'm_conv_1_3']);
  });

  it('drafts and uncertain attempts survive eviction by the cap', async () => {
    const { cache } = await setup('usr_a', undefined, { caps: { maxConversations: 1 } });
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'keep me', updatedAt: 1 });
    await cache.saveAttempt(attempt('a1', 'ambiguous'));
    await cache.saveAttempt(attempt('a2', 'posting'));
    for (let i = 1; i <= 5; i++) await cache.putConversations([conv(i)]);
    expect(await cache.listConversations()).toHaveLength(1);
    expect((await cache.listDrafts()).map((d) => d.text)).toEqual(['keep me']);
    expect((await cache.listAttempts()).map((a) => a.clientAttemptId).sort()).toEqual(['a1', 'a2']);
  });

  it('under storage pressure evicts cached conversations, never drafts or attempts', async () => {
    const { cache } = await setup('usr_a', undefined, { caps: { maxConversations: 50 }, estimate: async () => ({ usage: 90, quota: 100 }) });
    for (let i = 1; i <= 6; i++) {
      await cache.putConversations([conv(i)]);
      await cache.putMessages(`conv_${i}`, [msg(`conv_${i}`, 1)]);
    }
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'keep me', updatedAt: 1 });
    await cache.saveAttempt(attempt('a1'));
    expect(await cache.checkPressure()).toBe(true);
    expect((await cache.listConversations()).length).toBeLessThan(6);
    expect(cache.warnings.has('storage-pressure')).toBe(true);
    expect(await cache.listDrafts()).toHaveLength(1);
    expect(await cache.listAttempts()).toHaveLength(1);
  });

  it('no pressure below the threshold evicts nothing', async () => {
    const { cache } = await setup('usr_a', undefined, { estimate: async () => ({ usage: 10, quota: 100 }) });
    await cache.putConversations([conv(1)]);
    expect(await cache.checkPressure()).toBe(false);
    expect(await cache.listConversations()).toHaveLength(1);
  });

  /** A store that throws QuotaExceededError when it would hold more than `limit` records. */
  const limited = (inner: KvStore, limit: () => number): KvStore => ({
    ...inner,
    async put(k, v) {
      const existing = (await inner.get(k)) !== undefined;
      if (!existing && (await inner.keys('g')).length >= limit()) throw new DOMException('full', 'QuotaExceededError');
      return inner.put(k, v);
    },
  });

  it('a full store evicts cache entries to make room for a draft and keeps every existing draft', async () => {
    const base = await freshStore();
    let limit = 1000;
    const { cache } = await setup('usr_a', limited(base, () => limit));
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'first', updatedAt: 1 });
    for (let i = 1; i <= 4; i++) {
      await cache.putConversations([conv(i)]);
      await cache.putMessages(`conv_${i}`, [msg(`conv_${i}`, 1)]);
    }
    limit = (await base.keys('g')).length; // now exactly full
    await cache.saveDraft({ draftId: 'd2', target: { kind: 'contact', id: 'ct_2' }, identityId: 'idn_a', text: 'second', updatedAt: 2 });
    expect((await cache.listDrafts()).map((d) => d.text).sort()).toEqual(['first', 'second']);
    expect((await cache.listConversations()).length).toBeLessThan(4);
    expect(cache.warnings.has('storage-pressure')).toBe(true);
  });

  it('when only drafts remain and the store is still full: warns, throws, and keeps the drafts it has', async () => {
    const base = await freshStore();
    let limit = 1000;
    const warn = vi.fn();
    const { cache } = await setup('usr_a', limited(base, () => limit), { onWarning: warn });
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'first', updatedAt: 1 });
    await cache.saveAttempt(attempt('a1'));
    limit = (await base.keys('g')).length;
    await expect(cache.saveDraft({ draftId: 'd2', target: { kind: 'contact', id: 'ct_2' }, identityId: 'idn_a', text: 'second', updatedAt: 2 })).rejects.toBeInstanceOf(StorageFullError);
    expect(cache.warnings.has('storage-full')).toBe(true);
    expect((await cache.listDrafts()).map((d) => d.text)).toEqual(['first']);
    expect(await cache.listAttempts()).toHaveLength(1);
  });

  it('an interrupted (posting) attempt becomes ambiguous with the same id and request, and nothing is sent', async () => {
    const { cache } = await setup();
    await cache.saveAttempt(attempt('a1', 'posting'));
    expect(await cache.recoverInterruptedAttempts()).toBe(1);
    const [a] = await cache.listAttempts();
    expect(a).toMatchObject({ clientAttemptId: 'a1', phase: 'ambiguous', request: { client_attempt_id: 'a1' } });
  });

  it('an empty draft text removes the draft', async () => {
    const { cache } = await setup();
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: null, text: 'x', updatedAt: 1 });
    await cache.saveDraft({ draftId: 'd1', target: { kind: 'contact', id: 'ct_1' }, identityId: null, text: '  ', updatedAt: 2 });
    expect(await cache.listDrafts()).toEqual([]);
  });
});
