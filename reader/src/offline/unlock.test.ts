// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from './bytes';
import { open, seal } from './crypto';
import {
  IdleLock,
  LockedError,
  PASSKEY_REQUIRED_NOTE,
  describeUnlockOptions,
  getUnlockRecord,
  listUnlockUsers,
  setupUnlock,
  setupWithPasskey,
  unlockWithPasskey,
} from './unlock';
import { OfflineSession } from './session';
import { fakePasskey, freshStore } from './testkit';

describe('passkey (WebAuthn PRF) unlock', () => {
  it('derives the KEK from the PRF output and unlocks again with the same passkey', async () => {
    const store = await freshStore();
    const pk = fakePasskey();
    const k1 = await setupWithPasskey(store, 'usr_a', { webauthn: pk });
    const sealed = await seal(k1.drafts, 'usr_a', 'drafts', 's', new Uint8Array([4]));
    const k2 = await unlockWithPasskey(store, 'usr_a', { webauthn: pk });
    expect(await open(k2.drafts, 'usr_a', 'drafts', 's', sealed)).toEqual(new Uint8Array([4]));
    const rec = (await getUnlockRecord(store, 'usr_a'))!;
    expect(rec.passkey!.credentialId).toBeTruthy();
    expect(Object.keys(rec).sort()).toEqual(['createdAt', 'method', 'passkey', 'salt', 'userId', 'v', 'wrapped']);
  });

  it('a different authenticator secret does not unlock', async () => {
    const store = await freshStore();
    await setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey({ secret: randomBytes(32) }) });
    await expect(unlockWithPasskey(store, 'usr_a', { webauthn: fakePasskey({ secret: randomBytes(32) }) })).rejects.toMatchObject({ code: 'wrong-credential' });
  });

  it('refuses to set up twice for one user, and lists only opaque ids', async () => {
    const store = await freshStore();
    await setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey() });
    await expect(setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey() })).rejects.toMatchObject({ code: 'already-set-up' });
    expect(await listUnlockUsers(store)).toEqual([{ userId: 'usr_a', method: 'passkey' }]);
  });
});

describe('no PRF: no offline cache', () => {
  for (const [name, w] of [
    ['PRF disabled at create', fakePasskey({ prf: 'disabled' })],
    ['no PRF result at get', fakePasskey({ prf: 'no-results' })],
    ['no WebAuthn at all', null],
  ] as const) {
    it(`${name}: no setup is offered, nothing is stored, and the cache never opens`, async () => {
      const store = await freshStore();
      expect(describeUnlockOptions(null)).toEqual({ passkey: false });
      const r = await setupUnlock(store, 'usr_a', { webauthn: w });
      expect(r).toEqual({ status: 'unsupported', note: expect.any(String) });
      expect(await store.keys('')).toEqual([]);
      const session = new OfflineSession({ store, webauthn: w });
      const s = await session.setup('usr_a');
      expect(s.status).toBe('unsupported');
      expect(session.cache).toBeNull();
      expect(session.keys).toBeNull();
      expect(await store.keys('')).toEqual([]); // not even the schema marker: OfflineCache.open was never called
    });
  }

  it('says why, truthfully', () => {
    expect(PASSKEY_REQUIRED_NOTE).toBe("Offline access needs a passkey this browser can't provide here; the Reader works online only on this device.");
  });

  it('a cancelled passkey prompt sets nothing up; other errors are not swallowed', async () => {
    const store = await freshStore();
    const cancel = { create: async () => Promise.reject(new Error('NotAllowedError')), get: async () => null };
    expect((await setupUnlock(store, 'usr_a', { webauthn: cancel })).status).toBe('unsupported');
    expect(await store.keys('')).toEqual([]);
  });
});

describe('records of any other kind never unlock', () => {
  const legacy = (userId: string) => ({
    v: 1,
    userId,
    method: 'pin',
    createdAt: 'x',
    salt: 'AAAAAAAAAAAAAAAAAAAAAA',
    pin: { kdf: 'PBKDF2-SHA-256', iterations: 600000 },
    wrapped: { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  });

  it('a stored non-passkey record is ignored and removed, and never unlocks', async () => {
    const store = await freshStore();
    await store.put('unlock/legacy1', legacy('usr_a'));
    expect(await listUnlockUsers(store)).toEqual([]);
    expect(await store.keys('unlock/')).toEqual([]);

    // Through getUnlockRecord as well, and through the session: no unlock of any kind.
    const { userToken } = await import('./crypto');
    await store.put(`unlock/${await userToken('usr_a')}`, legacy('usr_a'));
    expect(await getUnlockRecord(store, 'usr_a')).toBeNull();
    expect(await store.keys('unlock/')).toEqual([]);
    await store.put(`unlock/${await userToken('usr_a')}`, legacy('usr_a'));
    await expect(unlockWithPasskey(store, 'usr_a', { webauthn: fakePasskey() })).rejects.toMatchObject({ code: 'no-record' });
    expect(await store.keys('unlock/')).toEqual([]);
  });

  it('a passkey record is kept while a legacy one beside it is removed', async () => {
    const store = await freshStore();
    await setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey() });
    await store.put('unlock/other', legacy('usr_b'));
    expect(await listUnlockUsers(store)).toEqual([{ userId: 'usr_a', method: 'passkey' }]);
    expect(await store.get('unlock/other')).toBeUndefined();
  });

  it('after a legacy record is dropped, nothing opens a cache for that user', async () => {
    const store = await freshStore();
    const session = new OfflineSession({ store, webauthn: fakePasskey() });
    await store.put('unlock/x', legacy('usr_a'));
    expect(await session.hasSetup('usr_a')).toBeNull();
    expect(session.cache).toBeNull();
  });
});

describe('locking', () => {
  it('lock() drops the keys: nothing can be sealed or opened afterwards', async () => {
    const store = await freshStore();
    const k = await setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey() });
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
