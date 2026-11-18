import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockBackend } from './backend';
import { mockMessagingBackend } from './messagingBackend';
import { buildReader, startSwapServer, type SwapServer } from './swapServer';

/*
 * Rollback below the first service-worker release. The host rolls back by
 * pointing a symlink at an older release directory; that release has no
 * /sw.js, and unknown paths fall back to index.html (200 text/html). A browser
 * that installed the newer worker keeps serving its cached shell. These tests
 * pin whether, and how fast, such a browser lands on the rolled-back build.
 */

const NEW = 'a'.repeat(40); // has the worker
const OLD = 'b'.repeat(40); // no worker
const OUT = resolve(import.meta.dirname, '../e2e-artifacts/rollback');
const DIR_NEW = resolve(OUT, 'new');
const DIR_OLD = resolve(OUT, 'old');
const DIR_OLD_KILL = resolve(OUT, 'old-kill');
const DIR_OLD_UNVERSIONED = resolve(OUT, 'old-unversioned'); // v0.1.0: no worker and no /version.json

/** Upper bound for "recovers by itself": about 3 s update wait plus reload and boot; see docs/DEVELOPMENT.md. */
const RECOVERY_MS = 15_000;

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  test.setTimeout(180_000);
  buildReader(DIR_NEW, NEW);
  buildReader(DIR_OLD, OLD, { sw: false });
  rmSync(DIR_OLD_KILL, { recursive: true, force: true });
  cpSync(DIR_OLD, DIR_OLD_KILL, { recursive: true });
  rmSync(DIR_OLD_UNVERSIONED, { recursive: true, force: true });
  cpSync(DIR_OLD, DIR_OLD_UNVERSIONED, { recursive: true });
  rmSync(resolve(DIR_OLD_UNVERSIONED, 'version.json'));
  copyFileSync(resolve(import.meta.dirname, '../../deploy/sw-unregister.js'), resolve(DIR_OLD_KILL, 'sw.js'));
});

let srv: SwapServer;
test.beforeEach(async () => {
  srv = await startSwapServer(DIR_NEW);
});
test.afterEach(async () => {
  await srv.close();
});

async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  });
}
const versionJson = (page: Page) => page.evaluate(() => fetch('/version.json', { cache: 'no-store' }).then((r) => r.json()));
const workerState = (page: Page) =>
  page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).sort(),
  }));

async function loadNewThenRollBack(page: Page, oldDir: string) {
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/settings`);
  await controlled(page);
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${NEW.slice(0, 12)}`);
  expect((await workerState(page)).caches).toContain(`mecon-reader-shell-${NEW}`);
  srv.deploy(oldDir); // the symlink now points at the worker-less release
}

test('rollback to a worker-less build: the sw.js check sees HTML, and the page still lands on the old build with nothing at risk', async ({ page }) => {
  await loadNewThenRollBack(page, DIR_OLD);
  // the host answers /sw.js with the SPA shell, as Caddy's try_files does
  const sw = await page.evaluate(() => fetch('/sw.js').then(async (r) => [r.status, r.headers.get('content-type')]));
  expect(sw).toEqual([200, 'text/html; charset=utf-8']);

  const t0 = Date.now();
  await page.reload(); // the cached shell of the new build is served first
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${OLD.slice(0, 12)}`, { timeout: RECOVERY_MS });
  const took = Date.now() - t0;
  console.log(`rollback recovery (nothing at risk): ${took} ms`);
  expect(took).toBeLessThan(RECOVERY_MS);
  expect((await versionJson(page)).commit).toBe(OLD);
  expect(await workerState(page)).toEqual({ registrations: 0, caches: [] });

  // after recovery the stale shell is never served again: the next navigation comes from the network
  const before = srv.requests.length;
  await page.goto(`${srv.url}/settings`);
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${OLD.slice(0, 12)}`);
  expect(srv.requests.slice(before)).toContain('/settings');
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

test('rollback with a draft typed during the repair wait: no reload, the banner asks, confirming recovers', async ({ page }) => {
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/chats`);
  await controlled(page);
  srv.deploy(DIR_OLD);
  srv.setSwDelay(2500); // widen the window between the stale-shell check and its second look
  await page.reload();
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('words I have not sent');
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));

  // no automatic reload, no unregistration, no cache loss, for longer than the repair wait
  await page.waitForTimeout(7000);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('words I have not sent');
  const st = await workerState(page);
  expect(st.registrations).toBe(1);
  expect(st.caches).toContain(`mecon-reader-shell-${NEW}`);

  // the confirmed-update banner offers the way out and says what is at risk
  await expect(page.getByRole('status')).toContainText('Update');
  await page.getByRole('button', { name: /Update now|Repair|Reload/ }).click();
  await expect(page.getByRole('alertdialog')).toContainText('1 unsent draft would be lost');
  await page.getByRole('button', { name: 'Not now' }).click();
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);

  await page.getByRole('button', { name: /Update now|Repair|Reload/ }).click();
  await page.getByRole('button', { name: /anyway/ }).click();
  await page.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined);
  await page.goto(`${srv.url}/settings`);
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${OLD.slice(0, 12)}`);
  expect((await versionJson(page)).commit).toBe(OLD);
  await expect.poll(() => workerState(page)).toEqual({ registrations: 0, caches: [] });
});

test('rollback to a build that predates /version.json too (v0.1.0): the host answers it with HTML and the page still recovers', async ({ page }) => {
  await loadNewThenRollBack(page, DIR_OLD_UNVERSIONED);
  const v = await page.evaluate(() => fetch('/version.json').then(async (r) => [r.status, r.headers.get('content-type')]));
  expect(v).toEqual([200, 'text/html; charset=utf-8']);
  const t0 = Date.now();
  await page.reload();
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${OLD.slice(0, 12)}`, { timeout: RECOVERY_MS });
  console.log(`rollback recovery (no version.json): ${Date.now() - t0} ms`);
  await expect.poll(() => workerState(page)).toEqual({ registrations: 0, caches: [] });
});

test('kill-switch /sw.js on the rollback target: the worker and caches go, open tabs are not reloaded, the next navigation is the old build', async ({ page }) => {
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/chats`);
  await controlled(page);
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('words I have not sent');
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  srv.deploy(DIR_OLD_KILL);
  // what the browser does on a navigation or its periodic check
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await expect.poll(() => workerState(page), { timeout: RECOVERY_MS }).toEqual({ registrations: 0, caches: [] });

  // the worker cannot see the draft, so it must not have reloaded the tab
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('words I have not sent');

  // the next navigation (the user's own) is served by the network: the old build, one navigation, no wait
  const before = srv.requests.length;
  await page.goto(`${srv.url}/settings`);
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${OLD.slice(0, 12)}`, { timeout: 2500 });
  expect(srv.requests.slice(before)).toContain('/settings');
  expect((await versionJson(page)).commit).toBe(OLD);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

test('the kill-switch worker is inert: no fetch handler, no client navigation, no messaging', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../../deploy/sw-unregister.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/addEventListener\(\s*['"](fetch|message)['"]/);
  expect(code).not.toMatch(/\.navigate\(|clients\.|postMessage|location\.reload/);
  expect(code).toMatch(/skipWaiting/);
  expect(code).toMatch(/registration\.unregister/);
});

test('rollback drill: the Backend answers /api/reader/v1/* with 404; the page says so, retries by itself, and no cache holds that state', async ({ page }) => {
  await mockBackend(page); // signed out
  let down = true;
  const gets: string[] = [];
  const writes: string[] = [];
  await page.route('**/api/reader/v1/**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') gets.push(new URL(req.url()).pathname);
    else writes.push(req.method());
    if (down) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
    return route.fallback();
  });
  await page.goto(`${srv.url}/`);
  await controlled(page);
  await expect(page.getByText('Could not reach the Backend')).toBeVisible();
  expect(gets.filter((g) => g.endsWith('/session')).length).toBeGreaterThanOrEqual(1);

  // the API comes back: no reload, no cache clearing, the page finds it within the first backoff step
  down = false;
  const t0 = Date.now();
  await expect(page.getByText('Could not reach the Backend')).toHaveCount(0, { timeout: 9000 });
  console.log(`API-return recovery: ${Date.now() - t0} ms (first retry 5 s)`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeEnabled();
  expect(writes).toEqual([]); // only the read-only session load was retried

  // the worker never held the failed state: a reload with the API up shows the login form straight away
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Could not reach the Backend')).toHaveCount(0);
  const apiInCaches = await page.evaluate(async () => {
    const out: string[] = [];
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname);
    return out.filter((k) => k.includes('/api'));
  });
  expect(apiInCaches).toEqual([]);
});

test('the Backend stays down: retries back off (5 s, then 10 s), never hammer, and never write', async ({ page }) => {
  await mockBackend(page);
  const times: number[] = [];
  const writes: string[] = [];
  await page.route('**/api/reader/v1/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') writes.push(req.method());
    else if (new URL(req.url()).pathname.endsWith('/session')) times.push(Date.now());
    return route.fulfill({ status: 404, contentType: 'text/html', body: 'x' });
  });
  await page.goto(`${srv.url}/`);
  await expect.poll(() => times.length, { timeout: 25_000 }).toBeGreaterThanOrEqual(3);
  const gaps = [times[1]! - times[0]!, times[2]! - times[1]!];
  expect(gaps[0]).toBeGreaterThanOrEqual(4800);
  expect(gaps[0]).toBeLessThan(7500);
  expect(gaps[1]).toBeGreaterThanOrEqual(9800);
  expect(writes).toEqual([]);
});
