/** Test helpers only (never imported by the app): fake IndexedDB, a fake passkey, and a Backend-stand-in lease signer. */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { LeaseKey, LeasePayload } from '../api/types';
import { b64uEncode, canonicalJson, concat, randomBytes, utf8 } from './bytes';
import { LEASE_SIGN_PREFIX } from './lease';
import { openIdbStore } from './idbStore';
import type { WebAuthnLike } from './unlock';

export async function freshStore() {
  return openIdbStore('test-db', new IDBFactory(), IDBKeyRange);
}

export interface FakePasskey extends WebAuthnLike {
  creates: number;
  gets: number;
}
/** A software authenticator: a fixed PRF secret per credential. `prf: 'none'` models a browser without PRF. */
export function fakePasskey(o: { prf?: 'ok' | 'disabled' | 'no-results' | 'absent-api'; secret?: Uint8Array } = {}): FakePasskey {
  const mode = o.prf ?? 'ok';
  const secret = o.secret ?? randomBytes(32);
  const rawId = randomBytes(16);
  const f: FakePasskey = {
    creates: 0,
    gets: 0,
    async create() {
      f.creates += 1;
      return {
        rawId: rawId.buffer,
        getClientExtensionResults: () => (mode === 'disabled' ? { prf: { enabled: false } } : { prf: { enabled: true } }),
      } as unknown as Credential;
    },
    async get(opts) {
      f.gets += 1;
      const first = (opts.publicKey?.extensions as { prf?: { eval?: { first: BufferSource } } } | undefined)?.prf?.eval?.first;
      if (mode === 'no-results' || !first) return { getClientExtensionResults: () => ({ prf: {} }) } as unknown as Credential;
      const mac = await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
        first,
      );
      return { getClientExtensionResults: () => ({ prf: { results: { first: mac } } }) } as unknown as Credential;
    },
  };
  return f;
}

export interface TestSigner {
  key: LeaseKey;
  /** Signs `payload` exactly as given (callers can make deliberately bad ones). */
  sign(payload: Record<string, unknown>): Promise<string>;
}

export async function makeSigner(keyId = 'key_test_1', extra: Partial<LeaseKey> = {}): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    key: {
      key_id: keyId,
      algorithm: 'Ed25519',
      public_key: b64uEncode(raw),
      status: 'active',
      not_before: '2020-01-01T00:00:00Z',
      not_after: null,
      ...extra,
    },
    async sign(payload) {
      const body = utf8(canonicalJson(payload));
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, concat(LEASE_SIGN_PREFIX, body));
      return `${b64uEncode(body)}.${b64uEncode(new Uint8Array(sig))}`;
    },
  };
}

export const DAY = 86_400_000;
export const T0 = Date.parse('2030-01-01T00:00:00Z');
export const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export function leasePayload(o: Partial<LeasePayload> & { issuedMs?: number; lifeMs?: number } = {}): LeasePayload {
  const { issuedMs, lifeMs, ...rest } = o;
  const issued = issuedMs ?? T0;
  return {
    lease_id: 'lease_t1',
    user_id: 'usr_a',
    issued_at: iso(issued),
    expires_at: iso(issued + (lifeMs ?? 7 * DAY)),
    key_id: 'key_test_1',
    contract_version: '1.0',
    identities: [
      { identity_id: 'idn_a', operations: ['receive', 'send.direct'] },
      { identity_id: 'idn_b', operations: ['receive'] },
    ],
    devices: ['dev_1'],
    channels: ['chn_1'],
    ...rest,
  };
}
