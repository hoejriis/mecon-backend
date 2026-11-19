import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mockLeaseBackend } from './leaseBackend';
import { mockMessagingBackend } from './messagingBackend';

// Backend is SIMULATED (route mocks); the browser, the production CSP, IndexedDB, WebCrypto
// (PBKDF2, AES-GCM, HKDF, Ed25519), the service worker and the offline switch are real Chromium.
const ORIGIN = 'http://localhost:4173'; // WebAuthn needs a domain as relying party id, not 127.0.0.1
const SECRET_TEXT = 'Hello from the peer';

async function addAuthenticator(page: Page, context: BrowserContext, hasPrf = true) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const added = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf } as never,
  })) as { authenticatorId: string };
  return { cdp, authenticatorId: added.authenticatorId };
}

async function signedInAndCached(page: Page, context: BrowserContext, lease: Parameters<typeof mockLeaseBackend>[1] = {}) {
  const auth = await addAuthenticator(page, context);
  const msg = await mockMessagingBackend(page);
  const be = Object.assign(await mockLeaseBackend(page, lease), { msg, auth });
  await page.goto(`${ORIGIN}/settings`);
  await page.getByRole('button', { name: 'Set up with a passkey' }).click();
  await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
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
  test('passkey setup, offline reload shows only a locked shell, unlock shows cached history, no plaintext in IndexedDB', async ({ page, context }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    const be = await signedInAndCached(page, context);

    // Real browser storage holds no readable private content.
    const dump = await idbDump(page);
    for (const needle of [SECRET_TEXT, 'Demo Peer', 'Demo Channel', 'conv_demo_0001']) expect(dump).not.toContain(needle);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)))).not.toContain('Demo Peer');

    await goOffline(page, context, be);
    await expect(page.getByRole('heading', { name: 'Offline', exact: true })).toBeVisible();
    await expect(page.getByTestId('offline-banner')).toContainText('Offline and locked');
    // Locked: the account-independent shell only, no cached content.
    await expect(page.getByText('Demo Peer')).toHaveCount(0);
    await expect(page.getByText(SECRET_TEXT)).toHaveCount(0);

    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByTestId('lease-line')).toContainText('Offline lease valid until');
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText(SECRET_TEXT)).toBeVisible();
    await expect(page.getByTestId('read-only')).toHaveCount(0); // a valid lease: not read-only
    await page.screenshot({ path: 'e2e-artifacts/offline-unlocked-lease-valid.png' });

    // Lock again: the content goes away, and is not erased.
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByText(SECRET_TEXT)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('an expired lease shows read-only: history readable, nothing sendable', async ({ page, context }) => {
    // Lease issued 7 days minus 6 s ago: valid when stored, expired six seconds later.
    const be = await signedInAndCached(page, context, { issuedOffsetMs: -(7 * 86_400_000 - 6000), lifeMs: 7 * 86_400_000 });
    await page.waitForTimeout(6500);
    await goOffline(page, context, be);
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
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
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByTestId('lease-line')).toBeVisible();
    be.down = false;
    await context.setOffline(false);
    await page.reload();
    await page.goto(`${ORIGIN}/settings`);
    await expect(page.getByRole('heading', { name: 'Offline access' })).toBeVisible();
    // A reload locks (keys live in memory only), so the user unlocks again to keep syncing.
    await expect(page.getByText('Offline data is locked on this device.')).toBeVisible();
  });

  test('an authenticator without PRF: no offline setup works, the cache never opens, and the Reader says so (SIMULATED authenticator)', async ({ page, context }) => {
    await addAuthenticator(page, context, false);
    await mockMessagingBackend(page);
    await mockLeaseBackend(page);
    await page.goto(`${ORIGIN}/settings`);
    await page.getByRole('button', { name: 'Set up with a passkey' }).click();
    await expect(page.getByRole('status').filter({ hasText: /passkey|offline access/i }).first()).toBeVisible();
    await expect(page.getByText('Unlocked with a passkey')).toHaveCount(0);
    const keys = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const open = indexedDB.open('mecon-reader-offline');
          open.onerror = () => resolve([]);
          open.onsuccess = () => {
            const r = open.result.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
            r.onsuccess = () => resolve(r.result as string[]);
          };
        }),
    );
    expect(keys).toEqual([]); // no unlock record, no schema marker, no cache
  });

  test('no WebAuthn at all: no setup option, only the online-only explanation', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    });
    await mockMessagingBackend(page);
    await mockLeaseBackend(page);
    await page.goto(`${ORIGIN}/settings`);
    await expect(page.getByText("Offline access needs a passkey this browser can't provide here; the Reader works online only on this device.")).toBeVisible();
    await expect(page.getByRole('button', { name: /Set up/ })).toHaveCount(0);
  });

  test('passkey path (WebAuthn PRF) with a SIMULATED virtual authenticator: lock and unlock again', async ({ page, context }) => {
    await addAuthenticator(page, context);
    await mockMessagingBackend(page);
    await mockLeaseBackend(page);
    await page.goto(`${ORIGIN}/settings`);
    await page.getByRole('button', { name: 'Set up with a passkey' }).click();
    await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Lock offline data' }).click();
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
  });

  test('an ambiguous send survives a reload: after unlock it shows as unknown in its conversation, and nothing is posted again', async ({ page, context }) => {
    const be = await signedInAndCached(page, context);
    be.msg.postMode = 'abort'; // the POST gets no usable answer: ambiguous
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('maybe sent');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Outcome unknown — not resent')).toBeVisible();
    await page.waitForTimeout(400); // the attempt is written through to the encrypted cache; the first same-attempt retry is 1.5 s away
    expect(be.msg.posts).toHaveLength(1);
    const attemptId = be.msg.posts[0]!.body.client_attempt_id;

    await page.reload(); // the in-memory attempt is gone; keys are gone too
    await page.goto(`${ORIGIN}/settings`);
    await expect(page.getByText('Offline data is locked on this device.')).toBeVisible();
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: 'Chats' }).click();
    await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText('Hello from the peer')).toBeVisible();
    await expect(page.getByText('Outcome unknown — not resent')).toBeVisible();
    await expect(page.getByText('maybe sent')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible();
    await page.screenshot({ path: 'e2e-artifacts/offline-rehydrated-unknown-attempt.png' });

    // Longer than the retry delays a live send would use: still the one POST, same attempt id.
    await page.waitForTimeout(7000);
    expect(be.msg.posts).toHaveLength(1);
    expect(be.msg.posts[0]!.body.client_attempt_id).toBe(attemptId);
  });

  test('a removed passkey credential: the cache stays locked and shows no content; offline, no request reaches /api/ (SIMULATED Backend)', async ({ page, context }) => {
    const be = await signedInAndCached(page, context);
    // Counts only, never content: responses that came back from /api/ while the browser was offline.
    let apiResponses = 0;
    let apiAttempts = 0;
    page.on('response', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) apiResponses += 1;
    });
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) apiAttempts += 1;
    });
    await goOffline(page, context, be);
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByTestId('lease-line')).toContainText('Offline lease valid until');
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText(SECRET_TEXT)).toBeVisible();
    expect(apiResponses).toBe(0);
    expect(be.leaseRequests).toBe(1); // no new lease request while offline
    test.info().annotations.push({ type: 'api-attempts-offline', description: String(apiAttempts) });

    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByText(SECRET_TEXT)).toHaveCount(0);

    // Remove the credential from the authenticator, reload, and try to unlock.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible();
    const { cdp, authenticatorId } = be.auth;
    const creds = ((await cdp.send('WebAuthn.getCredentials', { authenticatorId })) as { credentials: Array<{ credentialId: string }> }).credentials;
    expect(creds.length).toBeGreaterThan(0);
    for (const c of creds) await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: c.credentialId });
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible();
    await expect(page.getByTestId('lease-line')).toHaveCount(0);
    await expect(page.getByText('Demo Peer')).toHaveCount(0);
    await expect(page.getByText(SECRET_TEXT)).toHaveCount(0);
    expect(apiResponses).toBe(0);
  });
});
