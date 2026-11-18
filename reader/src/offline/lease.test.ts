// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeaseKey } from '../api/types';
import { b64uDecode, b64uEncode } from './bytes';
import { MAX_LEASE_MS, ed25519Supported, evaluateLease, needsRenewal, permits, resetEd25519Probe } from './lease';
import { DAY, T0, iso, leasePayload, makeSigner } from './testkit';

const ctx = (now: number, extra: { userId?: string; clockMark?: number } = {}) => ({ userId: 'usr_a', now, ...extra });

describe('lease verification', () => {
  it('a good lease is valid', async () => {
    const s = await makeSigner();
    const r = await evaluateLease(await s.sign(leasePayload()), [s.key], ctx(T0 + DAY));
    expect(r).toMatchObject({ state: 'valid', reason: 'ok' });
    expect(r.payload?.lease_id).toBe('lease_t1');
  });

  it('an expired lease is expired, and keeps its payload for the read-only message', async () => {
    const s = await makeSigner();
    const r = await evaluateLease(await s.sign(leasePayload()), [s.key], ctx(T0 + 7 * DAY));
    expect(r).toMatchObject({ state: 'expired', reason: 'past-expiry' });
  });

  it('no lease is missing', async () => {
    const s = await makeSigner();
    expect(await evaluateLease(null, [s.key], ctx(T0))).toMatchObject({ state: 'missing' });
  });

  it('a bad signature is refused', async () => {
    const s = await makeSigner();
    const token = await s.sign(leasePayload());
    const [body, sig] = token.split('.') as [string, string];
    const bytes = b64uDecode(sig);
    bytes[0] = bytes[0]! ^ 1;
    expect(await evaluateLease(`${body}.${b64uEncode(bytes)}`, [s.key], ctx(T0))).toMatchObject({ state: 'invalid-signature', reason: 'bad-signature' });
  });

  it('a payload edited after signing is refused (a longer expiry, say)', async () => {
    const s = await makeSigner();
    const token = await s.sign(leasePayload());
    const [body, sig] = token.split('.') as [string, string];
    const edited = new TextDecoder().decode(b64uDecode(body)).replace('2030-01-08', '2030-01-09');
    const forged = `${b64uEncode(new TextEncoder().encode(edited))}.${sig}`;
    expect(await evaluateLease(forged, [s.key], ctx(T0))).toMatchObject({ state: 'invalid-signature', reason: 'bad-signature' });
  });

  it('a lease signed by another key is refused even when its key_id is listed', async () => {
    const real = await makeSigner('key_test_1');
    const other = await makeSigner('key_test_1');
    expect(await evaluateLease(await other.sign(leasePayload()), [real.key], ctx(T0))).toMatchObject({ reason: 'bad-signature' });
  });

  it('an unknown key_id is refused', async () => {
    const s = await makeSigner('key_test_1');
    const token = await s.sign(leasePayload({ key_id: 'key_other' }));
    expect(await evaluateLease(token, [s.key], ctx(T0))).toMatchObject({ state: 'invalid-signature', reason: 'unknown-key' });
  });

  it('a key not valid at issue time is refused', async () => {
    const s = await makeSigner('key_test_1', { not_before: iso(T0 + DAY) });
    expect(await evaluateLease(await s.sign(leasePayload()), [s.key], ctx(T0 + 2 * DAY))).toMatchObject({ reason: 'key-not-valid-at-issue' });
    const retired = await makeSigner('key_test_1', { status: 'retired', not_after: iso(T0 - DAY) });
    expect(await evaluateLease(await retired.sign(leasePayload()), [retired.key], ctx(T0))).toMatchObject({ reason: 'key-not-valid-at-issue' });
  });

  it('more than 7 days is refused even with a good signature; exactly 7 days is accepted', async () => {
    const s = await makeSigner();
    expect(MAX_LEASE_MS).toBe(7 * DAY);
    const long = await evaluateLease(await s.sign(leasePayload({ lifeMs: 7 * DAY + 1000 })), [s.key], ctx(T0));
    expect(long).toMatchObject({ state: 'invalid-signature', reason: 'lifetime-exceeds-7-days', payload: null });
    const huge = await evaluateLease(await s.sign(leasePayload({ lifeMs: 365 * DAY })), [s.key], ctx(T0));
    expect(huge.state).toBe('invalid-signature');
    expect((await evaluateLease(await s.sign(leasePayload({ lifeMs: 7 * DAY })), [s.key], ctx(T0))).state).toBe('valid');
  });

  it('a lease for another user is refused', async () => {
    const s = await makeSigner();
    expect(await evaluateLease(await s.sign(leasePayload({ user_id: 'usr_b' })), [s.key], ctx(T0))).toMatchObject({ reason: 'user-mismatch' });
  });

  it('malformed tokens and payloads are refused without throwing', async () => {
    const s = await makeSigner();
    for (const t of ['x', 'a.b.c', '!!.??', `${b64uEncode(new TextEncoder().encode('not json'))}.AAAA`]) {
      expect((await evaluateLease(t, [s.key], ctx(T0))).state).toBe('invalid-signature');
    }
    // Validly signed but the wrong shape.
    expect(await evaluateLease(await s.sign({ key_id: 'key_test_1', hello: 1 }), [s.key], ctx(T0))).toMatchObject({ reason: 'malformed' });
    expect(await evaluateLease(await s.sign(leasePayload({ identities: [{ identity_id: 'i', operations: ['root' as never] }] })), [s.key], ctx(T0))).toMatchObject({ reason: 'malformed' });
  });

  it('rolling the device clock back cannot extend a lease past what the device already saw', async () => {
    const s = await makeSigner();
    const token = await s.sign(leasePayload());
    // The device saw day 8, then its clock was set back to day 2.
    const r = await evaluateLease(token, [s.key], ctx(T0 + 2 * DAY, { clockMark: T0 + 8 * DAY }));
    expect(r.state).toBe('expired');
    // A local clock before issue time does not make the lease younger than its own issue time.
    expect((await evaluateLease(token, [s.key], ctx(T0 - 30 * DAY))).state).toBe('valid');
  });

  it('verifies the contract fixture with the contract fixture key (TEST-ONLY keypair)', async () => {
    const dir = resolve(import.meta.dirname, '../../../contracts/reader-api/v1');
    const issued = JSON.parse(readFileSync(resolve(dir, 'fixtures/lease-issued.json'), 'utf8')) as { lease: string };
    const keys = JSON.parse(readFileSync(resolve(dir, 'fixtures/lease-keys.json'), 'utf8')) as { keys: LeaseKey[] };
    const r = await evaluateLease(issued.lease, keys.keys, { userId: 'usr_synthetic_alice', now: Date.parse('2030-01-02T00:00:00Z') });
    expect(r).toMatchObject({ state: 'valid', reason: 'ok' });
    expect(r.payload?.identities[0]?.operations).toEqual(['receive', 'send.direct', 'send.channel']);
    expect((await evaluateLease(issued.lease, keys.keys, { userId: 'usr_synthetic_alice', now: Date.parse('2030-01-08T00:00:00Z') })).state).toBe('expired');
  });
});

describe('Ed25519 not supported', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetEd25519Probe();
  });

  it('is reported as unsupported, with a message that offline sends are not permitted', async () => {
    const s = await makeSigner();
    const token = await s.sign(leasePayload());
    resetEd25519Probe();
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new DOMException('nope', 'NotSupportedError'));
    expect(await ed25519Supported(true)).toBe(false);
    const r = await evaluateLease(token, [s.key], ctx(T0));
    expect(r).toMatchObject({ state: 'unsupported', reason: 'ed25519-unsupported' });
    expect(r.message).toMatch(/offline sending is not permitted/);
    expect(permits(r, { op: 'send.direct', identityId: 'idn_a', deviceId: 'dev_1' }, ctx(T0)).allowed).toBe(false);
  });
});

describe('permits()', () => {
  const lease = async (p = leasePayload()) => {
    const s = await makeSigner();
    return evaluateLease(await s.sign(p), [s.key], ctx(T0 + DAY));
  };
  const q = (over: Partial<Parameters<typeof permits>[1]> = {}) => ({ op: 'send.direct' as const, identityId: 'idn_a', deviceId: 'dev_1', ...over });

  it('allows exactly the operations granted, per identity', async () => {
    const l = await lease();
    const now = { now: T0 + DAY };
    expect(permits(l, q({ op: 'receive' }), now).allowed).toBe(true);
    expect(permits(l, q({ op: 'send.direct' }), now).allowed).toBe(true);
    expect(permits(l, q({ op: 'send.channel' }), now).allowed).toBe(false); // idn_a has no send.channel
    expect(permits(l, q({ identityId: 'idn_b', op: 'receive' }), now).allowed).toBe(true);
    expect(permits(l, q({ identityId: 'idn_b', op: 'send.direct' }), now).allowed).toBe(false); // idn_b is receive only
    expect(permits(l, q({ identityId: 'idn_unknown' }), now).allowed).toBe(false);
  });

  it('allows only assigned devices', async () => {
    const l = await lease();
    expect(permits(l, q({ deviceId: 'dev_2' }), { now: T0 + DAY }).allowed).toBe(false);
  });

  it('send.channel needs the channel on the lease when one is named', async () => {
    const l = await lease(leasePayload({ identities: [{ identity_id: 'idn_a', operations: ['send.channel'] }] }));
    const now = { now: T0 + DAY };
    expect(permits(l, q({ op: 'send.channel', channelId: 'chn_1' }), now).allowed).toBe(true);
    expect(permits(l, q({ op: 'send.channel', channelId: 'chn_x' }), now).allowed).toBe(false);
  });

  it('stops permitting the moment the clock passes expiry, even for a lease that was valid when loaded', async () => {
    const l = await lease();
    expect(permits(l, q(), { now: T0 + 7 * DAY - 1000 }).allowed).toBe(true);
    expect(permits(l, q(), { now: T0 + 7 * DAY }).allowed).toBe(false);
    expect(permits(l, q(), { now: T0 + 2 * DAY, clockMark: T0 + 9 * DAY }).allowed).toBe(false);
  });

  it('never permits without a valid lease', async () => {
    const s = await makeSigner();
    const expired = await evaluateLease(await s.sign(leasePayload()), [s.key], ctx(T0 + 8 * DAY));
    expect(permits(expired, q(), { now: T0 }).allowed).toBe(false);
    expect(permits(await evaluateLease(null, [], ctx(T0)), q(), { now: T0 }).allowed).toBe(false);
  });

  it('asks for renewal at half life', async () => {
    const l = await lease();
    expect(needsRenewal(l, T0 + DAY)).toBe(false);
    expect(needsRenewal(l, T0 + 4 * DAY)).toBe(true);
    expect(needsRenewal(await evaluateLease(null, [], ctx(T0)), T0)).toBe(true);
  });
});
