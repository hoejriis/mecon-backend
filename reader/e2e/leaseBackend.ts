import { generateKeyPairSync, sign } from 'node:crypto';
import type { Page } from '@playwright/test';

const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

export interface LeaseBackend {
  /** While true every /api call fails like an unreachable Backend. */
  down: boolean;
  leaseRequests: number;
  /** Lease timing, relative to now (ms). Default: issued now, 7 days. */
  issuedOffsetMs: number;
  lifeMs: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Adds the M3 lease operations to a mocked Backend (register AFTER the
 * messaging mock so these handlers run first), signing with a throwaway keypair
 * made for this run. SIMULATED Backend: the real signer is private.
 */
export async function mockLeaseBackend(page: Page, opts: Partial<Pick<LeaseBackend, 'issuedOffsetMs' | 'lifeMs'>> = {}): Promise<LeaseBackend> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x as string;
  const state: LeaseBackend = { down: false, leaseRequests: 0, issuedOffsetMs: opts.issuedOffsetMs ?? 0, lifeMs: opts.lifeMs ?? 7 * 86_400_000 };
  const j = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/reader/v1/**', async (route) => {
    if (state.down) return route.abort('internetdisconnected');
    const path = new URL(route.request().url()).pathname.replace('/api/reader/v1', '');
    const m = route.request().method();
    if (m === 'GET' && path === '/leases/keys') {
      return route.fulfill(
        j({ keys: [{ key_id: 'key_e2e_throwaway', algorithm: 'Ed25519', public_key: x, status: 'active', not_before: '2020-01-01T00:00:00Z', not_after: null }], as_of: iso(Date.now()) }),
      );
    }
    if (m === 'POST' && path === '/leases') {
      state.leaseRequests += 1;
      const issued = Date.now() + state.issuedOffsetMs;
      const payload = {
        lease_id: `lease_e2e_${state.leaseRequests}`,
        user_id: 'usr_synthetic_alice',
        issued_at: iso(issued),
        expires_at: iso(issued + state.lifeMs),
        key_id: 'key_e2e_throwaway',
        contract_version: '1.0',
        identities: [{ identity_id: 'ident_demo_0001', operations: ['receive', 'send.direct'] }],
        devices: ['dev_demo_0001'],
        channels: ['chan_demo_0001'],
      };
      const body = Buffer.from(canon(payload), 'utf8');
      const sig = sign(null, Buffer.concat([Buffer.from('MECON-LEASE-1\0', 'latin1'), body]), privateKey);
      return route.fulfill(j({ lease: `${body.toString('base64url')}.${sig.toString('base64url')}`, expires_at: payload.expires_at }));
    }
    return route.fallback();
  });
  return state;
}
