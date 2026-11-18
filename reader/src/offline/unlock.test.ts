// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { b64uEncode, randomBytes } from './bytes';
import { open, seal } from './crypto';
import {
  IdleLock,
  LockedError,
  MIN_PBKDF2_ITERATIONS,
  MIN_PIN_LENGTH,
  UnlockError,
  describeUnlockOptions,
  getUnlockRecord,
  listUnlockUsers,
  setupUnlock,
  setupWithPasskey,
  setupWithPin,
  unlockWithPasskey,
  unlockWithPin,
  type UnlockRecord,
} from './unlock';
import { fakePasskey, freshStore } from './testkit';

const PIN = 'synthetic-pin-482913';

describe('PIN unlock', () => {
  it('uses PBKDF2 at 600k+ iterations, a random per-user salt, and stores nothing unwrapped', async () => {
    const store = await freshStore();
    await setupWithPin(store, 'usr_a', PIN);
    await setupWithPin(store, 'usr_b', PIN);
    const a = (await getUnlockRecord(store, 'usr_a'))!;
    const b = (await getUnlockRecord(store, 'usr_b'))!;
    expect(a.pin).toEqual({ kdf: 'PBKDF2-SHA-256', iterations: expect.any(Number) });
    expect(a.pin!.iterations).toBeGreaterThanOrEqual(600_000);
    expect(MIN_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.salt.length).toBeGreaterThanOrEqual(21); // 16 bytes
    const dump = JSON.stringify(await Promise.all((await store.keys('')).map((k) => store.get(k))));
    expect(dump).not.toContain(PIN);
    // Exactly the documented, non-secret fields.
    expect(Object.keys(a).sort()).toEqual(['createdAt', 'method', 'pin', 'salt', 'userId', 'v', 'wrapped']);
  });

  it('unlocks with the right PIN into keys that open what the first unlock sealed', async () => {
    const store = await freshStore();
    const k1 = await setupWithPin(store, 'usr_a', PIN);
    const sealed = await seal(k1.cache, 'usr_a', 'cache', 's', new Uint8Array([9, 9]));
    const k2 = await unlockWithPin(store, 'usr_a', PIN);
    expect(await open(k2.cache, 'usr_a', 'cache', 's', sealed)).toEqual(new Uint8Array([9, 9]));
    expect(k2.method).toBe('pin');
  });

  it('a wrong PIN fails', async () => {
    const store = await freshStore();
    await setupWithPin(store, 'usr_a', PIN);
    const err = await unlockWithPin(store, 'usr_a', 'synthetic-pin-000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnlockError);
    expect((err as UnlockError).code).toBe('wrong-credential');
  });

  it('refuses a PIN shorter than the minimum, before anything is stored', async () => {
    const store = await freshStore();
    expect(MIN_PIN_LENGTH).toBe(6);
    await expect(setupWithPin(store, 'usr_a', '12345')).rejects.toMatchObject({ code: 'pin-too-short' });
    expect(await store.keys('')).toEqual([]);
    await setupWithPin(store, 'usr_a', '123456');
  });

  it('refuses a stored record whose iterations are below the floor (a downgrade)', async () => {
    const store = await freshStore();
    await setupWithPin(store, 'usr_a', PIN);
    const k = (await store.keys('unlock/'))[0]!;
    const rec = (await store.get(k)) as UnlockRecord;
    await store.put(k, { ...rec, pin: { kdf: 'PBKDF2-SHA-256', iterations: 1000 } });
    await expect(unlockWithPin(store, 'usr_a', PIN)).rejects.toMatchObject({ code: 'weak-parameters' });
  });

  it('refuses to set up twice for one user', async () => {
    const store = await freshStore();
    await setupWithPin(store, 'usr_a', PIN);
    await expect(setupWithPin(store, 'usr_a', PIN)).rejects.toMatchObject({ code: 'already-set-up' });
  });

  it('lists only opaque user ids and methods', async () => {
    const store = await freshStore();
    await setupWithPin(store, 'usr_a', PIN);
    expect(await listUnlockUsers(store)).toEqual([{ userId: 'usr_a', method: 'pin' }]);
  });
});

describe('passkey (WebAuthn PRF) unlock', () => {
  it('derives the KEK from the PRF output and unlocks again with the same passkey', async () => {
    const store = await freshStore();
    const pk = fakePasskey();
    const k1 = await setupWithPasskey(store, 'usr_a', { webauthn: pk });
    const sealed = await seal(k1.drafts, 'usr_a', 'drafts', 's', new Uint8Array([4]));
    const k2 = await unlockWithPasskey(store, 'usr_a', { webauthn: pk });
    expect(await open(k2.drafts, 'usr_a', 'drafts', 's', sealed)).toEqual(new Uint8Array([4]));
    expect((await getUnlockRecord(store, 'usr_a'))!.passkey!.credentialId).toBeTruthy();
  });

  it('a different authenticator secret does not unlock', async () => {
    const store = await freshStore();
    await setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey({ secret: randomBytes(32) }) });
    await expect(unlockWithPasskey(store, 'usr_a', { webauthn: fakePasskey({ secret: randomBytes(32) }) })).rejects.toMatchObject({
      code: 'wrong-credential',
    });
  });

  it('PRF unsupported falls back to the PIN (disabled at create)', async () => {
    const store = await freshStore();
    const r = await setupUnlock(store, 'usr_a', { preferPasskey: true, pin: PIN, webauthn: fakePasskey({ prf: 'disabled' }) });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.method).toBe('pin');
    expect(r.fellBack).toBe(true);
    expect(r.note).toMatch(/PIN is used instead/);
    expect((await getUnlockRecord(store, 'usr_a'))!.method).toBe('pin');
  });

  it('PRF unsupported falls back to the PIN (no result at get), and asks for a PIN when none was given', async () => {
    const store = await freshStore();
    const r = await setupUnlock(store, 'usr_a', { preferPasskey: true, webauthn: fakePasskey({ prf: 'no-results' }) });
    expect(r.status).toBe('needs-pin');
    expect(await store.keys('unlock/')).toEqual([]); // nothing half-stored
  });

  it('no WebAuthn at all falls back to the PIN', async () => {
    const store = await freshStore();
    expect(describeUnlockOptions(null)).toEqual({ passkey: false, pin: true });
    const r = await setupUnlock(store, 'usr_a', { preferPasskey: true, pin: PIN, webauthn: null });
    expect(r).toMatchObject({ status: 'ready', method: 'pin', fellBack: true });
  });

  it('a cancelled passkey prompt falls back as well, and a non-passkey error is not swallowed', async () => {
    const store = await freshStore();
    const cancel = { create: async () => Promise.reject(new Error('NotAllowedError')), get: async () => null };
    expect(await setupUnlock(store, 'usr_a', { preferPasskey: true, webauthn: cancel })).toMatchObject({ status: 'needs-pin' });
    await expect(setupUnlock(store, 'usr_a', { preferPasskey: false, pin: '1', webauthn: null })).rejects.toMatchObject({ code: 'pin-too-short' });
  });
});

describe('locking', () => {
  it('lock() drops the keys: nothing can be sealed or opened afterwards', async () => {
    const store = await freshStore();
    const k = await setupWithPin(store, 'usr_a', PIN);
    expect(k.locked).toBe(false);
    k.lock();
    expect(k.locked).toBe(true);
    expect(() => k.cache).toThrow(LockedError);
    expect(() => k.drafts).toThrow(LockedError);
    expect(() => k.index).toThrow(LockedError);
  });

  it('IdleLock fires after the timeout and activity postpones it', () => {
    vi.useFakeTimers();
    try {
      const onLock = vi.fn();
      const idle = new IdleLock(1000, onLock);
      idle.touch();
      vi.advanceTimersByTime(900);
      idle.touch();
      vi.advanceTimersByTime(900);
      expect(onLock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(onLock).toHaveBeenCalledTimes(1);
      idle.touch();
      idle.stop();
      vi.advanceTimersByTime(5000);
      expect(onLock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

void b64uEncode;
