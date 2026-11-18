/**
 * What the Reader may do, by connectivity, unlock and lease.
 *
 *   online                     the server is authoritative on every request; the lease is NOT consulted
 *   offline, locked            the account-independent shell only; cached content and drafts stay
 *                              encrypted and quarantined (kept, not erased, not shown)
 *   offline, unlocked, valid   cached content readable; local device operations the lease permits
 *   offline, unlocked, other   (expired, missing, invalid, unsupported) read-only; all outbound blocked
 */
import type { LeaseStatus, PermitQuery } from './lease';

export type OfflineMode =
  | { kind: 'online'; message: string }
  | { kind: 'shell'; message: string }
  | { kind: 'offline-lease'; message: string }
  | { kind: 'offline-readonly'; message: string };

export interface GateState {
  online: boolean;
  unlocked: boolean;
  lease: LeaseStatus | null;
}

export function computeMode(s: GateState): OfflineMode {
  if (s.online) return { kind: 'online', message: 'Online.' };
  if (!s.unlocked) return { kind: 'shell', message: 'Offline and locked. Unlock to read your cached messages.' };
  if (s.lease?.state === 'valid') return { kind: 'offline-lease', message: 'Offline. Cached messages are readable; local device sends the lease permits are allowed.' };
  return { kind: 'offline-readonly', message: s.lease?.message ?? 'Offline. Cached messages are read-only; sending is blocked.' };
}

export interface GuardDecision {
  allowed: boolean;
  basis: 'online-server' | 'lease' | 'locked' | 'no-lease';
  reason: string;
}

/** Thrown by `assertAllowed` so a send path can refuse before any byte reaches a device. */
export class OfflineSendBlocked extends Error {
  readonly decision: GuardDecision;
  constructor(d: GuardDecision) {
    super(d.reason);
    this.name = 'OfflineSendBlocked';
    this.decision = d;
  }
}

export interface LeaseSource {
  readonly status: LeaseStatus;
  permits(q: PermitQuery): { allowed: boolean; reason: string };
}

export class OfflineGate {
  #online: boolean;
  #leases: LeaseSource | null = null;
  constructor(online = typeof navigator === 'undefined' ? true : navigator.onLine) {
    this.#online = online;
  }
  get online(): boolean {
    return this.#online;
  }
  setOnline(v: boolean): void {
    this.#online = v;
  }
  /** Attach the unlocked user's lease, or null when locked. */
  setLeases(l: LeaseSource | null): void {
    this.#leases = l;
  }
  get unlocked(): boolean {
    return this.#leases !== null;
  }
  mode(): OfflineMode {
    return computeMode({ online: this.online, unlocked: this.unlocked, lease: this.#leases?.status ?? null });
  }
  /** Cached private content may be shown only while unlocked. */
  canReadCache(): boolean {
    return this.unlocked;
  }
  /** The guard BLE and USB send paths call before they write to a device. */
  guard(q: PermitQuery): GuardDecision {
    if (this.online) return { allowed: true, basis: 'online-server', reason: 'Online: the server decides.' };
    if (!this.#leases) return { allowed: false, basis: 'locked', reason: 'Offline and locked: unlock first.' };
    const r = this.#leases.permits(q);
    return { allowed: r.allowed, basis: r.allowed ? 'lease' : 'no-lease', reason: r.reason };
  }
  assertAllowed(q: PermitQuery): void {
    const d = this.guard(q);
    if (!d.allowed) throw new OfflineSendBlocked(d);
  }
}

let current: OfflineGate | null = null;
export const registerGate = (g: OfflineGate | null): void => {
  current = g;
};
/**
 * Module-level guard for non-React send paths. With no gate registered it
 * trusts only the browser's online flag, and offline it blocks.
 */
export function offlineSendGuard(q: PermitQuery): GuardDecision {
  return (current ?? new OfflineGate()).guard(q);
}
