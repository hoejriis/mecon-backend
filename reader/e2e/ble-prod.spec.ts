import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { mockBackend } from './backend';

const UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

test('main entry chunk is BLE- and serial-free; only lazy probe chunks have device code; no dev harness', async ({ page }) => {
  const dist = resolve(process.cwd(), 'dist');
  const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
  const entryMatch = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/.exec(html);
  expect(entryMatch, 'entry script in index.html').not.toBeNull();
  const entry = entryMatch![1]!;

  const dir = resolve(dist, 'assets');
  const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
  expect(js.length).toBeGreaterThan(1);
  const withBle: string[] = [];
  const withSerial: string[] = [];
  for (const f of js) {
    const text = readFileSync(resolve(dir, f), 'utf8').toLowerCase();
    expect(text, f).not.toContain('ble adapter (dev only)');
    expect(text, f).not.toContain('usb device (dev only)');
    const hasUuid = text.includes(UUID);
    const hasRequest = text.includes('requestdevice');
    const hasSerial = text.includes('requestport') || text.includes('navigator.serial');
    if (hasUuid || hasRequest) withBle.push(f);
    if (hasSerial) withSerial.push(f);
    if (f === entry) {
      expect(hasUuid, `${f} (main entry) has the BLE UUID`).toBe(false);
      expect(hasRequest, `${f} (main entry) has requestDevice`).toBe(false);
      expect(text.includes('requestport'), `${f} (main entry) has requestPort`).toBe(false);
      expect(text.includes('navigator.serial'), `${f} (main entry) has navigator.serial`).toBe(false);
      expect(text.includes('getports'), `${f} (main entry) has getPorts`).toBe(false);
    }
  }
  // Only lazy chunks (the BLE and USB probes, the composer's device session, and what they share) carry BLE or serial
  // code; index.html neither loads nor preloads them. The transport is shared by the USB probe and the device-session
  // chunk, so it sits in its own lazy chunk beside the probe page's.
  expect(withBle.length).toBeGreaterThanOrEqual(1);
  expect(withSerial.length).toBeGreaterThanOrEqual(1);
  for (const f of [...withBle, ...withSerial]) {
    expect(f).not.toBe(entry);
    expect(html).not.toContain(f);
  }
  expect(withBle.some((f) => readFileSync(resolve(dir, f), 'utf8').toLowerCase().includes(UUID))).toBe(true);

  const backend = await mockBackend(page);
  backend.signedIn = true;
  // The main app never fetches a device chunk: not on load, and not by opening Chats.
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await page.goto('/chats');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(fetched.some((u) => [...withBle, ...withSerial].some((f) => u.includes(f)))).toBe(false);

  await page.goto('/dev/ble');
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('heading', { name: 'BLE adapter (dev only)' })).toHaveCount(0);
  await page.goto('/dev/usb');
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('heading', { name: 'USB device (dev only)' })).toHaveCount(0);
});
