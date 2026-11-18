// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { OfflineCache } from './cache';
import { OfflineGate, OfflineSendBlocked, computeMode, offlineSendGuard, registerGate } from './gate';
import { LeaseManager } from './leaseManager';
import { DAY, T0, fakePasskey, freshStore, leasePayload, makeSigner } from './testkit';
import { setupWithPasskey } from './unlock';

const Q = { op: 'send.direct' as const, identityId: 'idn_a', deviceId: 'dev_1' };

async function rig(now: { t: number }) {
  const store = await freshStore();
  const keys = await setupWithPasskey(store, 'usr_a', { webauthn: fakePasskey() });
  const opened = await OfflineCache.open(store, keys, { now: () => now.t });
  if (!opened.ok) throw new Error('quarantined');
  const cache = opened.cache;
  const signer = await makeSigner();
  const leases = new LeaseManager(cache, { now: () => now.t });
  const api = {
    listLeaseKeys: async () => ({ keys: [signer.key], as_of: '2030-01-01T00:00:00Z' }),
    createLease: async () => ({ lease: await signer.sign(leasePayload({ issuedMs: now.t })), expires_at: 'x' }),
  };
  return { cache, signer, leases, api, keys };
}

describe('lease manager', () => {
  it('fetches keys and a lease online, stores them encrypted, and verifies them offline later', async () => {
    const now = { t: T0 };
    const { leases, api, cache } = await rig(now);
    const r = await leases.refresh(api);
    expect(r.state).toBe('valid');
    // A fresh manager over the same cache (a reload, offline): no network needed.
    const again = new LeaseManager(cache, { now: () => now.t + DAY });
    expect((await again.load()).state).toBe('valid');
  });

  it('does not store a lease that fails verification, and keeps the good one', async () => {
    const now = { t: T0 };
    const { leases, api, signer } = await rig(now);
    await leases.refresh(api);
    now.t = T0 + 5 * DAY; // past half life: renewal is due
    const bad = { ...api, createLease: async () => ({ lease: await signer.sign(leasePayload({ issuedMs: now.t, lifeMs: 30 * DAY })), expires_at: 'x' }) };
    const r = await leases.refresh(bad);
    expect(r.state).toBe('valid');
    expect(r.payload?.issued_at).toBe('2030-01-01T00:00:00Z'); // still the old one
  });

  it('a Backend that issues no leases (404) leaves the Reader without one, truthfully', async () => {
    const now = { t: T0 };
    const { leases } = await rig(now);
    const api = {
      listLeaseKeys: async () => {
        throw new ApiError(404, { code: 'not_found' }, 'x');
      },
      createLease: async () => {
        throw new ApiError(404, { code: 'not_found' }, 'x');
      },
    };
    expect((await leases.refresh(api)).state).toBe('missing');
  });

  it('an unreachable Backend leaves the stored lease as it was', async () => {
    const now = { t: T0 };
    const { leases, api } = await rig(now);
    await leases.refresh(api);
    const down = {
      listLeaseKeys: async () => {
        throw new TypeError('network');
      },
      createLease: async () => {
        throw new TypeError('network');
      },
    };
    expect((await leases.refresh(down)).state).toBe('valid');
  });

  it('flips to expired as time passes (tick) and permits() follows at once', async () => {
    const now = { t: T0 };
    const { leases, api } = await rig(now);
    await leases.refresh(api);
    expect(leases.permits(Q).allowed).toBe(true);
    now.t = T0 + 7 * DAY + 1;
    expect(leases.permits(Q).allowed).toBe(false); // before tick: expiry is re-checked per call
    expect((await leases.tick()).state).toBe('expired');
  });

  it('rolling the clock back after expiry does not revive the lease (clock mark)', async () => {
    const now = { t: T0 };
    const { leases, api, cache } = await rig(now);
    await leases.refresh(api);
    now.t = T0 + 8 * DAY;
    await leases.tick(); // the device sees day 8
    now.t = T0 + DAY; // clock set back
    const fresh = new LeaseManager(cache, { now: () => now.t });
    expect((await fresh.load()).state).toBe('expired');
  });
});

describe('gating', () => {
  it('computes the four modes', () => {
    const lease = (state: 'valid' | 'expired') => ({ state, reason: 'ok', payload: null, expiresAtMs: null, message: 'm' }) as never;
    expect(computeMode({ online: true, unlocked: false, lease: null }).kind).toBe('online');
    expect(computeMode({ online: false, unlocked: false, lease: null }).kind).toBe('shell');
    expect(computeMode({ online: false, unlocked: true, lease: lease('valid') }).kind).toBe('offline-lease');
    expect(computeMode({ online: false, unlocked: true, lease: lease('expired') }).kind).toBe('offline-readonly');
    expect(computeMode({ online: false, unlocked: true, lease: null }).kind).toBe('offline-readonly');
  });

  it('online: the server is authoritative and the lease is not consulted', async () => {
    const g = new OfflineGate(true);
    expect(g.guard(Q)).toMatchObject({ allowed: true, basis: 'online-server' }); // no lease at all
    const now = { t: T0 };
    const { leases } = await rig(now);
    g.setLeases(leases); // a missing lease still does not matter online
    expect(g.guard(Q).allowed).toBe(true);
  });

  it('offline and locked: shell only, nothing readable, every send blocked', () => {
    const g = new OfflineGate(false);
    expect(g.mode().kind).toBe('shell');
    expect(g.canReadCache()).toBe(false);
    expect(g.guard(Q)).toMatchObject({ allowed: false, basis: 'locked' });
    expect(() => g.assertAllowed(Q)).toThrow(OfflineSendBlocked);
  });

  it('offline, unlocked, valid lease: readable, and exactly what the lease permits', async () => {
    const now = { t: T0 };
    const { leases, api } = await rig(now);
    await leases.refresh(api);
    const g = new OfflineGate(false);
    g.setLeases(leases);
    expect(g.mode().kind).toBe('offline-lease');
    expect(g.canReadCache()).toBe(true);
    expect(g.guard(Q)).toMatchObject({ allowed: true, basis: 'lease' });
    expect(g.guard({ ...Q, op: 'send.channel' }).allowed).toBe(false);
    expect(g.guard({ ...Q, identityId: 'idn_b' }).allowed).toBe(false);
    expect(g.guard({ ...Q, deviceId: 'dev_9' }).allowed).toBe(false);
    expect(() => g.assertAllowed({ ...Q, op: 'send.channel' })).toThrow(OfflineSendBlocked);
  });

  it('offline, unlocked, expired lease: readable but read-only, all outbound blocked', async () => {
    const now = { t: T0 };
    const { leases, api } = await rig(now);
    await leases.refresh(api);
    now.t = T0 + 7 * DAY;
    await leases.tick();
    const g = new OfflineGate(false);
    g.setLeases(leases);
    expect(g.mode()).toMatchObject({ kind: 'offline-readonly' });
    expect(g.canReadCache()).toBe(true);
    for (const op of ['receive', 'send.direct', 'send.channel'] as const) expect(g.guard({ ...Q, op }).allowed).toBe(false);
  });

  it('offline, unlocked, no lease or an unsupported browser: sends blocked', async () => {
    const now = { t: T0 };
    const { leases } = await rig(now);
    await leases.load();
    const g = new OfflineGate(false);
    g.setLeases(leases);
    expect(g.guard(Q)).toMatchObject({ allowed: false, basis: 'no-lease' });
  });

  it('the module-level guard that BLE and USB paths call follows the registered gate, and blocks offline when none is registered', async () => {
    const now = { t: T0 };
    const { leases, api } = await rig(now);
    await leases.refresh(api);
    const g = new OfflineGate(false);
    g.setLeases(leases);
    registerGate(g);
    try {
      expect(offlineSendGuard(Q).allowed).toBe(true);
      expect(offlineSendGuard({ ...Q, op: 'send.channel' }).allowed).toBe(false);
      g.setLeases(null); // locked
      expect(offlineSendGuard(Q).allowed).toBe(false);
    } finally {
      registerGate(null);
    }
    // No gate registered and the test runtime has no navigator.onLine: the default gate is offline here.
    expect(new OfflineGate(false).guard(Q).allowed).toBe(false);
  });
});

