import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from './backend';
import { installSim, SIM_LABEL } from './bleSim';

// The shared device session over Bluetooth, on the dev server's harness route (/dev/ble-session).
const T = (name: string) => `${SIM_LABEL}: device session: ${name}`;

async function open(page: Page, sim: object = {}) {
  const handle = await installSim(page, { sim });
  const backend = await mockBackend(page);
  backend.signedIn = true;
  await page.goto('/dev/ble-session');
  await expect(page.getByRole('heading', { name: 'Bluetooth device session (dev only)' })).toBeVisible();
  return handle;
}
const phase = (p: Page) => p.getByTestId('bs-phase');
const attempt = (p: Page, n = 0) => p.getByTestId('bs-attempts').locator('li').nth(n);
const fact = (p: Page, name: string) => attempt(p, 0).locator(`[data-fact="${name}"]`);
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect device' }).click();
  await expect(phase(page)).toHaveText('ready');
}

test.describe('Android Chrome profile', () => {
  test(T('MECON Companion is detected over BLE; capabilities gate the features'), async ({ page }) => {
    const sim = await open(page, { mecon: true });
    await connect(page);
    await expect(page.getByTestId('bs-firmware')).toHaveText('mecon');
    await expect(page.getByTestId('bs-role')).toHaveText('companion');
    await expect(page.getByTestId('bs-transport')).toHaveText('ble');
    await expect(page.getByTestId('bs-trust')).toHaveText('unknown');
    await expect(page.getByTestId('bs-summary')).toContainText('MECON firmware v1.18.0-mecon');
    await expect(page.getByTestId('bs-caps')).toContainText('status.read');
    expect((await sim.writeCodes()).slice(0, 2)).toEqual([127, 22]); // interface hello first, then the device query
    await expect(page.getByTestId('bs-contacts').locator('li')).toHaveCount(2);
    await page.getByRole('button', { name: 'Request status.get' }).click();
    await expect(page.getByTestId('bs-reply')).toHaveText('"ok"');
    expect(await sim.ifaceOps()).toEqual(['hello', 'status.get']);
  });

  test(T('a non-read request on the unknown-trust link is refused and never reaches the device'), async ({ page }) => {
    const sim = await open(page, { mecon: true, capabilities: ['hello', 'status.get', 'config.apply'] });
    await connect(page);
    const before = await sim.totalWrites();
    await page.getByRole('button', { name: 'Request config.apply' }).click();
    await expect(page.getByRole('alert')).toContainText('class write');
    expect(await sim.totalWrites()).toBe(before);
    expect(await sim.ifaceOps()).toEqual(['hello']);
  });

  test(T('stock Companion: detected as not MECON, the binary messaging driver still sends a DM'), async ({ page }) => {
    const sim = await open(page, {});
    await connect(page);
    await expect(page.getByTestId('bs-firmware')).toHaveText('unknown');
    await expect(page.getByTestId('bs-role')).toHaveText('companion');
    await expect(page.getByTestId('bs-summary')).toContainText('Not MECON firmware or older');
    await expect(page.getByTestId('bs-caps')).not.toContainText('status.read');
    await page.getByRole('button', { name: 'Send DM to first contact' }).click();
    await expect(fact(page, 'deviceAccepted')).toHaveText('yes');
    await expect(fact(page, 'path')).toHaveText('ble');
    await expect(fact(page, 'rfTransmitted')).toHaveText('not observed');
    await expect(fact(page, 'dmAck')).toHaveText('yes');
    expect(await sim.sendWrites()).toBe(1);
    expect(await sim.ifaceOps()).toEqual([]);
  });

  test(T('unknown device: reported unknown, nothing can be sent'), async ({ page }) => {
    const sim = await open(page, { silent: true });
    await connect(page);
    await expect(page.getByTestId('bs-firmware')).toHaveText('unknown');
    await expect(page.getByTestId('bs-role')).toHaveText('unknown');
    await expect(page.getByTestId('bs-caps')).toHaveText('none');
    await expect(page.getByRole('button', { name: 'Send DM to first contact' })).toBeDisabled();
    expect(await sim.sendWrites()).toBe(0);
  });

  test(T('the BLE device name does not set the role'), async ({ page }) => {
    await open(page, { mecon: true, deviceName: 'Repeater-North' });
    await connect(page);
    await expect(page.getByTestId('bs-role')).toHaveText('companion');
  });
});
