/**
 * Record encryption and key separation for the offline cache.
 *
 * - Every record is sealed with AES-256-GCM under a fresh random 96-bit IV.
 * - The additional authenticated data (AAD) binds the record to its user, its
 *   purpose and its slot, so a record copied to another user, purpose or slot
 *   fails authentication even if a key were somehow shared.
 * - Per-user, per-purpose keys come from HKDF-SHA-256 over the unwrapped data
 *   key, with the user id and purpose in the `info` string.
 */
import { b64uDecode, b64uEncode, randomBytes, utf8, type Bytes } from './bytes';

export const FORMAT = 'mecon-reader/offline/v1';

/** `cache`: server-derived content (conversations, messages, lease). `drafts`: what the user wrote (drafts, send attempts). */
export type Purpose = 'cache' | 'drafts';

export interface Sealed {
  v: 1;
  /** 96-bit IV, base64url. Fresh for every seal. */
  iv: string;
  ct: string;
}

export class CryptoFailure extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'CryptoFailure';
  }
}

/** Unambiguous (JSON array) so no id can imitate another field. */
export const aadFor = (userId: string, purpose: string, slot: string): Bytes =>
  utf8(JSON.stringify([FORMAT, userId, purpose, slot]));

export async function seal(key: CryptoKey, userId: string, purpose: string, slot: string, plain: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(userId, purpose, slot) },
    key,
    plain as Bytes,
  );
  return { v: 1, iv: b64uEncode(iv), ct: b64uEncode(new Uint8Array(ct)) };
}

export async function open(key: CryptoKey, userId: string, purpose: string, slot: string, s: Sealed): Promise<Bytes> {
  try {
    if (!s || s.v !== 1 || typeof s.iv !== 'string' || typeof s.ct !== 'string') throw new CryptoFailure('bad record');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uDecode(s.iv), additionalData: aadFor(userId, purpose, slot) },
      key,
      b64uDecode(s.ct),
    );
    return new Uint8Array(plain) as Bytes;
  } catch (e) {
    if (e instanceof CryptoFailure) throw e;
    throw new CryptoFailure();
  }
}

export const sealJson = (key: CryptoKey, userId: string, purpose: string, slot: string, value: unknown) =>
  seal(key, userId, purpose, slot, utf8(JSON.stringify(value)));

export async function openJson<T>(key: CryptoKey, userId: string, purpose: string, slot: string, s: Sealed): Promise<T> {
  const bytes = await open(key, userId, purpose, slot, s);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new CryptoFailure('bad record');
  }
}

const HKDF_SALT = utf8(`${FORMAT}/hkdf-salt`);
const info = (kind: string, purpose: string, userId: string) => utf8(JSON.stringify([FORMAT, kind, purpose, userId]));

/** Master secret (random data key, or a passkey PRF output) as non-extractable HKDF key material. */
export const importHkdf = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as Bytes, 'HKDF', false, ['deriveKey', 'deriveBits']);

export function derivePurposeKey(master: CryptoKey, userId: string, purpose: Purpose): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: info('aes-gcm-key', purpose, userId) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** HMAC key that turns record ids into opaque slot names, so the store's key names reveal no conversation or draft ids. */
export function deriveIndexKey(master: CryptoKey, userId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: info('hmac-index', 'index', userId) },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

export async function slotToken(indexKey: CryptoKey, kind: string, id: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', indexKey, utf8(JSON.stringify([kind, id])));
  return b64uEncode(new Uint8Array(mac).subarray(0, 16));
}

/** Short stable token for a user id, used in store key names. */
export async function userToken(userId: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', utf8(userId));
  return b64uEncode(new Uint8Array(d).subarray(0, 12));
}
