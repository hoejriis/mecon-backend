// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64uDecode, b64uEncode, randomBytes } from './bytes';
import { CryptoFailure, derivePurposeKey, importHkdf, open, openJson, seal, sealJson } from './crypto';

const aesKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

describe('record encryption', () => {
  it('round trips JSON and bytes', async () => {
    const k = await aesKey();
    const s = await sealJson(k, 'usr_a', 'cache', 'conv/x', { text: 'synthetic hello', n: [1, 2] });
    expect(await openJson(k, 'usr_a', 'cache', 'conv/x', s)).toEqual({ text: 'synthetic hello', n: [1, 2] });
    const raw = randomBytes(40);
    expect(await open(k, 'usr_a', 'cache', 's', await seal(k, 'usr_a', 'cache', 's', raw))).toEqual(raw);
  });

  it('uses a fresh IV for every record', async () => {
    const k = await aesKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) ivs.add((await seal(k, 'usr_a', 'cache', 's', new Uint8Array([1]))).iv);
    expect(ivs.size).toBe(50);
  });

  it('a tampered ciphertext fails', async () => {
    const k = await aesKey();
    const s = await seal(k, 'usr_a', 'cache', 's', new TextEncoder().encode('synthetic secret'));
    const ct = b64uDecode(s.ct);
    ct[0] = ct[0]! ^ 1;
    await expect(open(k, 'usr_a', 'cache', 's', { ...s, ct: b64uEncode(ct) })).rejects.toBeInstanceOf(CryptoFailure);
    const last = b64uDecode(s.ct);
    last[last.length - 1] = last[last.length - 1]! ^ 0x80; // the auth tag
    await expect(open(k, 'usr_a', 'cache', 's', { ...s, ct: b64uEncode(last) })).rejects.toBeInstanceOf(CryptoFailure);
  });

  it("another user's AAD fails even under the same key", async () => {
    const k = await aesKey();
    const s = await seal(k, 'usr_a', 'cache', 'conv/x', new Uint8Array([7]));
    await expect(open(k, 'usr_b', 'cache', 'conv/x', s)).rejects.toBeInstanceOf(CryptoFailure);
  });

  it('a record moved to another slot or purpose fails', async () => {
    const k = await aesKey();
    const s = await seal(k, 'usr_a', 'cache', 'conv/x', new Uint8Array([7]));
    await expect(open(k, 'usr_a', 'cache', 'conv/y', s)).rejects.toBeInstanceOf(CryptoFailure);
    await expect(open(k, 'usr_a', 'drafts', 'conv/x', s)).rejects.toBeInstanceOf(CryptoFailure);
  });

  it('keys are separated per user and per purpose by HKDF info', async () => {
    const master = await importHkdf(randomBytes(32));
    const a = await derivePurposeKey(master, 'usr_a', 'cache');
    const aDrafts = await derivePurposeKey(master, 'usr_a', 'drafts');
    const b = await derivePurposeKey(master, 'usr_b', 'cache');
    const s = await seal(a, 'usr_a', 'cache', 's', new Uint8Array([1]));
    await expect(open(aDrafts, 'usr_a', 'cache', 's', s)).rejects.toBeInstanceOf(CryptoFailure);
    await expect(open(b, 'usr_a', 'cache', 's', s)).rejects.toBeInstanceOf(CryptoFailure);
    expect(await open(a, 'usr_a', 'cache', 's', s)).toEqual(new Uint8Array([1]));
  });

  it('rejects malformed records without throwing anything but CryptoFailure', async () => {
    const k = await aesKey();
    await expect(open(k, 'usr_a', 'cache', 's', { v: 1, iv: '!!', ct: 'x' })).rejects.toBeInstanceOf(CryptoFailure);
    await expect(open(k, 'usr_a', 'cache', 's', null as never)).rejects.toBeInstanceOf(CryptoFailure);
  });
});
