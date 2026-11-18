import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, mockBackend } from './backend';

const OBS = resolve(process.cwd(), '../contracts/observations/v1/fixtures');
const obs = (name: string) => JSON.parse(readFileSync(resolve(OBS, `${name}.json`), 'utf8'));
const J = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Signed in, observations available, /api/observations answered from the contract fixtures. */
async function setup(page: Page, o: { observers?: string; stream?: string | null; capability?: 'available' | 'unavailable' } = {}) {
  const state = await mockBackend(page);
  state.signedIn = true;
  const session = fixture('session-device-user');
  session.capabilities.observations = o.capability ?? 'available';
  await page.route('**/api/reader/v1/session', (r) => r.fulfill(J(200, session)));
  const seen: string[] = [];
  await page.route('**/api/observations/v1/authorized/**', (route) => {
    const u = new URL(route.request().url());
    seen.push(u.pathname + u.search);
    if (u.pathname.endsWith('/observers')) return route.fulfill(J(200, obs(o.observers ?? 'observers-location-withheld')));
    if (u.pathname.endsWith('/snapshot')) return route.fulfill(J(200, obs('snapshot-single')));
    if (u.pathname.endsWith('/events')) {
      const frames = o.stream === null ? '' : `id: evt_synthetic_0030\ndata: ${JSON.stringify(obs(o.stream ?? 'event-reception'))}\n\n: heartbeat\n\n`;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-store' }, body: frames });
    }
    return route.fulfill(J(404, { code: 'not_found', message: 'x', request_id: 'r', retryable: false }));
  });
  return seen;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test('pins only for located observers, the list for all, and a live highlight', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && csp.push(m.text()));
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== '127.0.0.1') external.push(r.url());
  });
  await setup(page);
  await page.goto('/');
  await nav(page).getByRole('link', { name: 'Map' }).click();
  const list = page.getByRole('list', { name: 'Observers' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('Location not shared')).toHaveCount(2);
  const svg = page.locator('svg.obs-map');
  await expect(svg.locator('circle[role="img"]')).toHaveCount(1);
  await expect(svg.locator('circle[role="img"]')).toHaveAttribute('aria-label', /Synthetic Observer One/);
  await expect(svg.locator('line, polyline, polygon, path')).toHaveCount(0);
  // Live reception: highlighted with its time, then cleared.
  await expect(list.getByText('Heard a packet at 10:00:05 UTC')).toBeVisible();
  await expect(svg.locator('.obs-active')).toHaveCount(1);
  await expect(page.getByText('Simplified map without base-map tiles')).toBeVisible();
  expect(csp).toEqual([]);
  expect(external).toEqual([]);
});

test('highlight clears after the live window', async ({ page }) => {
  await setup(page);
  await page.clock.install();
  await page.goto('/');
  await nav(page).getByRole('link', { name: 'Map' }).click();
  const svg = page.locator('svg.obs-map');
  await expect(svg.locator('.obs-active')).toHaveCount(1);
  await page.clock.runFor(15_000);
  await expect(svg.locator('.obs-active')).toHaveCount(0);
});

test('multi-observer fixture draws three pins and no connecting geometry', async ({ page }) => {
  await setup(page, { observers: 'observers-multi' });
  await page.goto('/');
  await nav(page).getByRole('link', { name: 'Map' }).click();
  const svg = page.locator('svg.obs-map');
  await expect(svg.locator('circle[role="img"]')).toHaveCount(3);
  await expect(svg.locator('line, polyline, polygon, path')).toHaveCount(0);
});

test('keeps an honest unavailable state and makes no observation request', async ({ page }) => {
  const seen = await setup(page, { capability: 'unavailable' });
  await page.goto('/');
  await nav(page).getByRole('link', { name: 'Map' }).click();
  await expect(page.getByText('Not available')).toBeVisible();
  await expect(page.locator('svg.obs-map')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(seen).toEqual([]);
});

test('access_revoked ends the view and clears what it held', async ({ page }) => {
  await setup(page, { stream: 'event-access-revoked' });
  await page.goto('/');
  await nav(page).getByRole('link', { name: 'Map' }).click();
  await expect(page.getByText('Access withdrawn')).toBeVisible();
  await expect(page.locator('svg.obs-map')).toHaveCount(0);
  await expect(page.getByText('Synthetic Observer One')).toHaveCount(0);
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
];
for (const scheme of ['light', 'dark'] as const) {
  for (const vp of VIEWPORTS) {
    test(`axe on the Map: ${scheme} ${vp.name}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setup(page, { observers: 'observers-multi' });
      await page.goto('/');
      await nav(page).getByRole('link', { name: 'Map' }).click();
      await expect(page.locator('svg.obs-map circle[role="img"]')).toHaveCount(3);
      await expect(page.locator('svg.obs-map .obs-active')).toHaveCount(1);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      // The pins are on screen at phone width too.
      await expect(page.locator('svg.obs-map')).toBeInViewport();
      await page.screenshot({ path: `e2e-artifacts/${scheme}-${vp.name}-map-observations.png` });
    });
  }
}
