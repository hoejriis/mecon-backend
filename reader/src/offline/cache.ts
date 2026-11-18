/**
 * Encrypted per-user cache in IndexedDB (through the migration runner, schema v1).
 *
 * Layout in the store (see storage/migrations.ts for the generation scheme):
 *   g<N>/r/<userToken>/<kind>/<slot>   a Sealed record (AES-256-GCM, fresh IV, AAD binds user + purpose + slot)
 * `<slot>` is an HMAC of the record id under a per-user key, so key names reveal
 * no conversation, draft or attempt id. The only plaintext in the database is the
 * schema markers, the unlock records (opaque user id, salts, wrapped key) and
 * these opaque key names.
 *
 * What is evictable: cached conversations and their messages (least recently used
 * first, past the configured caps or under storage pressure). Never evicted:
 * drafts and send attempts (uncertain or in flight, and all others), the lease and
 * the clock mark. If the store is full, the cache says so (a warning) and keeps them.
 */
import type { Conversation, Message, Target } from '../api/types';
import type { LocalAttempt } from '../messaging/attemptStatus';
import { newDraftId } from '../messaging/sendFlow';
import { runMigrations, type KvStore, type MigrationResult } from '../storage/migrations';
import { openJson, sealJson, slotToken, type Purpose, type Sealed } from './crypto';
import { userToken } from './crypto';
import { LockedError, type OfflineKeys } from './unlock';

export interface CacheCaps {
  maxConversations: number;
  maxMessagesPerConversation: number;
}
export const DEFAULT_CAPS: CacheCaps = { maxConversations: 100, maxMessagesPerConversation: 200 };

export interface CachedConversation {
  conversation: Conversation;
  /** Logical LRU clock (ms). */
  touchedAt: number;
  /** The identity could not be proven against the Backend at the last reconnect; held, never merged. */
  unproven?: boolean;
}
interface CachedMessages {
  messages: Message[];
}
export interface DraftRecord {
  draftId: string;
  target: Target;
  identityId: string | null;
  text: string;
  updatedAt: number;
}
/** A send attempt as the Reader tracks it (see messaging/attemptStatus). */
export type AttemptRecord = LocalAttempt;

const targetKey = (t: Target) => `${t.kind}:${t.id}`;
/** The pre-migration key shape: the target stood in for the draft id. */
const isLegacyDraftId = (d: DraftRecord) => d.draftId === `draft:${targetKey(d.target)}`;

export class StorageFullError extends Error {
  constructor() {
    super('The browser has no room left for the offline cache');
    this.name = 'StorageFullError';
  }
}

export type CacheWarning = 'storage-pressure' | 'storage-full';

type Kind = 'conv' | 'msgs' | 'draft' | 'attempt' | 'lease' | 'leasekeys' | 'meta' | 'held';
const PURPOSE: Record<Kind, Purpose> = {
  conv: 'cache',
  msgs: 'cache',
  draft: 'drafts',
  attempt: 'drafts',
  lease: 'cache',
  leasekeys: 'cache',
  meta: 'cache',
  held: 'cache',
};
/** The only kinds that storage pressure or the caps may remove. */
const EVICTABLE: readonly Kind[] = ['conv', 'msgs'];

export interface CacheOptions {
  caps?: Partial<CacheCaps>;
  now?: () => number;
  onWarning?: (w: CacheWarning) => void;
  /** Storage estimate, for proactive pressure checks. Defaults to navigator.storage.estimate. */
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  /** Fraction of the quota that counts as pressure. */
  pressureFraction?: number;
}

const isQuota = (e: unknown) =>
  e instanceof DOMException ? e.name === 'QuotaExceededError' : (e as { name?: string } | null)?.name === 'QuotaExceededError';

export type OpenResult = { ok: true; cache: OfflineCache } | { ok: false; migration: Extract<MigrationResult, { status: 'quarantined' }> };

export class OfflineCache {
  readonly caps: CacheCaps;
  readonly warnings = new Set<CacheWarning>();
  /** Records that failed authentication when listed (tampering or corruption). */
  unreadable = 0;
  private readonly now: () => number;

  private constructor(
    private readonly store: KvStore,
    private readonly keys: OfflineKeys,
    private readonly prefix: string,
    private readonly opts: CacheOptions,
  ) {
    this.caps = { ...DEFAULT_CAPS, ...opts.caps };
    this.now = opts.now ?? Date.now;
  }

  static async open(store: KvStore, keys: OfflineKeys, opts: CacheOptions = {}): Promise<OpenResult> {
    const migration = await runMigrations(store);
    if (migration.status === 'quarantined') return { ok: false, migration };
    const marker = (await store.get('meta/schema')) as { generation: number };
    const prefix = `g${marker.generation}/r/${await userToken(keys.userId)}/`;
    return { ok: true, cache: new OfflineCache(store, keys, prefix, opts) };
  }

  get userId(): string {
    return this.keys.userId;
  }
  get locked(): boolean {
    return this.keys.locked;
  }

  /* ------------------------------------------------------------ plumbing */

  private keyFor(purpose: Purpose): CryptoKey {
    return purpose === 'cache' ? this.keys.cache : this.keys.drafts;
  }
  private async slot(kind: Kind, id: string): Promise<string> {
    return slotToken(this.keys.index, kind, id);
  }
  private storeKey(kind: Kind, slot: string) {
    return `${this.prefix}${kind}/${slot}`;
  }
  private warn(w: CacheWarning) {
    if (!this.warnings.has(w)) {
      this.warnings.add(w);
      this.opts.onWarning?.(w);
    }
  }

  private async putRecord(kind: Kind, id: string, value: unknown): Promise<void> {
    const slot = await this.slot(kind, id);
    const sealed = await sealJson(this.keyFor(PURPOSE[kind]), this.keys.userId, PURPOSE[kind], `${kind}/${slot}`, value);
    const key = this.storeKey(kind, slot);
    try {
      await this.store.put(key, sealed);
    } catch (e) {
      if (!isQuota(e)) throw e;
      await this.relievePressure();
      try {
        await this.store.put(key, sealed);
      } catch (e2) {
        if (!isQuota(e2)) throw e2;
        this.warn('storage-full');
        throw new StorageFullError();
      }
    }
  }

  private async getRecord<T>(kind: Kind, id: string): Promise<T | undefined> {
    const slot = await this.slot(kind, id);
    const raw = await this.store.get(this.storeKey(kind, slot));
    if (raw === undefined) return undefined;
    return openJson<T>(this.keyFor(PURPOSE[kind]), this.keys.userId, PURPOSE[kind], `${kind}/${slot}`, raw as Sealed);
  }

  private async deleteRecord(kind: Kind, id: string): Promise<void> {
    await this.store.delete(this.storeKey(kind, await this.slot(kind, id)));
  }

  /** Every readable record of a kind. An unreadable one is counted, never silently dropped from the store. */
  private async listRecords<T>(kind: Kind): Promise<T[]> {
    const out: T[] = [];
    const base = `${this.prefix}${kind}/`;
    for (const k of await this.store.keys(base)) {
      const raw = await this.store.get(k);
      if (raw === undefined) continue;
      try {
        out.push(await openJson<T>(this.keyFor(PURPOSE[kind]), this.keys.userId, PURPOSE[kind], `${kind}/${k.slice(base.length)}`, raw as Sealed));
      } catch (e) {
        if (e instanceof LockedError) throw e;
        this.unreadable += 1;
      }
    }
    return out;
  }

  /* ------------------------------------------------- conversations, messages */

  async putConversation(c: Conversation, opts: { unproven?: boolean } = {}): Promise<void> {
    const rec: CachedConversation = { conversation: c, touchedAt: this.now(), ...(opts.unproven ? { unproven: true } : {}) };
    await this.putRecord('conv', c.id, rec);
  }
  async putConversations(cs: Conversation[]): Promise<void> {
    for (const c of cs) {
      const prev = await this.getRecord<CachedConversation>('conv', c.id);
      await this.putRecord('conv', c.id, { conversation: c, touchedAt: prev?.touchedAt ?? this.now() } satisfies CachedConversation);
    }
    await this.enforceCaps();
  }
  async listConversations(): Promise<CachedConversation[]> {
    const all = await this.listRecords<CachedConversation>('conv');
    return all.sort((a, b) => (a.conversation.last_activity_at < b.conversation.last_activity_at ? 1 : -1));
  }
  async getConversation(id: string): Promise<CachedConversation | undefined> {
    return this.getRecord<CachedConversation>('conv', id);
  }
  /** Marks a held conversation as not provable against the Backend. It is kept, not merged, not deleted. */
  async markUnproven(id: string): Promise<void> {
    const c = await this.getRecord<CachedConversation>('conv', id);
    if (c && !c.unproven) await this.putRecord('conv', id, { ...c, unproven: true });
  }

  /** Stores the newest `maxMessagesPerConversation` messages (by observed_at), merged by message id. */
  async putMessages(conversationId: string, incoming: Message[]): Promise<void> {
    const prev = (await this.getRecord<CachedMessages>('msgs', conversationId))?.messages ?? [];
    const byId = new Map(prev.map((m) => [m.message_id, m]));
    for (const m of incoming) byId.set(m.message_id, m);
    const merged = [...byId.values()].sort((a, b) => (a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : 0));
    const kept = merged.slice(0, this.caps.maxMessagesPerConversation);
    await this.putRecord('msgs', conversationId, { messages: kept } satisfies CachedMessages);
    await this.touch(conversationId);
  }
  /** Newest first. Reading marks the conversation recently used. */
  async getMessages(conversationId: string): Promise<Message[]> {
    const rec = await this.getRecord<CachedMessages>('msgs', conversationId);
    if (rec) await this.touch(conversationId).catch(() => undefined);
    return rec?.messages ?? [];
  }
  private async touch(conversationId: string): Promise<void> {
    const c = await this.getRecord<CachedConversation>('conv', conversationId);
    if (c) await this.putRecord('conv', conversationId, { ...c, touchedAt: this.now() });
  }
  async removeConversation(id: string): Promise<void> {
    await this.deleteRecord('conv', id);
    await this.deleteRecord('msgs', id);
  }
  /** Moves a record out of the live set into a held slot (identity could not be proven), keeping its content. */
  async hold(id: string): Promise<void> {
    const c = await this.getRecord<CachedConversation>('conv', id);
    const m = await this.getRecord<CachedMessages>('msgs', id);
    if (!c) return;
    await this.putRecord('held', id, { conversation: c.conversation, messages: m?.messages ?? [] });
    await this.removeConversation(id);
  }
  async listHeld(): Promise<Array<{ conversation: Conversation; messages: Message[] }>> {
    return this.listRecords('held');
  }

  /** Evicts least-recently-used conversations past the cap. Touches nothing else. */
  async enforceCaps(): Promise<number> {
    const convs = await this.listRecords<CachedConversation>('conv');
    const over = convs.length - this.caps.maxConversations;
    if (over <= 0) return 0;
    return this.evictLru(convs, over);
  }

  private async evictLru(convs: CachedConversation[], n: number): Promise<number> {
    const victims = [...convs].sort((a, b) => a.touchedAt - b.touchedAt).slice(0, n);
    for (const v of victims) {
      for (const kind of EVICTABLE) await this.deleteRecord(kind, v.conversation.id);
    }
    return victims.length;
  }

  /**
   * Frees room by evicting the least recently used half of the cached
   * conversations (at least one). Drafts and attempts are never touched.
   */
  async relievePressure(): Promise<number> {
    this.warn('storage-pressure');
    const convs = await this.listRecords<CachedConversation>('conv');
    if (convs.length === 0) return 0;
    return this.evictLru(convs, Math.max(1, Math.ceil(convs.length / 2)));
  }

  /** Proactive check against the browser's storage estimate. */
  async checkPressure(): Promise<boolean> {
    const est: () => Promise<{ usage?: number; quota?: number }> =
      this.opts.estimate ?? (() => (typeof navigator !== 'undefined' && navigator.storage?.estimate ? navigator.storage.estimate() : Promise.resolve({})));
    const { usage, quota } = await est();
    if (!usage || !quota || usage / quota < (this.opts.pressureFraction ?? 0.8)) return false;
    await this.relievePressure();
    return true;
  }

  /* ----------------------------------------------------- drafts, attempts */

  async saveDraft(d: DraftRecord): Promise<void> {
    if (d.text.trim() === '') return this.deleteRecord('draft', d.draftId);
    await this.putRecord('draft', d.draftId, d);
  }
  /**
   * Drafts are keyed by their real `client_draft_id`. Older Readers keyed them
   * `draft:<kind>:<id>` (the id was not the draft's own). Those are migrated
   * lazily, here on read: re-saved under a freshly minted draft id, then the
   * legacy slot is removed. A legacy record has no draft id of its own, so it
   * could never match an attempt. This is a cache-level rewrite rather than a
   * schema migration because it needs the unlock keys, which the migration
   * runner (it runs before unlock) does not have.
   */
  async listDrafts(): Promise<DraftRecord[]> {
    const all = await this.listRecords<DraftRecord>('draft');
    const out: DraftRecord[] = [];
    for (const d of all) {
      if (!isLegacyDraftId(d)) {
        out.push(d);
        continue;
      }
      const newer = all.some((o) => o !== d && !isLegacyDraftId(o) && targetKey(o.target) === targetKey(d.target) && o.updatedAt >= d.updatedAt);
      if (!newer) {
        const migrated: DraftRecord = { ...d, draftId: newDraftId() };
        await this.saveDraft(migrated);
        out.push(migrated);
      }
      await this.deleteRecord('draft', d.draftId);
    }
    return out;
  }
  async deleteDraft(draftId: string): Promise<void> {
    await this.deleteRecord('draft', draftId);
  }

  async saveAttempt(a: AttemptRecord): Promise<void> {
    await this.putRecord('attempt', a.clientAttemptId, a);
  }
  async listAttempts(): Promise<AttemptRecord[]> {
    return this.listRecords<AttemptRecord>('attempt');
  }
  /**
   * A send that was in flight when the page died has an unknown outcome. Marks
   * it ambiguous (id and request unchanged). Never sends anything.
   */
  async recoverInterruptedAttempts(): Promise<number> {
    let n = 0;
    for (const a of await this.listAttempts()) {
      if (a.phase === 'posting') {
        await this.saveAttempt({ ...a, phase: 'ambiguous' });
        n += 1;
      }
    }
    return n;
  }

  /* ----------------------------------------------------- lease and clock */

  putLease(token: string): Promise<void> {
    return this.putRecord('lease', 'current', { token });
  }
  async getLease(): Promise<string | null> {
    return (await this.getRecord<{ token: string }>('lease', 'current'))?.token ?? null;
  }
  putLeaseKeys<T>(keys: T[]): Promise<void> {
    return this.putRecord('leasekeys', 'current', { keys });
  }
  async getLeaseKeys<T>(): Promise<T[]> {
    return (await this.getRecord<{ keys: T[] }>('leasekeys', 'current'))?.keys ?? [];
  }
  /** The latest time this device has seen while unlocked: a floor for the clock, so rolling it back does not extend a lease. */
  async getClockMark(): Promise<number> {
    return (await this.getRecord<{ at: number }>('meta', 'clock'))?.at ?? 0;
  }
  async bumpClockMark(at: number): Promise<void> {
    if (at > (await this.getClockMark())) await this.putRecord('meta', 'clock', { at });
  }
}
