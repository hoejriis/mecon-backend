/**
 * Local unlock for the offline cache.
 *
 * A random 256-bit data key protects the cache. It is stored only wrapped
 * (AES-GCM) by a key-encryption key (KEK) that exists only while unlocked:
 *
 *   passkey path  WebAuthn create/get with the PRF extension; the PRF output
 *                 goes through HKDF-SHA-256 to give the KEK. The PRF output
 *                 never leaves the authenticator unless the user verifies.
 *   PIN path      PBKDF2-HMAC-SHA-256, at least 600,000 iterations, random
 *                 per-user 16-byte salt, PIN of at least 6 characters. Argon2
 *                 is not in WebCrypto, so PBKDF2 is the strongest slow KDF a
 *                 strict-CSP page can use without shipping its own KDF code
 *                 (WASM needs 'wasm-unsafe-eval'; a JS Argon2 is far slower and
 *                 unreviewed). The iteration count is stored with the record so
 *                 it can be raised later; a record below the floor is refused.
 *
 * Nothing secret persists unwrapped: the store holds the wrapped data key, salts
 * and the credential id (all non-secret). The unwrapped data key lives only as a
 * non-extractable HKDF key in memory and is dropped on lock (sign-out, idle).
 * Per-user, per-purpose keys come from HKDF with the user id and purpose in `info`.
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

/** The PBKDF2 floor. A stored record below this is refused, and new records are never written below it. */
export const MIN_PBKDF2_ITERATIONS = 600_000;
export const PIN_PBKDF2_ITERATIONS = 600_000;
export const MIN_PIN_LENGTH = 6;
export const DEFAULT_IDLE_MS = 5 * 60_000;

export type UnlockMethod = 'pin' | 'passkey';

export type UnlockErrorCode =
  | 'pin-too-short'
  | 'wrong-credential'
  | 'prf-unsupported'
  | 'passkey-cancelled'
  | 'no-record'
  | 'weak-parameters'
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
  /** Random per-user salt (PBKDF2 salt for the PIN, HKDF salt for the passkey KEK). */
  salt: string;
  pin?: { kdf: 'PBKDF2-SHA-256'; iterations: number };
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

export const normalizePin = (pin: string): string => pin.normalize('NFKC');

export function checkPin(pin: string): void {
  if ([...normalizePin(pin)].length < MIN_PIN_LENGTH) {
    throw new UnlockError('pin-too-short', `The PIN needs at least ${MIN_PIN_LENGTH} characters.`);
  }
}

async function pinKek(pin: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8(normalizePin(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

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
  const raw = await store.get(recordKey(await userToken(userId)));
  if (raw === undefined) return null;
  const r = raw as UnlockRecord;
  if (!r || r.v !== 1 || r.userId !== userId || typeof r.salt !== 'string' || !r.wrapped) throw new UnlockError('bad-record');
  return r;
}

/** User ids that have an unlock record on this device (opaque ids; no names, no content). */
export async function listUnlockUsers(store: KvStore): Promise<Array<{ userId: string; method: UnlockMethod }>> {
  const out: Array<{ userId: string; method: UnlockMethod }> = [];
  for (const k of await store.keys('unlock/')) {
    const r = (await store.get(k)) as UnlockRecord | undefined;
    if (r && r.v === 1 && typeof r.userId === 'string' && (r.method === 'pin' || r.method === 'passkey')) {
      out.push({ userId: r.userId, method: r.method });
    }
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

export async function setupWithPin(store: KvStore, userId: string, pin: string): Promise<OfflineKeys> {
  checkPin(pin);
  await guardNew(store, userId);
  const salt = randomBytes(16);
  const kek = await pinKek(pin, salt, PIN_PBKDF2_ITERATIONS);
  return writeRecord(store, userId, { method: 'pin', pin: { kdf: 'PBKDF2-SHA-256', iterations: PIN_PBKDF2_ITERATIONS } }, salt, kek);
}

export async function unlockWithPin(store: KvStore, userId: string, pin: string): Promise<OfflineKeys> {
  const rec = await getUnlockRecord(store, userId);
  if (!rec || rec.method !== 'pin' || !rec.pin) throw new UnlockError('no-record');
  if (rec.pin.kdf !== 'PBKDF2-SHA-256' || !Number.isInteger(rec.pin.iterations) || rec.pin.iterations < MIN_PBKDF2_ITERATIONS) {
    throw new UnlockError('weak-parameters', 'The stored unlock parameters are below the minimum; refusing to use them.');
  }
  const kek = await pinKek(pin, b64uDecode(rec.salt), rec.pin.iterations);
  try {
    const dataKey = await open(kek, userId, WRAP.purpose, WRAP.slot, rec.wrapped);
    return await keysFromDataKey(userId, 'pin', dataKey);
  } catch (e) {
    if (e instanceof CryptoFailure) throw new UnlockError('wrong-credential', 'Wrong PIN.');
    throw e;
  }
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
  | { status: 'ready'; keys: OfflineKeys; method: UnlockMethod; fellBack: boolean; note: string | null }
  | { status: 'needs-pin'; note: string };

/**
 * Passkey first where asked and possible; otherwise the PIN. When a passkey is
 * wanted but PRF is not supported and no PIN was given, nothing is stored and the
 * caller is told to ask for a PIN.
 */
export async function setupUnlock(
  store: KvStore,
  userId: string,
  opts: { preferPasskey: boolean; pin?: string; webauthn?: WebAuthnLike | null },
): Promise<SetupResult> {
  let note: string | null = null;
  if (opts.preferPasskey) {
    try {
      const keys = await setupWithPasskey(store, userId, { webauthn: opts.webauthn });
      return { status: 'ready', keys, method: 'passkey', fellBack: false, note: null };
    } catch (e) {
      if (!(e instanceof UnlockError) || (e.code !== 'prf-unsupported' && e.code !== 'passkey-cancelled')) throw e;
      note =
        e.code === 'prf-unsupported'
          ? 'A passkey cannot protect the cache in this browser, so a PIN is used instead.'
          : 'The passkey step was cancelled, so a PIN is used instead.';
    }
    if (opts.pin === undefined) return { status: 'needs-pin', note: note! };
  }
  if (opts.pin === undefined) return { status: 'needs-pin', note: 'Choose a PIN to protect the offline cache.' };
  const keys = await setupWithPin(store, userId, opts.pin);
  return { status: 'ready', keys, method: 'pin', fellBack: opts.preferPasskey, note };
}

/** Whether the passkey PRF path could be tried here (API present). Real support is confirmed at setup. */
export const describeUnlockOptions = (w: WebAuthnLike | null = browserWebAuthn()) => ({
  passkey: passkeyMaybeSupported(w),
  pin: true,
});

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

