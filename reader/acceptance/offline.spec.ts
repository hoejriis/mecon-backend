// Live check of the encrypted offline cache with a Backend-issued lease (Issue 24, rows OFF-06 and
// OFF-03 in the matrix, virtual authenticator only). Skipped unless ACCEPTANCE_SESSION_A holds the
// cookie value of test user A. The value is read from the environment only: never logged.
// Nothing here sends a message. Read-only apart from the lease request and the test user's own
// state. No message text, names or ids are logged or asserted: counts and states only.
//
// Signing out ends session A (the last step here, and authenticated.spec.ts does the same), so mint
// a fresh session for this file and run it alone: npm run acceptance -- offline.spec.ts
import { expect, test, type CDPSession } from '@playwright/test';
import { API, apiRouted, BASE_URL, COOKIE_NAME, sessionContext, type SessionBody } from './api';

const A = process.env.ACCEPTANCE_SESSION_A;
const DAY_MS = 86_400_000;

test.describe('offline cache with a Backend lease, signed in as test user A', () => {
  test.skip(!A, 'ACCEPTANCE_SESSION_A is not set');

  test('passkey setup, Backend lease, offline unlock shows the cache with no /api/ traffic, a removed credential never unlocks', async ({ browser, request }) => {
    test.skip(!(await apiRouted(request)), 'API not routed yet');
    const a = await sessionContext(A!);
    let csrf = '';
    const context = await browser.newContext();
    try {
      const sres = await a.get(`${API}/session`);
      test.skip(sres.status() === 401, 'session A is not valid (expired or already signed out); mint a fresh one');
      expect(sres.status()).toBe(200);
      const session = (await sres.json()) as SessionBody;
      csrf = session.csrf_token;
      test.skip(session.capabilities.messaging !== 'available', `messaging capability is "${session.capabilities.messaging}", not available: the cache has no conversations to hold (Backend capability reporting dependency)`);

      await context.addCookies([{ name: COOKIE_NAME, value: A!, url: BASE_URL, secure: true, httpOnly: true }]);
      const page = await context.newPage();

      // 1. Virtual authenticator with PRF.
      const cdp: CDPSession = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      let authenticatorId: string;
      try {
        ({ authenticatorId } = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } as never,
        })) as { authenticatorId: string });
      } catch {
        test.skip(true, 'this Chromium does not support hasPrf on a virtual authenticator');
        return;
      }

      // Count what the browser sends to /api/ from here on (counts only).
      let apiResponsesOffline = 0;
      let apiAttemptsOffline = 0;
      let offline = false;
      page.on('request', (r) => {
        if (offline && new URL(r.url()).pathname.startsWith('/api/')) apiAttemptsOffline += 1;
      });
      page.on('response', (r) => {
        if (offline && new URL(r.url()).pathname.startsWith('/api/')) apiResponsesOffline += 1;
      });

      // 2 + 3. Set up in Settings; the Reader asks the Backend for a lease and stores it.
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: 'Offline access' })).toBeVisible();
      const leaseResponse = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `${API}/leases`);
      await page.getByRole('button', { name: 'Set up with a passkey' }).click();
      const lr = await leaseResponse;
      expect(lr.status()).toBe(200);
      const expiresAt = ((await lr.json()) as { expires_at: string }).expires_at;
      const days = (Date.parse(expiresAt) - Date.now()) / DAY_MS;
      expect(days, 'lease lifetime in days').toBeGreaterThan(6.5);
      expect(days, 'lease lifetime in days').toBeLessThanOrEqual(7.01);
      await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Offline lease valid.')).toBeVisible();
      const stored = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open('mecon-reader-offline');
            open.onerror = () => resolve(-1);
            open.onsuccess = () => {
              const r = open.result.transaction('kv', 'readonly').objectStore('kv').count();
              r.onsuccess = () => resolve(r.result);
            };
          }),
      );
      expect(stored, 'records in the offline store').toBeGreaterThan(0);

      // Fill the cache read-only: open the first conversation while unlocked.
      await page.getByRole('link', { name: 'Chats' }).click();
      const first = page.locator('a[href^="/chats/c/"]').first();
      const conversations = await first.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      test.skip(!conversations, 'test user A has no conversation to cache (count: 0)');
      await first.click();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await page.waitForTimeout(2000); // the cache write is debounced
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

      // 4. Offline: reload, unlock with the passkey, cached shell and data render.
      offline = true;
      await context.setOffline(true);
      await page.reload();
      await expect(page.getByTestId('offline-banner')).toContainText('Offline and locked');
      await expect(page.locator('.conv-list button')).toHaveCount(0); // locked: no cached content
      await page.getByRole('button', { name: 'Unlock with passkey' }).click();
      const leaseLine = page.getByTestId('lease-line');
      await expect(leaseLine).toContainText('Offline lease valid until');
      const shown = await page.evaluate((iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), expiresAt);
      await expect(leaseLine).toContainText(shown);
      expect(await page.locator('.conv-list button').count(), 'cached conversations').toBeGreaterThan(0);
      await page.locator('.conv-list button').first().click();
      expect(await page.getByRole('list', { name: 'Cached messages' }).locator('li').count(), 'cached messages').toBeGreaterThan(0);
      await expect(page.getByTestId('read-only')).toHaveCount(0); // valid lease
      expect(apiResponsesOffline, 'responses from /api/ while offline').toBe(0);
      test.info().annotations.push({ type: 'api-attempts-offline', description: String(apiAttemptsOffline) });

      // 5. Lock, remove the credential, reload: the cache does not unlock, nothing is visible.
      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      await expect(page.locator('.conv-list button')).toHaveCount(0);
      const { credentials } = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })) as { credentials: Array<{ credentialId: string }> };
      expect(credentials.length, 'credentials on the virtual authenticator').toBeGreaterThan(0);
      for (const c of credentials) await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: c.credentialId });
      await page.reload();
      await page.getByRole('button', { name: 'Unlock with passkey' }).click();
      await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toBeVisible();
      await expect(page.getByTestId('lease-line')).toHaveCount(0);
      await expect(page.locator('.conv-list button')).toHaveCount(0);
      await expect(page.getByRole('list', { name: 'Cached messages' })).toHaveCount(0);
      expect(apiResponsesOffline, 'responses from /api/ while offline').toBe(0);
      offline = false;
      await context.setOffline(false);
    } finally {
      // 6. Clean up: clear this origin's site data (the encrypted cache), then sign out.
      try {
        await context.setOffline(false);
        const pages = context.pages();
        if (pages[0]) {
          const cdp = await context.newCDPSession(pages[0]);
          await cdp.send('Storage.clearDataForOrigin', { origin: new URL(BASE_URL).origin, storageTypes: 'all' });
        }
      } catch {
        /* the context may be gone; the origin is a throwaway browser profile anyway */
      }
      if (csrf) {
        const out = await a.post(`${API}/logout`, { headers: { 'X-CSRF-Token': csrf } });
        expect(out.status()).toBe(204);
      }
      await context.close();
      await a.dispose();
    }
  });
});
