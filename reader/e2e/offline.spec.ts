import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mockLeaseBackend } from './leaseBackend';
import { mockMessagingBackend } from './messagingBackend';

// Backend is SIMULATED (route mocks); the browser, the production CSP, IndexedDB, WebCrypto
// (PBKDF2, AES-GCM, HKDF, Ed25519), the service worker and the offline switch are real Chromium.
const PIN = 'e2e-synthetic-pin-4821';
const SECRET_TEXT = 'Hello from the peer';

async function signedInAndCached(page: Page, context: BrowserContext, lease: Parameters<typeof mockLeaseBackend>[1] = {}) {
  await mockMessagingBackend(page);
  const be = await mockLeaseBackend(page, lease);
  await page.goto('/settings');
  await page.getByLabel(/Offline PIN/).fill(PIN);
  await page.getByRole('button', { name: 'Set up with a PIN' }).click();
  await expect(page.getByText('Unlocked with your PIN')).toBeVisible();
  await expect.poll(() => be.leaseRequests).toBeGreaterThan(0);
  await expect(page.getByText('Offline lease valid.')).toBeVisible();
  // Load a conversation while unlocked so the cache fills.
  await page.getByRole('link', { name: 'Chats' }).click();
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await expect(page.getByText(SECRET_TEXT)).toBeVisible();
  await page.waitForTimeout(1500); // the cache write is debounced
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  void context;
  return be;
}

/** Every value in the IndexedDB database, as one string. */
async function idbDump(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('mecon-reader-offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('kv', 'readonly');
          const all = tx.objectStore('kv').getAll();
          const keys = tx.objectStore('kv').getAllKeys();
          tx.oncomplete = () => resolve(JSON.stringify([keys.result, all.result]));
        };
      }),
  );
}

async function goOffline(page: Page, context: BrowserContext, be: { down: boolean }) {
  be.down = true;
  await context.setOffline(true);
  await page.reload();
}

test.describe('offline cache and lease (Backend simulated)', () => {
  test('PIN setup, offline reload shows only a locked shell, unlock shows cached history, no plaintext in IndexedDB', async ({ page, context }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    const be = await signedInAndCached(page, context);

    // Real browser storage holds no readable private content.
    const dump = await idbDump(page);
    for (const needle of [SECRET_TEXT, 'Demo Peer', 'Demo Channel', 'conv_demo_0001', PIN]) expect(dump).not.toContain(needle);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)))).not.toContain('Demo Peer');

    await goOffline(page, context, be);
    await expect(page.getByRole('heading', { name: 'Offline', exact: true })).toBeVisible();
    await expect(page.getByTestId('offline-banner')).toContainText('Offline and locked');
    // Locked: the account-independent shell only, no cached content.
    await expect(page.getByText('Demo Peer')).toHaveCount(0);
    await expect(page.getByText(SECRET_TEXT)).toHaveCount(0);

    await page.getByLabel('Offline PIN').fill('wrong-pin-000');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong PIN');
    await expect(page.getByText('Demo Peer')).toHaveCount(0);

    await page.getByLabel('Offline PIN').fill(PIN);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('lease-line')).toContainText('Offline lease valid until');
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText(SECRET_TEXT)).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveCount(0); // a valid lease: not read-only
    await page.screenshot({ path: 'e2e-artifacts/offline-unlocked-lease-valid.png' });

    // Lock again: the content goes away, and is not erased.
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByText(SECRET_TEXT)).toHaveCount(0);
    await expect(page.getByLabel('Offline PIN')).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('an expired lease shows read-only: history readable, nothing sendable', async ({ page, context }) => {
    // Lease issued 7 days minus 6 s ago: valid when stored, expired six seconds later.
    const be = await signedInAndCached(page, context, { issuedOffsetMs: -(7 * 86_400_000 - 6000), lifeMs: 7 * 86_400_000 });
    await page.waitForTimeout(6500);
    await goOffline(page, context, be);
    await page.getByLabel('Offline PIN').fill(PIN);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('read-only')).toContainText('Read-only');
    await expect(page.getByTestId('lease-line')).toContainText('expired');
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText(SECRET_TEXT)).toBeVisible(); // still readable
    await expect(page.getByRole('button', { name: /^Send/ })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.screenshot({ path: 'e2e-artifacts/offline-unlocked-lease-expired.png' });
  });

  test('reconnecting returns to the signed-in app, and the reload locks the cache again (keys live in memory only)', async ({ page, context }) => {
    const be = await signedInAndCached(page, context);
    await goOffline(page, context, be);
    await page.getByLabel('Offline PIN').fill(PIN);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('lease-line')).toBeVisible();
    be.down = false;
    await context.setOffline(false);
    await page.reload();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Offline access' })).toBeVisible();
    // A reload locks (keys live in memory only), so the user unlocks again to keep syncing.
    await expect(page.getByText('Offline data is locked on this device.')).toBeVisible();
  });

  test('passkey path (WebAuthn PRF) with a SIMULATED virtual authenticator', async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    let prf = true;
    try {
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } as never,
      });
    } catch {
      prf = false;
    }
    test.skip(!prf, 'This Chromium has no PRF virtual authenticator');
    await mockMessagingBackend(page);
    await mockLeaseBackend(page);
    // WebAuthn needs a domain as relying party id, so this test uses localhost rather than 127.0.0.1.
    await page.goto('http://localhost:4173/settings');
    await page.getByRole('button', { name: 'Set up with a passkey' }).click();
    await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Lock offline data' }).click();
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
  });
});
