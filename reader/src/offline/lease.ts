/**
 * Offline lease: verification and use. See contracts/reader-api/v1/openapi.yaml
 * (`LeaseToken`, `LeasePayload`) and docs/READER_API_CONTRACT.md.
 *
 * The Reader only ever VERIFIES a lease. It can never mint or extend one: the
 * Backend's private key is not here, and a lease grants nothing the server did
 * not put in it. Online, rights come from the server on every request and the
 * lease is not consulted. Offline, revocation cannot be faster than expiry.
 *
 * Clock rule. A lease is expired when the effective time reaches `expires_at`,
 * with no grace. The effective time is the LATEST of: the local clock, the
 * newest time this device saw while unlocked (the clock mark), and the lease's
 * own `issued_at`. Setting the device clock back therefore cannot extend a
 * lease past what the device has already observed. A clock that is simply
 * running slow, with nothing observed to prove it, can extend a lease by that
 * much; that error is not detectable offline and is bounded by how far the
 * clock lags, within the 7-day maximum. A fast clock only ends a lease early.
 */
import type { LeaseKey, LeaseOperation, LeasePayload } from '../api/types';
import { b64uDecode, concat, fromUtf8, utf8 } from './bytes';

export const MAX_LEASE_MS = 7 * 24 * 3600 * 1000;
export const LEASE_SIGN_PREFIX = utf8('MECON-LEASE-1\0');

export type LeaseState = 'valid' | 'expired' | 'missing' | 'invalid-signature' | 'unsupported';

export type LeaseReason =
  | 'ok'
  | 'no-lease'
  | 'ed25519-unsupported'
  | 'malformed'
  | 'unknown-key'
  | 'key-not-valid-at-issue'
  | 'bad-signature'
  | 'lifetime-exceeds-7-days'
  | 'user-mismatch'
  | 'past-expiry';

export interface LeaseStatus {
  state: LeaseState;
  reason: LeaseReason;
  /** Present only when the signature verified and the payload passed every check. */
  payload: LeasePayload | null;
  expiresAtMs: number | null;
  /** Plain-language line for the UI. */
  message: string;
}

const MESSAGES: Record<LeaseReason, string> = {
  ok: 'Offline lease valid.',
  'no-lease': 'No offline lease. Connect to the Backend once to get one.',
  'ed25519-unsupported': 'This browser cannot verify offline leases (no Ed25519 in WebCrypto), so offline sending is not permitted here.',
  malformed: 'The stored offline lease is unreadable. Offline sending is not permitted.',
  'unknown-key': 'The offline lease was signed by a key this Reader does not know. Offline sending is not permitted.',
  'key-not-valid-at-issue': 'The offline lease was signed outside its key’s validity. Offline sending is not permitted.',
  'bad-signature': 'The offline lease signature is not valid. Offline sending is not permitted.',
  'lifetime-exceeds-7-days': 'The offline lease claims more than 7 days. It is refused.',
  'user-mismatch': 'The offline lease belongs to a different account. It is refused.',
  'past-expiry': 'The offline lease has expired. Cached content is read-only until you reconnect.',
};

const status = (state: LeaseState, reason: LeaseReason, payload: LeasePayload | null = null): LeaseStatus => ({
  state,
  reason,
  payload,
  expiresAtMs: payload ? Date.parse(payload.expires_at) : null,
  message: MESSAGES[reason],
});

let ed25519Cache: boolean | null = null;
/** True when WebCrypto can verify Ed25519 here. Probed once with a real (throwaway) verification. */
export async function ed25519Supported(force = false): Promise<boolean> {
  if (ed25519Cache !== null && !force) return ed25519Cache;
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), { name: 'Ed25519' }, false, ['verify']);
    await crypto.subtle.verify({ name: 'Ed25519' }, key, new Uint8Array(64), new Uint8Array(1));
    ed25519Cache = true;
  } catch {
    ed25519Cache = false;
  }
  return ed25519Cache;
}
/** For tests: forget the probe result. */
export const resetEd25519Probe = () => {
  ed25519Cache = null;
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function shapeOk(p: unknown): p is LeasePayload {
  const o = p as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return false;
  if (![o.lease_id, o.user_id, o.key_id].every(isStr)) return false;
  if (!isTime(o.issued_at) || !isTime(o.expires_at)) return false;
  if (typeof o.contract_version !== 'string' || !/^1\.[0-9]+$/.test(o.contract_version)) return false;
  if (!Array.isArray(o.devices) || !o.devices.every(isStr)) return false;
  if (!Array.isArray(o.channels) || !o.channels.every(isStr)) return false;
  if (!Array.isArray(o.identities)) return false;
  return o.identities.every((i: unknown) => {
    const r = i as { identity_id?: unknown; operations?: unknown };
    return isStr(r.identity_id) && Array.isArray(r.operations) && r.operations.every((x) => x === 'receive' || x === 'send.direct' || x === 'send.channel');
  });
}

export interface EvaluateContext {
  /** The signed-in (or unlocked) user: a lease for anyone else is refused. */
  userId: string;
  /** Local clock, ms since epoch. */
  now: number;
  /** Newest time this device observed while unlocked (see clock rule). */
  clockMark?: number;
}

export const effectiveNow = (ctx: Pick<EvaluateContext, 'now' | 'clockMark'>, issuedAtMs: number): number =>
  Math.max(ctx.now, ctx.clockMark ?? 0, issuedAtMs);

/** Verifies a lease token against the cached Backend keys. Never throws. */
export async function evaluateLease(token: string | null, keys: readonly LeaseKey[], ctx: EvaluateContext): Promise<LeaseStatus> {
  if (!token) return status('missing', 'no-lease');
  if (!(await ed25519Supported())) return status('unsupported', 'ed25519-unsupported');
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return status('invalid-signature', 'malformed');
    const body = b64uDecode(parts[0]!);
    const sig = b64uDecode(parts[1]!);
    // The payload is read only to choose the key; nothing in it is trusted until the signature verifies.
    const claimed = JSON.parse(fromUtf8(body)) as { key_id?: unknown; issued_at?: unknown };
    const key = keys.find((k) => k.key_id === claimed.key_id && k.algorithm === 'Ed25519');
    if (!key) return status('invalid-signature', 'unknown-key');
    const pub = await crypto.subtle.importKey('raw', b64uDecode(key.public_key), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, concat(LEASE_SIGN_PREFIX, body));
    if (!ok) return status('invalid-signature', 'bad-signature');

    const payload: unknown = claimed;
    if (!shapeOk(payload)) return status('invalid-signature', 'malformed');
    const issued = Date.parse(payload.issued_at);
    const expires = Date.parse(payload.expires_at);
    const from = Date.parse(key.not_before);
    const to = key.not_after ? Date.parse(key.not_after) : Infinity;
    if (issued < from || issued > to) return status('invalid-signature', 'key-not-valid-at-issue');
    if (expires <= issued) return status('invalid-signature', 'malformed');
    if (expires - issued > MAX_LEASE_MS) return status('invalid-signature', 'lifetime-exceeds-7-days');
    if (payload.user_id !== ctx.userId) return status('invalid-signature', 'user-mismatch');
    if (effectiveNow(ctx, issued) >= expires) return status('expired', 'past-expiry', payload);
    return status('valid', 'ok', payload);
  } catch {
    return status('invalid-signature', 'malformed');
  }
}

export interface PermitResult {
  allowed: boolean;
  reason: string;
}
export interface PermitQuery {
  op: LeaseOperation;
  identityId: string;
  deviceId: string;
  /** For `send.channel`: when given, the channel must be on the lease. */
  channelId?: string;
}

/**
 * Whether a verified lease permits one local operation right now. The expiry is
 * re-checked at every call against the clock, so a lease that was valid when
 * loaded stops permitting the moment it expires.
 */
export function permits(lease: LeaseStatus, q: PermitQuery, ctx: Pick<EvaluateContext, 'now' | 'clockMark'>): PermitResult {
  const p = lease.payload;
  if (lease.state !== 'valid' || !p) return { allowed: false, reason: lease.message };
  if (effectiveNow(ctx, Date.parse(p.issued_at)) >= Date.parse(p.expires_at)) return { allowed: false, reason: MESSAGES['past-expiry'] };
  const id = p.identities.find((i) => i.identity_id === q.identityId);
  if (!id) return { allowed: false, reason: 'This identity is not on your offline lease.' };
  if (!id.operations.includes(q.op)) return { allowed: false, reason: `Your offline lease does not allow ${q.op} for this identity.` };
  if (!p.devices.includes(q.deviceId)) return { allowed: false, reason: 'This device is not assigned to you on your offline lease.' };
  if (q.op === 'send.channel' && q.channelId !== undefined && !p.channels.includes(q.channelId)) {
    return { allowed: false, reason: 'This channel is not on your offline lease.' };
  }
  return { allowed: true, reason: 'Permitted by the offline lease.' };
}

/** Half the lifetime has passed, or there is no usable lease: time to renew while online. */
export function needsRenewal(lease: LeaseStatus, now: number): boolean {
  const p = lease.payload;
  if (lease.state !== 'valid' || !p) return true;
  const issued = Date.parse(p.issued_at);
  return now >= issued + (Date.parse(p.expires_at) - issued) / 2;
}
