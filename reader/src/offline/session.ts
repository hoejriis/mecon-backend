/**
 * Ties unlock, cache, lease and gate together for one device. UI-agnostic (the
 * React provider wraps it) so the lock rules are tested without a browser.
 *
 * Locking drops every key reference. It happens on sign-out, on an account
 * switch (the session user differs from the unlocked user), after the idle
 * timeout, and on request. Locked, the cache's records stay encrypted in
 * IndexedDB: quarantined, not erased.
 */
import type { KvStore } from '../storage/migrations';
import { OfflineCache, type CacheOptions, type CacheWarning } from './cache';
import { OfflineGate } from './gate';
import { LeaseManager } from './leaseManager';
import {
  DEFAULT_IDLE_MS,
  IdleLock,
  getUnlockRecord,
  setupUnlock,
  unlockWithPasskey,
  unlockWithPin,
  type IdleTimers,
  type OfflineKeys,
  type SetupResult,
  type UnlockMethod,
  type WebAuthnLike,
} from './unlock';

export interface OfflineSessionOptions {
  store: KvStore;
  gate?: OfflineGate;
  now?: () => number;
  webauthn?: WebAuthnLike | null;
  idleMs?: number;
  idleTimers?: IdleTimers;
  cache?: CacheOptions;
  onChange?: () => void;
}

export type OpenOutcome = { ok: true } | { ok: false; quarantined: true };

export class OfflineSession {
  readonly gate: OfflineGate;
  readonly store: KvStore;
  cache: OfflineCache | null = null;
  leases: LeaseManager | null = null;
  keys: OfflineKeys | null = null;
  quarantined = false;
  readonly warnings = new Set<CacheWarning>();
  private idle: IdleLock;
  private recovered = false;

  constructor(private readonly opts: OfflineSessionOptions) {
    this.store = opts.store;
    this.gate = opts.gate ?? new OfflineGate();
    this.idle = new IdleLock(opts.idleMs ?? DEFAULT_IDLE_MS, () => this.lock(), opts.idleTimers);
  }

  get unlockedUserId(): string | null {
    return this.keys && !this.keys.locked ? this.keys.userId : null;
  }
  get method(): UnlockMethod | null {
    return this.keys?.method ?? null;
  }

  private changed() {
    this.opts.onChange?.();
  }

  async hasSetup(userId: string): Promise<UnlockMethod | null> {
    return (await getUnlockRecord(this.store, userId))?.method ?? null;
  }

  private async adopt(keys: OfflineKeys): Promise<OpenOutcome> {
    this.lock(); // never hold two users' keys
    const opened = await OfflineCache.open(this.store, keys, {
      ...this.opts.cache,
      now: this.opts.now,
      onWarning: (w) => {
        this.warnings.add(w);
        this.changed();
      },
    });
    if (!opened.ok) {
      keys.lock();
      this.quarantined = true;
      this.changed();
      return { ok: false, quarantined: true };
    }
    this.quarantined = false;
    this.keys = keys;
    this.cache = opened.cache;
    if (!this.recovered) {
      await opened.cache.recoverInterruptedAttempts();
      this.recovered = true;
    }
    this.leases = new LeaseManager(opened.cache, { now: this.opts.now });
    await this.leases.load();
    this.gate.setLeases(this.leases);
    this.idle.touch();
    this.changed();
    return { ok: true };
  }

  async setup(userId: string, o: { preferPasskey: boolean; pin?: string }): Promise<SetupResult & { opened?: OpenOutcome }> {
    const r = await setupUnlock(this.store, userId, { ...o, webauthn: this.opts.webauthn });
    if (r.status === 'ready') return { ...r, opened: await this.adopt(r.keys) };
    return r;
  }
  async unlockPin(userId: string, pin: string): Promise<OpenOutcome> {
    return this.adopt(await unlockWithPin(this.store, userId, pin));
  }
  async unlockPasskey(userId: string): Promise<OpenOutcome> {
    return this.adopt(await unlockWithPasskey(this.store, userId, { webauthn: this.opts.webauthn }));
  }

  lock(): void {
    this.idle.stop();
    this.gate.setLeases(null);
    this.keys?.lock();
    this.keys = null;
    this.cache = null;
    this.leases = null;
    this.changed();
  }

  /** The Backend session's user changed (or ended). Another user, or none, locks the cache. */
  followSession(userId: string | null): void {
    const u = this.unlockedUserId;
    if (u !== null && u !== userId) this.lock();
  }

  /** Call on user activity. */
  touch(): void {
    if (this.keys && !this.keys.locked) this.idle.touch();
  }
}
