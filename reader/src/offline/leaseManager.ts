import type { ApiClient } from '../api/client';
import { ApiError } from '../api/client';
import type { LeaseKey } from '../api/types';
import type { OfflineCache } from './cache';
import { ed25519Supported, evaluateLease, needsRenewal, permits, type LeaseStatus, type PermitQuery, type PermitResult } from './lease';

export interface LeaseManagerOptions {
  now?: () => number;
}

/**
 * Holds the current lease status for the unlocked user. `refresh` runs only
 * while online with messaging available; it can only store what the Backend
 * returned, and the result is verified like any other lease.
 */
export class LeaseManager {
  status: LeaseStatus = { state: 'missing', reason: 'no-lease', payload: null, expiresAtMs: null, message: '' };
  private readonly now: () => number;
  private mark = 0;
  constructor(
    private readonly cache: OfflineCache,
    opts: LeaseManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Evaluate what is stored, offline-safe. */
  async load(): Promise<LeaseStatus> {
    const [token, keys, mark] = await Promise.all([this.cache.getLease(), this.cache.getLeaseKeys<LeaseKey>(), this.cache.getClockMark()]);
    this.mark = mark;
    this.status = await evaluateLease(token, keys, { userId: this.cache.userId, now: this.now(), clockMark: mark });
    await this.cache.bumpClockMark(this.now()).catch(() => undefined);
    return this.status;
  }

  /** Periodic: raise the clock mark and re-evaluate, so a lease that has run out stops permitting. */
  async tick(): Promise<LeaseStatus> {
    return this.load();
  }

  /** Fetch keys and (when due) a lease. A Backend without leases (404) leaves things as they are. */
  async refresh(api: Pick<ApiClient, 'createLease' | 'listLeaseKeys'>, opts: { force?: boolean } = {}): Promise<LeaseStatus> {
    if (!(await ed25519Supported())) return this.load(); // 'unsupported': say so, fetch nothing useless
    try {
      const keys = await api.listLeaseKeys();
      await this.cache.putLeaseKeys(keys.keys);
      await this.load();
      if (opts.force || needsRenewal(this.status, this.now())) {
        const issued = await api.createLease();
        const probe = await evaluateLease(issued.lease, keys.keys, { userId: this.cache.userId, now: this.now(), clockMark: await this.cache.getClockMark() });
        // Store only a lease that verifies; a bad one from a broken Backend must not replace a good one.
        if (probe.state === 'valid') await this.cache.putLease(issued.lease);
      }
    } catch (e) {
      if (!(e instanceof ApiError) && !(e instanceof TypeError)) throw e;
    }
    return this.load();
  }

  /** Synchronous: expiry is re-checked against the clock at every call. */
  permits(q: PermitQuery): PermitResult {
    return permits(this.status, q, { now: this.now(), clockMark: this.mark });
  }
}
