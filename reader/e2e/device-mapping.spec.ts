import { expect, test, type Page } from '@playwright/test';
import { COLLISION_CONTACTS, DUPLICATE_NAME_CHANNELS } from '../src/device/sim/lists';
import { installSim } from './bleSim';
import { mockMessagingBackend } from './messagingBackend';

// SIMULATED: the Backend is route mocks, the Companion is a fake navigator.bluetooth (no hardware, no RF).
// The production build and its CSP are real Chromium. The device's own contacts and channel list come from
// the simulated Companion (channel.list over 0x7F frames); the Backend knows no device slot.
const SIMULATED = 'SIMULATED — not hardware verified';
const OWN_KEY_PREFIX = '111111';

async function openChannel(page: Page) {
  await page.goto('/chats');
  await page.getByRole('link', { name: /Demo Channel/ }).click();
  await expect(page.getByText('Synthetic channel message')).toBeVisible();
}
async function openDm(page: Page) {
  await page.goto('/chats');
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await expect(page.getByText('Hello from the peer')).toBeVisible();
}
async function connectBluetooth(page: Page) {
  await page.getByRole('button', { name: 'Connect Bluetooth device' }).click();
  await expect(page.getByTestId('device-ble')).toContainText('Bluetooth device connected', { timeout: 15_000 });
}

test.describe(`${SIMULATED}: local sends find their destination on the device, or are refused`, () => {
  test('a channel matched by name on the device is offered with no slot to type, and one send writes once to that slot', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    const sim = await installSim(page, { sim: { mecon: true, channels: true } });
    const msg = await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX, channelName: 'Crew' });
    await openChannel(page);
    await connectBluetooth(page);
    await page.getByRole('radio', { name: 'Bluetooth' }).check();
    await expect(page.getByTestId('device-destination')).toHaveText('Device channel: Crew, found on your device.');
    await expect(page.getByRole('spinbutton')).toHaveCount(0); // no slot field
    expect(await sim.ifaceOps()).toEqual(['hello', 'channel.list']); // read class only
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello crew');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('You · not yet in history · via Bluetooth')).toBeVisible();
    await expect.poll(() => sim.sendWrites()).toBe(1);
    expect(await sim.rfCount()).toBe(1);
    const rf = await page.evaluate(() => (window as unknown as { __ble: { mock: { rf: unknown[] } } }).__ble.mock.rf);
    expect(rf).toEqual([expect.objectContaining({ kind: 'channel', target: '1' })]); // Crew is slot 1 on the device
    expect(msg.posts).toHaveLength(0);
    await page.screenshot({ path: 'e2e-artifacts/device-mapping-channel-matched.png' });
    expect(violations).toEqual([]);
  });

  test('an ambiguous channel (two device channels with the same name) is refused: no Bluetooth path, the reason is shown, zero writes', async ({ page }) => {
    const sim = await installSim(page, { sim: { mecon: true, channels: DUPLICATE_NAME_CHANNELS } });
    const msg = await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX, channelName: 'Ops' });
    await openChannel(page);
    await connectBluetooth(page);
    await expect(page.getByTestId('local-unavailable-ble')).toHaveText('Not offered through Bluetooth: 2 channels on your device are named "Ops", so none is chosen.');
    await expect(page.getByRole('radio', { name: 'Bluetooth' })).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('must not go out on any Ops');
    await page.getByRole('button', { name: 'Send', exact: true }).click(); // the only path is the Backend
    await expect.poll(() => msg.posts.length).toBe(1);
    expect(await sim.sendWrites()).toBe(0);
    expect(await sim.rfCount()).toBe(0);
    expect((await sim.writeCodes()).filter((c) => c === 2 || c === 3)).toEqual([]); // no send command of any kind reached the device
    await page.screenshot({ path: 'e2e-artifacts/device-mapping-channel-ambiguous.png' });
  });

  test('a channel not on the device is refused with its reason, zero writes', async ({ page }) => {
    const sim = await installSim(page, { sim: { mecon: true, channels: true } });
    await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX }); // the Backend channel is "Demo Channel"; the device has Public, Crew, Ops
    await openChannel(page);
    await connectBluetooth(page);
    await expect(page.getByTestId('local-unavailable-ble')).toHaveText('Not offered through Bluetooth: No channel named "Demo Channel" is on your device.');
    await expect(page.getByRole('radio', { name: 'Bluetooth' })).toHaveCount(0);
    expect(await sim.sendWrites()).toBe(0);
  });

  test('a stock Companion (no device interface): no local channel path, with the reason', async ({ page }) => {
    const sim = await installSim(page, { sim: { mecon: false } });
    await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX, channelName: 'Crew' });
    await openChannel(page);
    await connectBluetooth(page);
    await expect(page.getByTestId('local-unavailable-ble')).toContainText("Sending to a channel through a device needs the device's channel list: this device is not running MECON firmware");
    await expect(page.getByRole('radio', { name: 'Bluetooth' })).toHaveCount(0);
    expect(await sim.sendWrites()).toBe(0);
    // Only the identifying hello was ever sent over the interface (0x7F); channel.list is never requested of a device that did not list it.
    expect((await sim.writeCodes()).filter((c) => c === 0x7f)).toHaveLength(1);
  });

  test('an ambiguous DM contact: only the matching device contacts can be chosen, Send waits for the choice, then one write to that key', async ({ page }) => {
    const sim = await installSim(page, { sim: { mecon: true, contacts: COLLISION_CONTACTS } });
    const msg = await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX });
    await openDm(page);
    await connectBluetooth(page);
    await page.getByRole('radio', { name: 'Bluetooth' }).check();
    const picker = page.getByLabel('Device contact');
    await expect(picker.locator('option')).toHaveText([/2 contacts on your device match/, /Alice Synthetic/, /Alice Clone/]); // Bob is on the device but not offered
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('which alice');
    await expect(page.getByTestId('local-blocked')).toContainText('Choose which of the matching device contacts');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(await sim.sendWrites()).toBe(0);
    await picker.selectOption({ index: 2 }); // Alice Clone
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => sim.sendWrites()).toBe(1);
    const rf = await page.evaluate(() => (window as unknown as { __ble: { mock: { rf: unknown[] } } }).__ble.mock.rf);
    expect(rf).toEqual([expect.objectContaining({ kind: 'direct', target: 'a1a1a1a1e0e0' })]);
    expect(msg.posts).toHaveLength(0);
    await page.screenshot({ path: 'e2e-artifacts/device-mapping-contact-ambiguous.png' });
  });

  test('a DM contact that is not on the device: no Bluetooth path, the reason is shown, zero writes', async ({ page }) => {
    const sim = await installSim(page, { sim: { mecon: true } });
    await mockMessagingBackend(page, { identityPrefix: OWN_KEY_PREFIX, contactPrefix: 'c3c3c3' });
    await openDm(page);
    await connectBluetooth(page);
    await expect(page.getByTestId('local-unavailable-ble')).toHaveText("Not offered through Bluetooth: This contact isn't on your device.");
    await expect(page.getByRole('radio', { name: 'Bluetooth' })).toHaveCount(0);
    expect(await sim.sendWrites()).toBe(0);
  });
});
