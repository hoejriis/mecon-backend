import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { mockBackend } from './backend';

const UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

test('main entry chunk is BLE-free; only the lazy probe chunk has BLE code; no dev harness', async ({ page }) => {
  const dist = resolve(process.cwd(), 'dist');
  const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
  const entryMatch = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/.exec(html);
  expect(entryMatch, 'entry script in index.html').not.toBeNull();
  const entry = entryMatch![1]!;

  const dir = resolve(dist, 'assets');
  const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
  expect(js.length).toBeGreaterThan(1);
  const withBle: string[] = [];
  for (const f of js) {
    const text = readFileSync(resolve(dir, f), 'utf8').toLowerCase();
    expect(text, f).not.toContain('ble adapter (dev only)');
    const hasUuid = text.includes(UUID);
    const hasRequest = text.includes('requestdevice');
    if (hasUuid || hasRequest) withBle.push(f);
    if (f === entry) {
      expect(hasUuid, `${f} (main entry) has the BLE UUID`).toBe(false);
      expect(hasRequest, `${f} (main entry) has requestDevice`).toBe(false);
    }
  }
  // Exactly one chunk (the lazy probe) carries BLE code, and index.html neither loads nor preloads it.
  expect(withBle).toHaveLength(1);
  expect(withBle[0]).not.toBe(entry);
  expect(html).not.toContain(withBle[0]!);
  expect(readFileSync(resolve(dir, withBle[0]!), 'utf8').toLowerCase()).toContain(UUID);

  const backend = await mockBackend(page);
  backend.signedIn = true;
  // The main app never fetches the probe chunk.
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await page.goto('/chats');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(fetched.some((u) => u.includes(withBle[0]!))).toBe(false);

  await page.goto('/dev/ble');
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('heading', { name: 'BLE adapter (dev only)' })).toHaveCount(0);
});
