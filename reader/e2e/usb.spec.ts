import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from './backend';
import { installUsbSim, USB_SIM_LABEL, type Device } from './usbSim';

const T = (name: string) => `${USB_SIM_LABEL}: ${name}`;

async function open(page: Page, device: Device = 'companion', opts: Parameters<typeof installUsbSim>[1] = {}) {
  const sim = await installUsbSim(page, { device, ...opts });
  const backend = await mockBackend(page);
  backend.signedIn = true;
  await page.goto('/dev/usb');
  await expect(page.getByRole('heading', { name: 'USB device (dev only)' })).toBeVisible();
  return sim;
}
const link = (p: Page) => p.getByTestId('usb-link');
const phase = (p: Page) => p.getByTestId('usb-phase');
const attempt = (p: Page, n = 0) => p.getByTestId('usb-attempts').locator('li').nth(n);
const fact = (p: Page, name: string, n = 0) => attempt(p, n).locator(`[data-fact="${name}"]`);
const connectBtn = (p: Page) => p.getByRole('button', { name: 'Connect device' });
const sendDm = (p: Page) => p.getByRole('button', { name: 'Send DM to first contact' });
type W = { __serial: { faults: Record<string, unknown>; unplug(): void; replug(): void }; __mock: { faults: Record<string, unknown>; queueDirectFromAlice(t: string): void }; __peer: { faults: Record<string, unknown> } };
const setFault = (p: Page, where: '__serial' | '__mock', key: string, v: unknown) =>
  p.evaluate(([w, k, val]) => ((window as unknown as Record<string, { faults: Record<string, unknown> }>)[w as string]!.faults[k as string] = val), [where, key, v] as const);

async function connect(page: Page) {
  await connectBtn(page).click();
  await expect(phase(page)).toHaveText('ready');
  await expect(link(page)).toHaveText('connected');
}

test.describe('Desktop Chromium, fake Web Serial', () => {
  test(T('desktop user agent'), async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => navigator.userAgent)).not.toMatch(/Android|Mobile/);
  });

  test(T('browser without Web Serial shows an explicit unsupported state'), async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'serial', { value: undefined, configurable: true }));
    const backend = await mockBackend(page);
    backend.signedIn = true;
    await page.goto('/dev/usb');
    await expect(link(page)).toHaveText('unsupported');
    await expect(page.getByRole('status').filter({ hasText: 'Web Serial is not available' })).toBeVisible();
    await connectBtn(page).click();
    await expect(link(page)).toHaveText('unsupported');
  });

  test(T('user cancels the port chooser, then denies, then succeeds'), async ({ page }) => {
    const sim = await open(page);
    await setFault(page, '__serial', 'requestPort', 'cancel');
    await connectBtn(page).click();
    await expect(link(page)).toHaveText('idle');
    await expect(page.getByTestId('usb-last-error')).toHaveText('chooser_cancelled');
    await setFault(page, '__serial', 'requestPort', 'denied');
    await connectBtn(page).click();
    await expect(link(page)).toHaveText('denied');
    expect(await sim.openCalls()).toBe(0);
    await setFault(page, '__serial', 'requestPort', 'ok');
    await connect(page);
  });

  test(T('a busy port is shown as busy and is not retried by itself'), async ({ page }) => {
    const sim = await open(page);
    await setFault(page, '__serial', 'open', 'busy');
    await connectBtn(page).click();
    await expect(link(page)).toHaveText('busy');
    await expect(page.getByTestId('usb-last-error')).toHaveText('port_busy');
    await page.waitForTimeout(600);
    expect(await sim.openCalls()).toBe(1);
    await setFault(page, '__serial', 'open', 'ok');
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(phase(page)).toHaveText('ready');
  });

  test(T('MECON Companion: connect, identify, hello and contacts; no send command written'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await expect(page.getByTestId('usb-role')).toHaveText('companion');
    await expect(page.getByTestId('usb-summary')).toContainText('MECON firmware');
    await expect(page.getByTestId('usb-caps')).toContainText('message.send.direct');
    await expect(page.getByTestId('usb-contacts').locator('li')).toHaveText(['Alice Synthetic', 'Bob Synthetic']);
    expect(await sim.sendWrites()).toBe(0);
    await page.screenshot({ path: 'e2e-artifacts/usb-sim-connected.png' });
  });

  test(T('DM over USB: accepted and ACK shown separately, path usb, RF transmitted not observed'), async ({ page }) => {
    const sim = await open(page);
    await connect(page);
    await sendDm(page).click();
    await expect(fact(page, 'path')).toHaveText('usb');
    await expect(fact(page, 'deviceAccepted')).toHaveText('yes');
    await expect(fact(page, 'dmAck')).toHaveText('yes');
    await expect(fact(page, 'rfTransmitted')).toHaveText('not observed');
    await expect(fact(page, 'unknown')).toHaveText('no');
    expect(await sim.sendWrites()).toBe(1);
  });

  for (const when of ['before_device', 'after_device']) {
    test(T(`unplug mid-send (${when}): unknown, exactly one write, never resent after replug and reconnect`), async ({ page }) => {
      const sim = await open(page);
      await connect(page);
      await setFault(page, '__mock', 'disconnectOnSend', when);
      await sendDm(page).click();
      await expect(link(page)).toHaveText('unplugged');
      await expect(fact(page, 'unknown')).toHaveText('yes');
      await expect(fact(page, 'deviceAccepted')).toHaveText('not observed');
      expect(await sim.sendWrites()).toBe(1);
      await setFault(page, '__mock', 'disconnectOnSend', null);
      await page.evaluate(() => (window as unknown as W).__serial.replug());
      await page.waitForTimeout(500);
      expect(await sim.openCalls()).toBe(1); // no automatic reconnect
      await page.getByRole('button', { name: 'Reconnect' }).click();
      await expect(phase(page)).toHaveText('ready');
      await page.waitForTimeout(500);
      expect(await sim.sendWrites()).toBe(1);
      await expect(fact(page, 'unknown')).toHaveText('yes');
      await page.screenshot({ path: `e2e-artifacts/usb-sim-unplug-${when}.png` });
    });
  }

  test(T('garbage on the line, byte-at-a-time delivery and duplicate replies'), async ({ page }) => {
    const sim = await open(page, 'companion', { dev: { detect: { stepTimeoutMs: 1500, consoleWindowMs: 1500 }, companion: { responseTimeoutMs: 1500, connectTimeoutMs: 1500 } } });
    await page.evaluate(() => {
      (window as unknown as W).__peer.faults = { splitBytes: 1, coalesce: false, garbageBeforeFrame: [0, 65, 255], oversizeLengthNoise: true };
    });
    await setFault(page, '__mock', 'duplicateNotifications', true);
    await connect(page);
    await expect(page.getByTestId('usb-contacts').locator('li')).toHaveCount(2);
    await sendDm(page).click();
    await expect(fact(page, 'dmAck')).toHaveText('yes');
    await page.waitForTimeout(300);
    expect(await sim.sendWrites()).toBe(1);
  });

  test(T('MECON Repeater: identified by hello; no messaging capability; the send button stays disabled'), async ({ page }) => {
    const sim = await open(page, 'repeater');
    await connect(page);
    await expect(page.getByTestId('usb-role')).toHaveText('repeater');
    await expect(page.getByTestId('usb-caps')).toHaveText('identity.read,status.read,clock.read,config.read');
    await expect(sendDm(page)).toBeDisabled();
    expect(await sim.consoleLines()).toHaveLength(1);
    expect(await sim.executed()).toEqual([]);
  });

  test(T('Room server is identified as a room'), async ({ page }) => {
    await open(page, 'room');
    await connect(page);
    await expect(page.getByTestId('usb-role')).toHaveText('room');
  });

  test(T('stock Companion firmware: not MECON, Companion binary driver only'), async ({ page }) => {
    await open(page, 'stock-companion');
    await connect(page);
    await expect(page.getByTestId('usb-summary')).toContainText('Not MECON firmware or older');
    await expect(page.getByTestId('usb-role')).toHaveText('companion');
    await expect(page.getByTestId('usb-contacts').locator('li')).toHaveCount(2);
  });

  test(T('stock Repeater console: CLI fallback, role from get role'), async ({ page }) => {
    const sim = await open(page, 'stock-repeater');
    await connect(page);
    await expect(page.getByTestId('usb-role')).toHaveText('repeater');
    await expect(page.getByTestId('usb-summary')).toContainText('Not MECON firmware or older');
    expect((await sim.consoleLines()).map((l) => l.slice(0, 7))).toEqual(['mecon> ', 'ver', 'get rol', 'board']);
    expect(await sim.executed()).toEqual([]);
  });

  test(T('unknown device (boot noise, no answers) is reported unknown with no capabilities'), async ({ page }) => {
    await open(page, 'silent', { dev: { detect: { stepTimeoutMs: 150, consoleWindowMs: 150 } } });
    await connect(page);
    await expect(page.getByTestId('usb-summary')).toContainText('Unknown device');
    await expect(page.getByTestId('usb-role')).toHaveText('unknown');
    await expect(page.getByTestId('usb-caps')).toHaveText('none');
  });

  test(T('a board named Repeater that answers nothing recognisable is not called a Repeater'), async ({ page }) => {
    await open(page, 'misleading-board');
    await connect(page);
    await expect(page.getByTestId('usb-role')).toHaveText('unknown');
  });
});
