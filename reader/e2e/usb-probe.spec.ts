import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from './backend';
import { installUsbSim, USB_SIM_LABEL, type Device } from './usbSim';

// The fake navigator.serial is injected into the PRODUCTION preview build (addInitScript). No test-only path exists in the app.
test.setTimeout(60_000);
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
const T = (name: string) => `${USB_SIM_LABEL}: ${name}`;
const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`).getAttribute('data-status');
const SENSITIVE = ['ab'.repeat(16), 'cd'.repeat(32), 'Synthetic Node', '1111111111111111', 'serial-port'];

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
}

async function probe(page: Page, device: Device) {
  const sim = await installUsbSim(page, { device });
  await mockBackend(page); // signed out
  await page.goto('/probe/usb');
  await expect(page.getByRole('heading', { level: 1, name: 'USB diagnostics' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 20_000 }); // an unknown device waits out every identification step
  const text = await page.getByLabel('Sanitized report (JSON)').inputValue();
  return { sim, text, json: JSON.parse(text) };
}

test(T('Repeater: signed-out probe passes, only the interface hello is written, report sanitized and copyable'), async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  const { sim, text, json } = await probe(page, 'repeater');
  for (const id of ['environment', 'chooser', 'open', 'identify', 'disconnect']) expect(await step(page, id), id).toBe('pass');
  expect(json.readOnly).toBe(true);
  expect(json.detected).toMatchObject({ firmware: 'mecon', role: 'repeater', carriage: 'console-line' });
  expect(json.commandsSent).toEqual(['iface:hello']);
  for (const bad of SENSITIVE) expect(text, bad).not.toContain(bad);
  expect(await sim.executed()).toEqual([]);
  expect(await sim.consoleLines()).toHaveLength(1);
  await page.getByRole('button', { name: 'Copy report' }).click();
  await expect(page.getByText('Report copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  expect(problems).toEqual([]);
  await axeClean(page);
  await page.screenshot({ path: 'e2e-artifacts/usb-probe-repeater.png' });
});

test(T('Companion: only allowlisted codes reach the device (device query), nothing transmitted'), async ({ page }) => {
  const { sim, json } = await probe(page, 'companion');
  expect(json.detected).toMatchObject({ role: 'companion', companionBinary: true, carriage: 'companion-frames' });
  expect(json.commandsSent).toEqual(['iface:hello', 'frame-iface:hello', 'frame:22']);
  expect(await sim.sendWrites()).toBe(0);
  expect(await sim.rfCount()).toBe(0);
});

test(T('stock Repeater console: probe uses the read-only CLI fallback only'), async ({ page }) => {
  const { sim, json } = await probe(page, 'stock-repeater');
  expect(json.detected).toMatchObject({ firmware: 'unknown', role: 'repeater', consoleCli: true });
  expect(json.commandsSent).toEqual(['iface:hello', 'cli:ver', 'cli:get role', 'cli:board']);
  expect(await sim.executed()).toEqual([]);
});

test(T('unknown device: identify is unknown, report says so'), async ({ page }) => {
  const { json } = await probe(page, 'silent');
  expect(await step(page, 'identify')).toBe('unknown');
  expect(json.detected.role).toBe('unknown');
});

test(T('closed chooser is a failure with help, later steps unknown'), async ({ page }) => {
  const sim = await installUsbSim(page, { device: 'repeater' });
  await mockBackend(page);
  await page.goto('/probe/usb');
  await page.evaluate(() => ((window as unknown as { __serial: { faults: { requestPort: string } } }).__serial.faults.requestPort = 'cancel'));
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  expect(await step(page, 'chooser')).toBe('fail');
  expect(await step(page, 'open')).toBe('unknown');
  expect(await sim.openCalls()).toBe(0);
  await expect(page.getByRole('heading', { name: 'If the chooser is empty' })).toBeVisible();
});

test(T('busy port: open fails with the port_busy code'), async ({ page }) => {
  await installUsbSim(page, { device: 'repeater' });
  await mockBackend(page);
  await page.goto('/probe/usb');
  await page.evaluate(() => ((window as unknown as { __serial: { faults: { open: string } } }).__serial.faults.open = 'busy'));
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  expect(await step(page, 'open')).toBe('fail');
  await expect(page.getByText('(port_busy)')).toBeVisible();
});

test(T('browser without Web Serial: unsupported, nothing crashes'), async ({ page }) => {
  await mockBackend(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'serial', { value: undefined, configurable: true }));
  await page.goto('/probe/usb');
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  expect(await step(page, 'environment')).toBe('unsupported');
  expect(await step(page, 'chooser')).toBe('unsupported');
  expect(JSON.parse(await page.getByLabel('Sanitized report (JSON)').inputValue()).navigatorSerialPresent).toBe(false);
});

test(T('linked from Settings, not from the tab bar'), async ({ page }) => {
  const state = await mockBackend(page);
  state.signedIn = true;
  await page.goto('/chats');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'USB diagnostics' }).click();
  await expect(page).toHaveURL(/\/probe\/usb$/);
});
