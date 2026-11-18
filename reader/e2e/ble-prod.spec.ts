import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { mockBackend } from './backend';

test('production bundle contains no BLE code or UI', async ({ page }) => {
  const dir = resolve(process.cwd(), 'dist/assets');
  const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
  expect(js.length).toBeGreaterThan(0);
  for (const f of js) {
    const text = readFileSync(resolve(dir, f), 'utf8').toLowerCase();
    expect(text, f).not.toContain('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
    expect(text, f).not.toContain('requestdevice');
    expect(text, f).not.toContain('ble adapter (dev only)');
  }
  const backend = await mockBackend(page);
  backend.signedIn = true;
  await page.goto('/dev/ble');
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('heading', { name: 'BLE adapter (dev only)' })).toHaveCount(0);
});
