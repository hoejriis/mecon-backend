/**
 * What an update (or a stale-shell repair, or a reload) would interrupt.
 * Features that hold state a reload loses register a guard; the update flow
 * asks every guard before it activates a new version.
 */
export interface Blockers {
  /** Non-empty unsent drafts. They live in memory only and a reload loses them. */
  drafts: number;
  /** Send attempts whose outcome is not final or is unknown/ambiguous. */
  uncertainAttempts: number;
  /** A Bluetooth Companion link is open or being opened. */
  bleConnected: boolean;
}

export type Guard = () => Partial<Blockers>;

export const NO_BLOCKERS: Blockers = { drafts: 0, uncertainAttempts: 0, bleConnected: false };

export const hasBlockers = (b: Blockers): boolean => b.drafts > 0 || b.uncertainAttempts > 0 || b.bleConnected;

const guards = new Set<Guard>();

/** Register a guard; the returned function removes it. */
export function registerUpdateGuard(g: Guard): () => void {
  guards.add(g);
  return () => void guards.delete(g);
}

export function collectBlockers(): Blockers {
  const total: Blockers = { ...NO_BLOCKERS };
  for (const g of guards) {
    const p = g();
    total.drafts += p.drafts ?? 0;
    total.uncertainAttempts += p.uncertainAttempts ?? 0;
    total.bleConnected = total.bleConnected || p.bleConnected === true;
  }
  return total;
}

/** Guard for a BLE adapter (anything exposing the adapter's snapshot). */
export function bleAdapterGuard(adapter: { getSnapshot(): { bleConnection: string } }): Guard {
  return () => {
    const c = adapter.getSnapshot().bleConnection;
    return { bleConnected: c === 'connected' || c === 'requesting' };
  };
}
