/**
 * Local unlock for the offline cache: a passkey through the WebAuthn PRF
 * extension only (owner decision, 2026-11-18). There is no PIN and no fallback:
 * a browser without PRF gets no offline cache and works online only.
 *
 * A random 256-bit data key protects the cache. It is stored only wrapped
 * (AES-GCM) by a key-encryption key (KEK) that exists only while unlocked. The
 * KEK is HKDF-SHA-256 over the PRF output. The store holds the wrapped data key,
 * a salt and the credential id (all non-secret). The unwrapped data key lives only
 * as a non-extractable HKDF key in memory and is dropped on lock (sign-out, idle).
 * Per-user, per-purpose keys come from HKDF with the user id and purpose in `info`.
 * Any stored record whose method is not `passkey` is ignored and removed.
 */
import type { KvStore } from '../storage/migrations';
import { b64uDecode, b64uEncode, randomBytes, utf8, type Bytes } from './bytes';
import {
  CryptoFailure,
  FORMAT,
  derivePurposeKey,
  deriveIndexKey,
  importHkdf,
  open,
  seal,
  userToken,
  type Sealed,
} from './crypto';

export const DEFAULT_IDLE_MS = 5 * 60_000;

export type UnlockMethod = 'passkey';

export type UnlockErrorCode =
  | 'wrong-credential'
  | 'prf-unsupported'
  | 'passkey-cancelled'
  | 'no-record'
  | 'already-set-up'
  | 'bad-record';

export class UnlockError extends Error {
  readonly code: UnlockErrorCode;
  constructor(code: UnlockErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'UnlockError';
    this.code = code;
  }
}

export class LockedError extends Error {
  constructor() {
    super('The offline cache is locked');
    this.name = 'LockedError';
  }
}

/** What is stored per user, in the clear. Nothing here is secret or reveals content. */
export interface UnlockRecord {
  v: 1;
  /** Opaque Backend user id. */
  userId: string;
  method: UnlockMethod;
  createdAt: string;
  /** Random per-user HKDF salt for the passkey KEK. */
  salt: string;
  passkey?: { credentialId: string; prfSalt: string };
  /** The random data key, wrapped by the KEK. */
  wrapped: Sealed;
}

const recordKey = (token: string) => `unlock/${token}`;

/** Keys held only while unlocked. `lock()` drops every reference. */
export class OfflineKeys {
  readonly userId: string;
  readonly method: UnlockMethod;
  #cache: CryptoKey | null;
  #drafts: CryptoKey | null;
  #index: CryptoKey | null;
  constructor(userId: string, method: UnlockMethod, cache: CryptoKey, drafts: CryptoKey, index: CryptoKey) {
    this.userId = userId;
    this.method = method;
    this.#cache = cache;
    this.#drafts = drafts;
    this.#index = index;
  }
  get locked(): boolean {
    return this.#cache === null;
  }
  get cache(): CryptoKey {
    if (!this.#cache) throw new LockedError();
    return this.#cache;
  }
  get drafts(): CryptoKey {
    if (!this.#drafts) throw new LockedError();
    return this.#drafts;
  }
  get index(): CryptoKey {
    if (!this.#index) throw new LockedError();
    return this.#index;
  }
  lock(): void {
    this.#cache = this.#drafts = this.#index = null;
  }
}

async function keysFromDataKey(userId: string, method: UnlockMethod, dataKey: Bytes): Promise<OfflineKeys> {
  const master = await importHkdf(dataKey);
  dataKey.fill(0);
  const [cache, drafts, index] = await Promise.all([
    derivePurposeKey(master, userId, 'cache'),
    derivePurposeKey(master, userId, 'drafts'),
    deriveIndexKey(master, userId),
  ]);
  return new OfflineKeys(userId, method, cache, drafts, index);
}

const WRAP = { purpose: 'wrap', slot: 'data-key' } as const;

const kekFromHkdf = (master: CryptoKey, userId: string, salt: Bytes, kind: string) =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(JSON.stringify([FORMAT, 'kek', kind, userId])) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

/* --------------------------------------------------------------- WebAuthn */

/** The two WebAuthn calls this module makes, injectable for tests. */
export interface WebAuthnLike {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

export function browserWebAuthn(): WebAuthnLike | null {
  if (typeof navigator === 'undefined' || !navigator.credentials || typeof PublicKeyCredential === 'undefined') return null;
  return {
    create: (o) => navigator.credentials.create(o),
    get: (o) => navigator.credentials.get(o),
  };
}

/**
 * Feature detection. `PublicKeyCredential` existing does not prove PRF works:
 * only a create/get round trip does, so setup re-checks and falls back to the PIN.
 */
export function passkeyMaybeSupported(w: WebAuthnLike | null = browserWebAuthn()): boolean {
  return w !== null;
}

type PrfOut = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } };
const extResults = (c: Credential | null): PrfOut => {
  const pk = c as (Credential & { getClientExtensionResults?: () => unknown }) | null;
  return (pk?.getClientExtensionResults?.() ?? {}) as PrfOut;
};
const toBytes = (b: ArrayBuffer | ArrayBufferView): Bytes =>
  (b instanceof ArrayBuffer ? new Uint8Array(b.slice(0)) : new Uint8Array((b as ArrayBufferView).buffer.slice((b as ArrayBufferView).byteOffset, (b as ArrayBufferView).byteOffset + (b as ArrayBufferView).byteLength))) as Bytes;

async function prfOutput(w: WebAuthnLike, credentialId: Bytes, prfSalt: Bytes): Promise<Bytes> {
  let cred: Credential | null;
  try {
    cred = await w.get({
      publicKey: {
        challenge: randomBytes(32), // local use only: the authenticator is a PRF oracle, there is no server to verify a signature
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch {
    throw new UnlockError('passkey-cancelled');
  }
  const first = extResults(cred).prf?.results?.first;
  if (!first) throw new UnlockError('prf-unsupported', 'This passkey or browser does not provide the PRF extension.');
  return toBytes(first);
}

/* ----------------------------------------------------------------- store */

export async function getUnlockRecord(store: KvStore, userId: string): Promise<UnlockRecord | null> {
  const key = recordKey(await userToken(userId));
  const raw = await store.get(key);
  if (raw === undefined) return null;
  const r = raw as UnlockRecord;
  if (!r || r.v !== 1 || r.method !== 'passkey' || !r.passkey) {
    await store.delete(key); // not a passkey record: never usable, removed
    return null;
  }
  if (r.userId !== userId || typeof r.salt !== 'string' || !r.wrapped) throw new UnlockError('bad-record');
  return r;
}

/** User ids with a passkey unlock record on this device. Records of any other kind are removed. */
export async function listUnlockUsers(store: KvStore): Promise<Array<{ userId: string; method: UnlockMethod }>> {
  const out: Array<{ userId: string; method: UnlockMethod }> = [];
  for (const k of await store.keys('unlock/')) {
    const r = (await store.get(k)) as UnlockRecord | undefined;
    if (r && r.v === 1 && r.method === 'passkey' && r.passkey && typeof r.userId === 'string') out.push({ userId: r.userId, method: 'passkey' });
    else await store.delete(k);
  }
  return out;
}

async function writeRecord(
  store: KvStore,
  userId: string,
  base: Omit<UnlockRecord, 'wrapped' | 'v' | 'userId' | 'createdAt' | 'salt'>,
  salt: Bytes,
  kek: CryptoKey,
): Promise<OfflineKeys> {
  const dataKey = randomBytes(32);
  const wrapped = await seal(kek, userId, WRAP.purpose, WRAP.slot, dataKey);
  const rec: UnlockRecord = { v: 1, userId, createdAt: new Date().toISOString(), salt: b64uEncode(salt), ...base, wrapped };
  await store.put(recordKey(await userToken(userId)), rec);
  return keysFromDataKey(userId, base.method, dataKey);
}

async function guardNew(store: KvStore, userId: string) {
  if (await getUnlockRecord(store, userId)) throw new UnlockError('already-set-up');
}

export async function setupWithPasskey(
  store: KvStore,
  userId: string,
  opts: { webauthn?: WebAuthnLike | null; rpName?: string } = {},
): Promise<OfflineKeys> {
  const w = opts.webauthn === undefined ? browserWebAuthn() : opts.webauthn;
  if (!w) throw new UnlockError('prf-unsupported', 'Passkeys are not available in this browser.');
  await guardNew(store, userId);
  const prfSalt = randomBytes(32);
  let created: Credential | null;
  try {
    created = await w.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: opts.rpName ?? 'MECON Reader' },
        user: { id: utf8(await userToken(userId)), name: 'MECON Reader offline unlock', displayName: 'MECON Reader offline unlock' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 60_000,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch {
    throw new UnlockError('passkey-cancelled');
  }
  if (!created) throw new UnlockError('passkey-cancelled');
  if (extResults(created).prf?.enabled === false) throw new UnlockError('prf-unsupported', 'This passkey does not support the PRF extension.');
  const credentialId = toBytes((created as PublicKeyCredential).rawId);
  const out = await prfOutput(w, credentialId, prfSalt);
  const salt = randomBytes(16);
  const kek = await kekFromHkdf(await importHkdf(out), userId, salt, 'passkey');
  out.fill(0);
  return writeRecord(
    store,
    userId,
    { method: 'passkey', passkey: { credentialId: b64uEncode(credentialId), prfSalt: b64uEncode(prfSalt) } },
    salt,
    kek,
  );
}

export async function unlockWithPasskey(store: KvStore, userId: string, opts: { webauthn?: WebAuthnLike | null } = {}): Promise<OfflineKeys> {
  const rec = await getUnlockRecord(store, userId);
  if (!rec || rec.method !== 'passkey' || !rec.passkey) throw new UnlockError('no-record');
  const w = opts.webauthn === undefined ? browserWebAuthn() : opts.webauthn;
  if (!w) throw new UnlockError('prf-unsupported', 'Passkeys are not available in this browser.');
  const out = await prfOutput(w, b64uDecode(rec.passkey.credentialId), b64uDecode(rec.passkey.prfSalt));
  const kek = await kekFromHkdf(await importHkdf(out), userId, b64uDecode(rec.salt), 'passkey');
  out.fill(0);
  try {
    const dataKey = await open(kek, userId, WRAP.purpose, WRAP.slot, rec.wrapped);
    return await keysFromDataKey(userId, 'passkey', dataKey);
  } catch (e) {
    if (e instanceof CryptoFailure) throw new UnlockError('wrong-credential', 'This passkey did not unlock the cache.');
    throw e;
  }
}

export type SetupResult =
  | { status: 'ready'; keys: OfflineKeys; method: UnlockMethod }
  | { status: 'unsupported'; note: string };

export const PASSKEY_REQUIRED_NOTE =
  "Offline access needs a passkey this browser can't provide here; the Reader works online only on this device.";

/**
 * Sets up the passkey unlock. When PRF is not supported (or the passkey step is
 * cancelled) nothing is stored and no offline cache is opened.
 */
export async function setupUnlock(store: KvStore, userId: string, opts: { webauthn?: WebAuthnLike | null } = {}): Promise<SetupResult> {
  try {
    const keys = await setupWithPasskey(store, userId, { webauthn: opts.webauthn });
    return { status: 'ready', keys, method: 'passkey' };
  } catch (e) {
    if (e instanceof UnlockError && e.code === 'prf-unsupported') return { status: 'unsupported', note: PASSKEY_REQUIRED_NOTE };
    if (e instanceof UnlockError && e.code === 'passkey-cancelled') return { status: 'unsupported', note: 'The passkey step was cancelled, so offline access was not set up.' };
    throw e;
  }
}

/** Whether the passkey PRF path could be tried here (API present). Real support is confirmed at setup. */
export const describeUnlockOptions = (w: WebAuthnLike | null = browserWebAuthn()) => ({ passkey: passkeyMaybeSupported(w) });

/* ------------------------------------------------------------------ idle */

export interface IdleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: IdleTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Locks after `timeoutMs` without `touch()`. Call `touch()` on user activity. */
export class IdleLock {
  #handle: unknown = null;
  constructor(
    private readonly timeoutMs: number,
    private readonly onLock: () => void,
    private readonly timers: IdleTimers = realTimers,
  ) {}
  touch(): void {
    if (this.#handle !== null) this.timers.clear(this.#handle);
    this.#handle = this.timers.set(() => {
      this.#handle = null;
      this.onLock();
    }, this.timeoutMs);
  }
  stop(): void {
    if (this.#handle !== null) this.timers.clear(this.#handle);
    this.#handle = null;
  }
}

