import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { installSim } from './bleSim';
import { mockLeaseBackend } from './leaseBackend';
import { mockMessagingBackend } from './messagingBackend';

// SIMULATED: the Backend is route mocks, the Companion is a fake navigator.bluetooth (no hardware, no RF).
// The browser, the production build and its CSP, IndexedDB, WebCrypto, the service worker, the offline
// switch and the virtual passkey are real Chromium.
const SIMULATED = 'SIMULATED — not hardware verified';
const ORIGIN = 'http://localhost:4173'; // WebAuthn needs a domain as relying party id, not 127.0.0.1
const OWN_KEY_PREFIX = '111111'; // the synthetic Companion's own public key starts 11 11 11
const SIM = { mecon: true };

async function addAuthenticator(page: Page, context: BrowserContext) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } as never,
  });
}

async function connectBluetooth(page: Page) {
  await page.getByRole('button', { name: 'Connect Bluetooth device' }).click();
  await expect(page.getByTestId('device-ble')).toContainText('Bluetooth device connected', { timeout: 15_000 });
}

/** Nothing to choose: Alice is found on the device by her key prefix, and the Reader says so. */
async function chooseAlice(page: Page) {
  await expect(page.getByTestId('device-destination')).toHaveText("Device contact: Alice Synthetic (a1a1a1), found by the contact's key prefix.");
  await expect(page.getByLabel('Device contact')).toHaveCount(0);
}

async function signedInAndCached(page: Page, context: BrowserContext, lease: Parameters<typeof mockLeaseBackend>[1] = {}) {
  await addAuthenticator(page, context);
  const msg = await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX });
  const be = Object.assign(await mockLeaseBackend(page, lease), { msg });
  await page.goto(`${ORIGIN}/settings`);
  await page.getByRole('button', { name: 'Set up with a passkey' }).click();
  await expect(page.getByText('Unlocked with a passkey')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => be.leaseRequests).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Chats' }).click();
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await expect(page.getByText('Hello from the peer')).toBeVisible();
  await page.waitForTimeout(1500); // the cache write (conversations, identities) is debounced
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  return be;
}

async function goOffline(page: Page, context: BrowserContext, be: { down: boolean }) {
  be.down = true;
  await context.setOffline(true);
  await page.reload();
}

test.describe(`${SIMULATED}: local sends from the Chats composer`, () => {
  test('online with a device: choose Bluetooth, send, accepted and the recipient ACK are shown; nothing goes to the Backend', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    const sim = await installSim(page, { sim: SIM });
    const msg = await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX });
    await page.goto('/chats');
    await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText('Hello from the peer')).toBeVisible();
    // Before a device is connected: Backend only, and the Reader says where it goes.
    await expect(page.getByText(/Sent through the Backend\./)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Bluetooth' })).toHaveCount(0);

    await connectBluetooth(page);
    await expect(page.getByRole('radio', { name: 'Backend' })).toBeChecked(); // the default while online
    await page.getByRole('radio', { name: 'Bluetooth' }).check();
    await chooseAlice(page);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello over bluetooth');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('Acknowledged by the recipient device')).toBeVisible();
    await expect(page.getByTestId('attempt-facts')).toHaveText('Device accepted: yes · Radio transmitted: not observed · Recipient ACK: yes');
    await expect(page.getByText('You · not yet in history · via Bluetooth')).toBeVisible();
    expect(await sim.sendWrites()).toBe(1);
    expect(msg.posts).toHaveLength(0);
    await page.screenshot({ path: 'e2e-artifacts/local-send-online-bluetooth-acked.png' });
    expect(violations).toEqual([]);
  });

  test('online, a lost notification: outcome unknown, exactly one device write, zero Backend POSTs, and no automatic resend or reroute', async ({ page }) => {
    const sim = await installSim(page, { sim: SIM });
    const msg = await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX });
    await page.goto('/chats');
    await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText('Hello from the peer')).toBeVisible();
    await connectBluetooth(page);
    await page.getByRole('radio', { name: 'Bluetooth' }).check();
    await chooseAlice(page);
    await page.evaluate(() => {
      (window as unknown as { __ble: { mock: { faults: { dropNextSendReply: boolean } } } }).__ble.mock.faults.dropNextSendReply = true;
    });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('lost reply');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('Outcome unknown — not resent')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(7000); // longer than any Reader timer: still nothing more
    expect(await sim.sendWrites()).toBe(1);
    expect(await sim.rfCount()).toBe(1); // the device did transmit; the Reader never learned it, and says unknown
    expect(msg.posts).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible();
    await page.screenshot({ path: 'e2e-artifacts/local-send-unknown.png' });
  });
});

test.describe(`${SIMULATED}: offline local sends are gated by the lease`, () => {
  test('offline with a valid lease: the device send is allowed, shows its facts, and the attempt survives a reload offline', async ({ page, context }) => {
    const sim = await installSim(page, { sim: SIM });
    const be = await signedInAndCached(page, context);
    await goOffline(page, context, be);
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByTestId('lease-line')).toContainText('Offline lease valid until');
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByRole('heading', { name: 'Through a device' })).toBeVisible();
    await expect(page.getByTestId('local-send-blocked')).toHaveCount(0);
    // Offline there is no Backend path to offer.
    await connectBluetooth(page);
    await expect(page.getByRole('radio', { name: 'Backend' })).toHaveCount(0);
    await expect(page.getByText(/Sent through the Bluetooth\./)).toBeVisible();
    await chooseAlice(page);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('offline hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Acknowledged by the recipient device')).toBeVisible();
    expect(await sim.sendWrites()).toBe(1);
    expect(be.msg.posts).toHaveLength(0);
    await page.screenshot({ path: 'e2e-artifacts/local-send-offline-lease-valid.png' });

    // A channel: this simulated device has no channel list, so no local path and no slot entry, offline either.
    await page.getByRole('button', { name: /Demo Channel/ }).click();
    await expect(page.getByTestId('local-unavailable-ble')).toContainText("Sending to a channel through a device needs the device's channel list");
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('to a channel');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(await sim.sendWrites()).toBe(1);

    // The attempt is in the encrypted cache with its path: after a reload and an unlock it is still there, nothing is sent again.
    await page.waitForTimeout(500);
    await page.reload();
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByText('You · via Bluetooth')).toBeVisible();
    await expect(page.getByText('Acknowledged by the recipient device')).toBeVisible();
    expect(await sim.totalWrites()).toBe(0); // the reloaded page has a fresh simulated device: nothing was written to it
  });

  test('offline with an expired lease: blocked and read-only, with the reason, and no way to write to a device', async ({ page, context }) => {
    const sim = await installSim(page, { sim: SIM });
    // Issued 7 days minus 6 s ago: valid when stored, expired six seconds later.
    const be = await signedInAndCached(page, context, { issuedOffsetMs: -(7 * 86_400_000 - 6000), lifeMs: 7 * 86_400_000 });
    await page.waitForTimeout(6500);
    await goOffline(page, context, be);
    await page.getByRole('button', { name: 'Unlock with passkey' }).click();
    await expect(page.getByTestId('read-only')).toContainText('Read-only');
    await page.getByRole('button', { name: /Demo Peer \(merged pair\)/ }).click();
    await expect(page.getByTestId('local-send-blocked')).toContainText('expired');
    await expect(page.getByText('Hello from the peer')).toBeVisible(); // still readable
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Send/ })).toHaveCount(0);
    expect(await sim.totalWrites()).toBe(0);
    await page.screenshot({ path: 'e2e-artifacts/local-send-offline-lease-expired.png' });
  });
});
