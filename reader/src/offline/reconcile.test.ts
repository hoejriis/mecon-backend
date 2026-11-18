// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Channel, Contact, Conversation, Identity, Message } from '../api/types';
import type { LocalAttempt } from '../messaging/attemptStatus';
import { OfflineCache } from './cache';
import { reconcile } from './reconcile';
import { OfflineSession } from './session';
import { DAY, T0, fakePasskey, freshStore, leasePayload, makeSigner } from './testkit';
import { LockedError, setupWithPasskey } from './unlock';

const conv = (id: string, identity = 'idn_a', extra: Partial<Conversation> = {}): Conversation => ({
  id,
  identity_id: identity,
  target: { kind: 'contact', id: `ct_${id}` },
  title: `Synthetic ${id}`,
  unread_count: 0,
  last_activity_at: '2030-01-01T00:00:01Z',
  ...extra,
});
const ident = (id: string): Identity => ({ id, display_name: id, public_key_prefix: 'ab12', device_id: 'dev_1', can_send: true });
const msg = (c: string, n: number, text = 'x'): Message => ({
  message_id: `m${n}`,
  conversation_id: c,
  identity_id: 'idn_a',
  direction: 'inbound',
  sender_label: null,
  source_path: 'backend',
  observed_at: `2030-01-01T00:00:0${n}Z`,
  content: { kind: 'text', text },
});
const att = (id: string, phase: LocalAttempt['phase']): LocalAttempt => ({
  clientAttemptId: id,
  draftId: `draft_${id}`,
  request: { client_draft_id: `draft_${id}`, client_attempt_id: id, identity_id: 'idn_a', target: { kind: 'contact', id: 'ct_1' }, content: { kind: 'text', text: 'synthetic' } },
  phase,
  attempt: null,
  error: null,
  supersededBy: null,
  createdAt: 7,
});

async function open(userId = 'usr_a', store?: Awaited<ReturnType<typeof freshStore>>) {
  const s = store ?? (await freshStore());
  const keys = await setupWithPasskey(s, userId, { webauthn: fakePasskey() });
  const r = await OfflineCache.open(s, keys);
  if (!r.ok) throw new Error('q');
  return { cache: r.cache, store: s, keys };
}
const snap = (over: Partial<Parameters<typeof reconcile>[1]> = {}) => ({ identities: [ident('idn_a')], conversations: [], channels: [], ...over });

describe('contacts and channels for matching a target on a device offline', () => {
  const contact = (id: string, prefix: string): Contact => ({ id, display_name: id, public_key_prefix: prefix, last_heard_at: null });
  const channel = (id: string, name: string): Channel => ({ id, name, visibility: 'private' });

  it('are cached as the Backend listed them, stay readable after the cache is reopened, and are sealed', async () => {
    const { cache, store, keys } = await open();
    await reconcile(cache, snap({ contacts: [contact('ct_1', 'a1a1a1')], channels: [channel('ch_1', 'Crew')] }));
    const again = await OfflineCache.open(store, keys);
    if (!again.ok) throw new Error('q');
    expect(await again.cache.getDirectory()).toEqual({ contacts: [contact('ct_1', 'a1a1a1')], channels: [channel('ch_1', 'Crew')] });
    expect(JSON.stringify(await store.keys(''))).not.toContain('a1a1a1');
  });

  it('a channel hash is cached with the channel (and a null one stays null), so the cross-check works offline', async () => {
    const { cache, store, keys } = await open();
    const withHash: Channel = { ...channel('ch_1', 'Crew'), hash: '5f' };
    const unknown: Channel = { ...channel('ch_2', 'Ops'), hash: null };
    await reconcile(cache, snap({ channels: [withHash, unknown] }));
    const again = await OfflineCache.open(store, keys);
    if (!again.ok) throw new Error('q');
    expect((await again.cache.getDirectory()).channels).toEqual([withHash, unknown]);
  });

  it('a list that did not load leaves the cached one alone (a failed load never empties it); a list that loaded replaces it', async () => {
    const { cache } = await open();
    await reconcile(cache, snap({ contacts: [contact('ct_1', 'a1a1a1')], channels: [channel('ch_1', 'Crew')] }));
    await reconcile(cache, { identities: [ident('idn_a')], conversations: [] }); // neither list loaded
    expect(await cache.getDirectory()).toEqual({ contacts: [contact('ct_1', 'a1a1a1')], channels: [channel('ch_1', 'Crew')] });
    await reconcile(cache, { identities: [ident('idn_a')], conversations: [], contacts: [contact('ct_2', 'b2b2b2')] });
    expect(await cache.getDirectory()).toEqual({ contacts: [contact('ct_2', 'b2b2b2')], channels: [channel('ch_1', 'Crew')] });
  });

  it('nothing cached reads as empty lists', async () => {
    const { cache } = await open();
    expect(await cache.getDirectory()).toEqual({ contacts: [], channels: [] });
  });
});

describe('reconnect', () => {
  it('refreshes cached conversations and messages from the Backend snapshot', async () => {
    const { cache } = await open();
    await cache.putConversations([conv('c1', 'idn_a', { title: 'old title' })]);
    await cache.putMessages('c1', [msg('c1', 1, 'old')]);
    const r = await reconcile(cache, snap({ conversations: [conv('c1')], messages: { c1: [msg('c1', 1, 'fresh'), msg('c1', 2)] } }));
    expect(r.refreshed).toBe(1);
    expect((await cache.getConversation('c1'))!.conversation.title).toBe('Synthetic c1');
    expect((await cache.getMessages('c1')).map((m) => m.content.text)).toEqual(['x', 'fresh']);
  });

  it('preserves drafts, with their ids and text', async () => {
    const { cache } = await open();
    await cache.saveDraft({ draftId: 'dr1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'unsent words', updatedAt: 1 });
    await cache.saveDraft({ draftId: 'dr2', target: { kind: 'contact', id: 'ct_gone' }, identityId: 'idn_gone', text: 'for a vanished identity', updatedAt: 2 });
    const r = await reconcile(cache, snap());
    expect(r.draftsKept).toBe(2);
    expect((await cache.listDrafts()).map((d) => [d.draftId, d.text]).sort()).toEqual([
      ['dr1', 'unsent words'],
      ['dr2', 'for a vanished identity'],
    ]);
  });

  it('uncertain attempts keep their ids and requests, and nothing is ever re-sent', async () => {
    const { cache } = await open();
    await cache.saveAttempt(att('att_1', 'ambiguous'));
    await cache.saveAttempt(att('att_2', 'posting')); // in flight when the page died
    await cache.saveAttempt(att('att_3', 'accepted'));
    const api = { createSendAttempt: vi.fn(), getSendAttempt: vi.fn(), markConversationRead: vi.fn() };
    const r = await reconcile(cache, snap({ conversations: [conv('c1')] }));
    expect(r.uncertainAttempts).toBe(2);
    const all = Object.fromEntries((await cache.listAttempts()).map((a) => [a.clientAttemptId, a]));
    expect(all.att_1).toMatchObject({ phase: 'ambiguous', request: { client_attempt_id: 'att_1', content: { text: 'synthetic' } } });
    expect(all.att_2).toMatchObject({ phase: 'ambiguous', request: { client_attempt_id: 'att_2' } });
    expect(all.att_3!.phase).toBe('accepted');
    expect(Object.values(api).every((f) => f.mock.calls.length === 0)).toBe(true);
    // Running reconcile again changes nothing about the uncertain ones.
    await reconcile(cache, snap());
    expect((await cache.listAttempts()).filter((a) => a.phase === 'ambiguous')).toHaveLength(2);
  });

  it('does not merge a conversation whose identity the Backend does not list; it is held, intact', async () => {
    const { cache } = await open();
    await cache.putConversations([conv('c1', 'idn_a'), conv('c2', 'idn_gone')]);
    await cache.putMessages('c2', [msg('c2', 1, 'private words')]);
    const r = await reconcile(cache, snap({ conversations: [conv('c1')] }));
    expect(r.held).toEqual(['c2']);
    expect((await cache.listConversations()).map((c) => c.conversation.id)).toEqual(['c1']);
    const held = await cache.listHeld();
    expect(held).toHaveLength(1);
    expect(held[0]!.messages[0]!.content.text).toBe('private words');
  });

  it('does not merge server data into a conversation id whose identity changed', async () => {
    const { cache } = await open();
    await cache.putConversations([conv('c1', 'idn_a')]);
    await cache.putMessages('c1', [msg('c1', 1, 'from the old identity')]);
    await reconcile(cache, { identities: [ident('idn_a'), ident('idn_b')], channels: [], conversations: [conv('c1', 'idn_b')], messages: { c1: [msg('c1', 2, 'new')] } });
    expect((await cache.getMessages('c1')).map((m) => m.content.text)).toEqual(['new']); // not mixed with the old identity's rows
    expect((await cache.listHeld())[0]!.messages[0]!.content.text).toBe('from the old identity');
  });

  it('refuses a snapshot conversation under an identity the same snapshot does not list', async () => {
    const { cache } = await open();
    const r = await reconcile(cache, snap({ conversations: [conv('c9', 'idn_unlisted')] }));
    expect(r.refreshed).toBe(0);
    expect(await cache.listConversations()).toEqual([]);
  });
});

describe('account switch', () => {
  async function rig() {
    const store = await freshStore();
    const signer = await makeSigner();
    const now = { t: T0 };
    const webauthn = fakePasskey();
    const session = new OfflineSession({ store, webauthn, now: () => now.t, idleMs: 1000 });
    return { store, signer, now, session, webauthn };
  }

  it('locks the previous user, isolates their cache, and returns it intact only to them', async () => {
    const { session, store } = await rig();
    expect((await session.setup('usr_a')).status).toBe('ready');
    await session.cache!.putConversations([conv('c1')]);
    await session.cache!.putMessages('c1', [msg('c1', 1, 'a private')]);
    await session.cache!.saveDraft({ draftId: 'dr1', target: { kind: 'contact', id: 'ct_1' }, identityId: 'idn_a', text: 'a draft', updatedAt: 1 });
    const aCache = session.cache!;
    expect(session.unlockedUserId).toBe('usr_a');

    session.followSession('usr_b'); // the Backend session is now another user
    expect(session.unlockedUserId).toBeNull();
    expect(session.gate.canReadCache()).toBe(false);
    await expect(aCache.listConversations()).rejects.toBeInstanceOf(LockedError); // the old handle is dead

    // B sets up on the same device: sees nothing of A's.
    expect((await session.setup('usr_b')).status).toBe('ready');
    expect(await session.cache!.listConversations()).toEqual([]);
    expect(await session.cache!.listDrafts()).toEqual([]);

    // Back to A: everything is still there (quarantined, never erased).
    session.followSession(null);
    expect(session.unlockedUserId).toBeNull();
    await session.unlockPasskey('usr_a');
    expect((await session.cache!.listConversations()).map((c) => c.conversation.id)).toEqual(['c1']);
    expect((await session.cache!.listDrafts())[0]!.text).toBe('a draft');
    expect(JSON.stringify(await Promise.all((await store.keys('')).map((k) => store.get(k))))).not.toContain('a private');
  });

  it('sign-out (the session ending) locks; the same user staying does not', async () => {
    const { session } = await rig();
    await session.setup('usr_a');
    session.followSession('usr_a');
    expect(session.unlockedUserId).toBe('usr_a');
    session.followSession(null);
    expect(session.unlockedUserId).toBeNull();
    expect(session.gate.unlocked).toBe(false);
  });

  it('locks after the idle timeout; activity postpones it', async () => {
    // A manual clock for the idle timer only (fake-indexeddb needs the real timers).
    let t = 0;
    let due: { at: number; fn: () => void } | null = null;
    const idleTimers = {
      set: (fn: () => void, ms: number) => (due = { at: t + ms, fn }),
      clear: () => (due = null),
    };
    const advance = (ms: number) => {
      t += ms;
      if (due && t >= due.at) {
        const d = due;
        due = null;
        d.fn();
      }
    };
    const store = await freshStore();
    const session = new OfflineSession({ store, webauthn: fakePasskey(), idleMs: 1000, idleTimers });
    await session.setup('usr_a');
    advance(900);
    session.touch();
    advance(900);
    expect(session.unlockedUserId).toBe('usr_a');
    advance(200);
    expect(session.unlockedUserId).toBeNull();
    expect(session.cache).toBeNull();
    expect(session.gate.unlocked).toBe(false);
  });

  it('after a reload the interrupted attempt is marked ambiguous exactly once and the lease is evaluated offline', async () => {
    const { session, store, signer, now } = await rig();
    await session.setup('usr_a');
    await session.cache!.saveAttempt(att('att_1', 'posting'));
    await session.cache!.putLeaseKeys([signer.key]);
    await session.cache!.putLease(await signer.sign(leasePayload({ issuedMs: now.t })));
    session.lock();
    const reloaded = new OfflineSession({ store, webauthn: (session as unknown as { opts: { webauthn: never } }).opts.webauthn, now: () => now.t + DAY });
    await reloaded.unlockPasskey('usr_a');
    expect((await reloaded.cache!.listAttempts())[0]!.phase).toBe('ambiguous');
    expect(reloaded.leases!.status.state).toBe('valid');
  });
});
