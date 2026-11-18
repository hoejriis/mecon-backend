/** Test helper: a lease source over a hand-made verified lease, so tests exercise the real `permits` rules without signing. */
import type { LeasePayload } from '../api/types';
import { permits, type LeaseStatus, type PermitQuery } from './lease';
import type { LeaseSource } from './gate';
import { DAY, T0, iso, leasePayload } from './testkit';

export type LeaseKind = 'valid' | 'expired' | 'missing' | 'unsupported' | 'invalid-signature';

export function leaseStatus(kind: LeaseKind, payload: LeasePayload = leasePayload()): LeaseStatus {
  const msg: Record<LeaseKind, string> = {
    valid: 'Offline lease valid.',
    expired: 'The offline lease has expired. Cached content is read-only until you reconnect.',
    missing: 'No offline lease. Connect to the Backend once to get one.',
    unsupported: 'This browser cannot verify offline leases (no Ed25519 in WebCrypto), so offline sending is not permitted here.',
    'invalid-signature': 'The offline lease signature is not valid. Offline sending is not permitted.',
  };
  return {
    state: kind,
    reason: kind === 'valid' ? 'ok' : kind === 'expired' ? 'past-expiry' : kind === 'missing' ? 'no-lease' : kind === 'unsupported' ? 'ed25519-unsupported' : 'bad-signature',
    payload: kind === 'valid' || kind === 'expired' ? payload : null,
    expiresAtMs: kind === 'valid' || kind === 'expired' ? Date.parse(payload.expires_at) : null,
    message: msg[kind],
  };
}

/** Real `permits()` against the lease; `now` is fixed so expiry is deterministic. */
export function leaseSource(kind: LeaseKind, payload: LeasePayload = leasePayload(), now = T0 + DAY): LeaseSource {
  const status = leaseStatus(kind, payload);
  return { status, permits: (q: PermitQuery) => permits(status, q, { now }) };
}

export const expiredPayload = (): LeasePayload => leasePayload({ issuedMs: T0 - 8 * DAY, lifeMs: 7 * DAY });
export { iso };
