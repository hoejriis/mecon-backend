import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from './backend';
import { installSim } from './bleSim';

// The fake navigator.bluetooth is injected by the test (addInitScript) into the
// PRODUCTION preview build. No dev-only code path exists in the app for it.
test.use({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });

const SENSITIVE = ['Synthetic Node', 'MeshCore-Synthetic', 'synthetic-device-1', '1111111111111111', '55.123456', '123456'];

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const status = (page: Page, id: string) => page.locator(`[data-step="${id}"]`).getAttribute('data-status');

test('signed out: full read-only probe on the production build, report is sanitized and copyable', async ({ page }) => {
  await mockBackend(page); // signed out
  const sim = await installSim(page);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  // CSP violations log as console errors; the 401 of the signed-out session check is expected and unrelated.
  page.on('console', (m) => m.type() === 'error' && /Content Security Policy|Refused/i.test(m.text()) && problems.push(m.text()));
  await page.goto('/probe/ble');
  await expect(page.getByRole('heading', { level: 1, name: 'Bluetooth diagnostics' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByText('Nothing is transmitted over radio.')).toBeVisible();
  await axeClean(page);

  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  for (const id of ['environment', 'chooser', 'connect', 'deviceQuery', 'selfInfo', 'disconnect']) expect(await status(page, id), id).toBe('pass');
  expect(await status(page, 'battery')).toBe('unsupported');

  const report = page.getByLabel('Sanitized report (JSON)');
  const text = await report.inputValue();
  const json = JSON.parse(text);
  expect(json.readOnly).toBe(true);
  expect(json.navigatorBluetoothPresent).toBe(true);
  expect(json.hello.firmwareVersion).toBe(10);
  // A stock Companion (the default simulated peer): the interface hello (0x7F) goes first and is answered with an error frame.
  expect(json.commandCodesSent.sort((a: number, b: number) => a - b)).toEqual([1, 22, 127]);
  expect(json.commandsSent).toEqual(['frame-iface:hello', 'frame:22', 'frame:1']);
  expect(json.detected).toMatchObject({ firmware: 'unknown', role: 'companion', companionBinary: true });
  expect(json.selfInfo).toMatchObject({ publicKeyPresent: true, nodeNamePresent: true, locationPresent: true });
  for (const bad of SENSITIVE) expect(text, bad).not.toContain(bad);

  await page.getByRole('button', { name: 'Copy report' }).click();
  await expect(page.getByText('Report copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // Nothing was sent that could transmit: no send commands, no simulated RF.
  expect(await sim.sendWrites()).toBe(0);
  expect(await sim.rfCount()).toBe(0);
  expect(await sim.totalWrites()).toBe(3);
  expect(problems).toEqual([]);
  await axeClean(page);
});

test('closed chooser is reported as a failure with help, later steps unknown', async ({ page }) => {
  await mockBackend(page);
  const sim = await installSim(page);
  await page.goto('/probe/ble');
  await page.evaluate(() => {
    (window as unknown as { __ble: { mock: { faults: { requestDevice: string } } } }).__ble.mock.faults.requestDevice = 'cancel';
  });
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  expect(await status(page, 'chooser')).toBe('fail');
  expect(await status(page, 'connect')).toBe('unknown');
  await expect(page.getByRole('heading', { name: 'If the chooser is empty' })).toBeVisible();
  expect(await sim.totalWrites()).toBe(0);
  await axeClean(page);
});

test('browser without Web Bluetooth: unsupported, nothing crashes', async ({ page }) => {
  await mockBackend(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }));
  await page.goto('/probe/ble');
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  expect(await status(page, 'environment')).toBe('unsupported');
  expect(await status(page, 'chooser')).toBe('unsupported');
  expect(JSON.parse(await page.getByLabel('Sanitized report (JSON)').inputValue()).navigatorBluetoothPresent).toBe(false);
});

test('linked from Settings only, not from the tab bar', async ({ page }) => {
  const state = await mockBackend(page);
  state.signedIn = true;
  await page.goto('/chats');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /diagnostics|probe/i })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Bluetooth diagnostics' }).click();
  await expect(page).toHaveURL(/\/probe\/ble$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Bluetooth diagnostics' })).toBeVisible();
});

const SIM = 'SIMULATED — not hardware verified';

async function runProbeFor(page: Page, sim: object) {
  await mockBackend(page);
  const handle = await installSim(page, { sim, dev: { responseTimeoutMs: 400 } });
  await page.goto('/probe/ble');
  await page.getByRole('button', { name: 'Connect and run probe' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 20_000 });
  const text = await page.getByLabel('Sanitized report (JSON)').inputValue();
  return { handle, text, json: JSON.parse(text) };
}

test(`${SIM}: MECON Companion over BLE: the report carries firmware, role and capabilities, and only read requests were sent`, async ({ page }) => {
  const { handle, text, json } = await runProbeFor(page, { mecon: true });
  for (const id of ['environment', 'chooser', 'connect', 'deviceQuery', 'selfInfo', 'disconnect']) expect(await status(page, id), id).toBe('pass');
  expect(json.probe.version).toBe(2);
  expect(json.linkTrust).toBe('unknown');
  expect(json.detected).toMatchObject({ transport: 'ble', trust: 'unknown', firmware: 'mecon', role: 'companion', roleSource: 'hello', interfaceVersion: '1.0', companionBinary: true });
  expect(json.detected.capabilities).toEqual(expect.arrayContaining(['identity.read', 'status.read', 'clock.read', 'message.send.direct']));
  expect(json.detected.firmwareVersion).toMatch(/^v1\.18\.0-mecon/);
  await expect(page.getByTestId('probe-detected')).toContainText('MECON firmware v1.18.0-mecon');
  await expect(page.getByTestId('probe-detected')).toContainText('role companion');
  expect(json.commandsSent).toEqual(['frame-iface:hello', 'frame:22', 'frame:1']);
  expect(await handle.ifaceOps()).toEqual(['hello']);
  expect(await handle.writeCodes()).toEqual([127, 22, 1]);
  expect(await handle.sendWrites()).toBe(0);
  expect(await handle.rfCount()).toBe(0);
  for (const bad of ['Synthetic Node', 'MeshCore-Synthetic', 'synthetic-device-1', 'ab'.repeat(16), 'cd'.repeat(32)]) expect(text, bad).not.toContain(bad);
  await axeClean(page);
});

test(`${SIM}: stock Companion over BLE: detected as not MECON, the native probe steps still pass`, async ({ page }) => {
  const { handle, json } = await runProbeFor(page, {});
  expect(json.detected).toMatchObject({ firmware: 'unknown', role: 'companion', roleSource: 'companion frames', companionBinary: true, interfaceVersion: null });
  await expect(page.getByTestId('probe-detected')).toContainText('Not MECON firmware or older');
  for (const id of ['deviceQuery', 'selfInfo']) expect(await status(page, id), id).toBe('pass');
  expect(await handle.ifaceOps()).toEqual([]);
  expect(await handle.sendWrites()).toBe(0);
});

test(`${SIM}: unknown device over BLE: nothing answers, reported as unknown, nothing sent beyond the read-only hello and query`, async ({ page }) => {
  test.setTimeout(60_000); // two 8 s answer windows on the production defaults
  const { handle, json } = await runProbeFor(page, { silent: true });
  expect(json.detected).toMatchObject({ firmware: 'unknown', role: 'unknown', capabilities: [] });
  await expect(page.getByTestId('probe-detected')).toContainText('Unknown device');
  expect(await status(page, 'deviceQuery')).toBe('fail');
  expect(await status(page, 'selfInfo')).toBe('unknown');
  expect(await handle.writeCodes()).toEqual([127, 22]);
  expect(await handle.sendWrites()).toBe(0);
});
