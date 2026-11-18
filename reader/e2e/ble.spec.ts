import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from './backend';
import { installSim, SIM_LABEL } from './bleSim';

const T = (name: string) => `${SIM_LABEL}: ${name}`;

async function open(page: Page, opts: Parameters<typeof installSim>[1] = {}) {
  const sim = await installSim(page, opts);
  const backend = await mockBackend(page);
  backend.signedIn = true;
  await page.goto('/dev/ble');
  await expect(page.getByRole('heading', { name: 'BLE adapter (dev only)' })).toBeVisible();
  return sim;
}

const conn = (page: Page) => page.getByTestId('ble-conn');
const attempt = (page: Page, n = 0) => page.getByTestId('ble-attempts').locator('li').nth(n);
const fact = (page: Page, name: string, n = 0) => attempt(page, n).locator(`[data-fact="${name}"]`);
const connectBtn = (page: Page) => page.getByRole('button', { name: 'Connect Companion' });
const sendDm = (page: Page) => page.getByRole('button', { name: 'Send DM to first contact' });

async function connect(page: Page) {
  await connectBtn(page).click();
  await expect(conn(page)).toHaveText('connected');
  await expect(page.getByTestId('ble-hello')).toHaveText('complete');
}

test.describe('Android Chrome profile', () => {
  test(T('the browser reports an Android user agent and a mobile viewport'), async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => navigator.userAgent)).toMatch(/Android/);
    expect(page.viewportSize()!.width).toBeLessThan(500);
  });

  test(T('unsupported browser shows an explicit unsupported state and nothing else works'), async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'bluetooth', { value: undefined, configurable: true });
    });
    const backend = await mockBackend(page);
    backend.signedIn = true;
    await page.goto('/dev/ble');
    await expect(conn(page)).toHaveText('unsupported');
    await expect(page.getByRole('status').filter({ hasText: 'Web Bluetooth is not available' })).toBeVisible();
    await connectBtn(page).click();
    await expect(conn(page)).toHaveText('unsupported');
    await expect(page.getByTestId('ble-last-error')).toHaveText('none');
  });

  test(T('requestDevice without a user gesture is refused; a tap then works'), async ({ page }) => {
    const sim = await open(page);
    // Playwright's evaluate runs with a user gesture, so take the activation away explicitly.
    const res = await page.evaluate(() => {
      Object.defineProperty(navigator, 'userActivation', { value: { isActive: false, hasBeenActive: false }, configurable: true });
      return (window as unknown as { __bleAdapter: { connect(): Promise<unknown> } }).__bleAdapter.connect();
    });
    expect(res).toEqual({ ok: false, error: 'gesture_required' });
    await expect(conn(page)).toHaveText('denied');
    expect(await sim.totalWrites()).toBe(0);
    await page.evaluate(() => Reflect.deleteProperty(navigator, 'userActivation'));
    await connect(page);
  });

  test(T('user cancels the chooser, then permission denied, then success'), async ({ page }) => {
    await open(page);
    type W = { __ble: { mock: { faults: { requestDevice: string } } } };
    await page.evaluate(() => ((window as unknown as W).__ble.mock.faults.requestDevice = 'cancel'));
    await connectBtn(page).click();
    await expect(conn(page)).toHaveText('idle');
    await expect(page.getByTestId('ble-last-error')).toHaveText('chooser_cancelled');
    await page.evaluate(() => ((window as unknown as W).__ble.mock.faults.requestDevice = 'denied'));
    await connectBtn(page).click();
    await expect(conn(page)).toHaveText('denied');
    await page.evaluate(() => ((window as unknown as W).__ble.mock.faults.requestDevice = 'ok'));
    await connect(page);
  });

  test(T('connect timeout is reported and no command is written'), async ({ page }) => {
    const sim = await open(page);
    await page.evaluate(() => ((window as unknown as { __ble: { mock: { faults: { connect: string } } } }).__ble.mock.faults.connect = 'timeout'));
    await connectBtn(page).click();
    await expect(conn(page)).toHaveText('disconnected');
    await expect(page.getByTestId('ble-last-error')).toHaveText('connect_timeout');
    expect(await sim.totalWrites()).toBe(0);
  });

  test(T('connect, hello and contacts'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await expect(page.getByTestId('ble-self')).toHaveText('Synthetic Node');
    await expect(page.getByTestId('ble-contacts').locator('li')).toHaveText(['Alice Synthetic', 'Bob Synthetic']);
    expect(await sim.sendWrites()).toBe(0);
    await page.screenshot({ path: 'e2e-artifacts/ble-sim-connected.png' });
  });

  test(T('DM send with ACK shows accepted and ACK separately, RF transmitted not observed'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await sendDm(page).click();
    await expect(fact(page, 'deviceAccepted')).toHaveText('yes');
    await expect(fact(page, 'dmAck')).toHaveText('yes');
    await expect(fact(page, 'rfTransmitted')).toHaveText('not observed');
    await expect(fact(page, 'unknown')).toHaveText('no');
    expect(await sim.sendWrites()).toBe(1);
    await page.screenshot({ path: 'e2e-artifacts/ble-sim-dm-acked.png' });
  });

  test(T('DM send with a lost notification becomes unknown and is never written a second time'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await page.evaluate(() => ((window as unknown as { __ble: { mock: { faults: { dropNextSendReply: boolean } } } }).__ble.mock.faults.dropNextSendReply = true));
    await sendDm(page).click();
    await expect(fact(page, 'unknown')).toHaveText('yes');
    await expect(fact(page, 'deviceAccepted')).toHaveText('not observed');
    await expect(fact(page, 'dmAck')).toHaveText('not observed');
    expect(await sim.sendWrites()).toBe(1);
    expect(await sim.rfCount()).toBe(1); // the simulated radio did send; the app cannot know
    // The link was reset after the uncertain send; reconnecting must not replay it.
    await expect(conn(page)).toHaveText('disconnected');
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(conn(page)).toHaveText('connected');
    await page.waitForTimeout(800);
    expect(await sim.sendWrites()).toBe(1);
    await expect(page.getByTestId('ble-attempts').locator('li')).toHaveCount(1);
    await expect(fact(page, 'unknown')).toHaveText('yes');
    await page.screenshot({ path: 'e2e-artifacts/ble-sim-dm-unknown.png' });
  });

  test(T('disconnect mid-send is unknown; reconnect restores the link; a new tap is a new attempt'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await page.evaluate(() => ((window as unknown as { __ble: { mock: { faults: { disconnectOnSend: string | null } } } }).__ble.mock.faults.disconnectOnSend = 'after_device'));
    await sendDm(page).click();
    await expect(conn(page)).toHaveText('disconnected');
    await expect(fact(page, 'unknown')).toHaveText('yes');
    await page.evaluate(() => ((window as unknown as { __ble: { mock: { faults: { disconnectOnSend: string | null } } } }).__ble.mock.faults.disconnectOnSend = null));
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(conn(page)).toHaveText('connected');
    expect(await sim.sendWrites()).toBe(1);
    await sendDm(page).click();
    await expect(page.getByTestId('ble-attempts').locator('li')).toHaveCount(2);
    await expect(fact(page, 'deviceAccepted', 1)).toHaveText('yes');
    await expect(fact(page, 'unknown', 0)).toHaveText('yes');
    expect(await sim.sendWrites()).toBe(2);
  });

  test(T('duplicate notifications do not cause a second write'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await page.evaluate(() => ((window as unknown as { __ble: { mock: { faults: { duplicateNotifications: boolean } } } }).__ble.mock.faults.duplicateNotifications = true));
    await sendDm(page).click();
    await expect(fact(page, 'dmAck')).toHaveText('yes');
    await page.waitForTimeout(300);
    expect(await sim.sendWrites()).toBe(1);
  });

  test(T('background interruption drops the link; reconnect after foregrounding'), async ({ page }) => {
    await open(page);
    await connect(page);
    await page.evaluate(() => (window as unknown as { __ble: { simulateBackground(): void } }).__ble.simulateBackground());
    await expect(conn(page)).toHaveText('disconnected');
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
    await page.evaluate(() => (window as unknown as { __ble: { simulateForeground(): void } }).__ble.simulateForeground());
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(conn(page)).toHaveText('connected');
    await expect(page.getByTestId('ble-contacts').locator('li')).toHaveCount(2);
  });

  test(T('page reload loses all state; nothing is replayed or stored'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await sendDm(page).click();
    await expect(fact(page, 'deviceAccepted')).toHaveText('yes');
    await page.reload();
    await expect(conn(page)).toHaveText('idle');
    await expect(page.getByTestId('ble-attempts').locator('li')).toHaveCount(0);
    expect(await sim.sendWrites()).toBe(0); // the fake device is new after a reload too: nothing was resent
    const stored = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
    expect(stored).toEqual([0, 0]);
  });
});
