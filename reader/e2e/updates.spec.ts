import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mockMessagingBackend } from './messagingBackend';
import { buildReader, startSwapServer, type SwapServer } from './swapServer';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const OUT = resolve(import.meta.dirname, '../e2e-artifacts/swap');
const DIR_A = resolve(OUT, 'a');
const DIR_B = resolve(OUT, 'b');

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  test.setTimeout(120_000);
  buildReader(DIR_A, A);
  buildReader(DIR_B, B);
});

let srv: SwapServer;
test.beforeEach(async () => {
  srv = await startSwapServer(DIR_A);
});
test.afterEach(async () => {
  await srv.close();
});

const SHELL = (c: string) => `mecon-reader-shell-${c}`;

async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  });
}
const cacheNames = (page: Page) => page.evaluate(async () => (await caches.keys()).sort());
const deployNew = async (page: Page) => {
  srv.deploy(DIR_B);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg!.update();
  });
};
async function openChat(page: Page) {
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/chats`);
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await expect(page.getByText('Hello from the peer')).toBeVisible();
  await controlled(page);
}
const buildStamp = async (page: Page) => {
  await page.goto(`${page.url().split('/').slice(0, 3).join('/')}/settings`);
  return page.locator('.build-stamp').innerText();
};

test('registers, precaches the build, and runs the app shell offline; /api is never cached', async ({ page, context }) => {
  const csp: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && csp.push(m.text()));
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/chats`);
  await expect(page.getByRole('link', { name: /Demo Peer \(merged pair\)/ })).toBeVisible(); // real /api traffic happened
  await controlled(page);
  expect(await cacheNames(page)).toEqual(['mecon-reader-meta', SHELL(A)]);

  // Never an /api entry in any cache, whatever the page fetched.
  const keys = await page.evaluate(async () => {
    const out: string[] = [];
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname);
    return out;
  });
  expect(keys.length).toBeGreaterThan(4);
  expect(keys.filter((k) => k.includes('/api'))).toEqual([]);

  await context.setOffline(true);
  const before = srv.requests.length;
  await page.goto(`${srv.url}/probe/ble`);
  await expect(page.getByRole('heading', { name: 'Bluetooth diagnostics' })).toBeVisible();
  // the shell and its assets came from the worker's cache, not from the server
  expect(srv.requests.slice(before).filter((p) => p !== '/sw.js')).toEqual([]);
  // and the API has no offline fallback: it fails, it is not answered from a cache
  await page.unrouteAll({ behavior: 'ignoreErrors' }); // drop the mock so only the network or a cache could answer
  const api = await page.evaluate(() =>
    fetch('/api/reader/v1/session').then(
      (r) => `served:${r.status}`,
      () => 'network-error',
    ),
  );
  expect(api).toBe('network-error');
  expect(csp).toEqual([]);
});

test('a new version waits: banner, no auto-reload, no auto-activation', async ({ page }) => {
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/chats`);
  await controlled(page);
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  await deployNew(page);
  await expect(page.getByRole('status')).toContainText('Update available');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1); // not reloaded
  const state = await page.evaluate(async () => {
    const reg = (await navigator.serviceWorker.getRegistration())!;
    return { waiting: reg.waiting?.state, active: reg.active?.state };
  });
  expect(state).toEqual({ waiting: 'installed', active: 'activated' }); // downloaded, not activated
  expect(await cacheNames(page)).toEqual(['mecon-reader-meta', SHELL(A), SHELL(B)]);
});

test('with nothing at risk one tap activates and the page serves the new commit', async ({ page }) => {
  await mockMessagingBackend(page);
  await page.goto(`${srv.url}/settings`);
  await controlled(page);
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${A.slice(0, 12)}`);
  await deployNew(page);
  await page.getByRole('button', { name: 'Update now' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.build-stamp')).toHaveText(`Build: ${B.slice(0, 12)}`);
  await controlled(page);
  // the new version booted and is the only open tab: the rollback cache is released
  await expect.poll(() => cacheNames(page)).toEqual(['mecon-reader-meta', SHELL(B)]);
});

test('with a draft, activation needs an explicit confirmation that says what is lost', async ({ page }) => {
  await openChat(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('words I have not sent');
  await deployNew(page);
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
  await page.getByRole('button', { name: 'Update now' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('1 unsent draft would be lost');
  await expect(dlg).toContainText('Drafts are kept in memory only');
  await expect(dlg).toContainText('Nothing is sent automatically');
  // declining keeps everything
  await page.getByRole('button', { name: 'Not now' }).click();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('words I have not sent');
  expect((await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.active?.scriptURL))).toContain('/sw.js');
  expect(await cacheNames(page)).toContain(SHELL(A));
  // confirming activates and reloads once
  await page.getByRole('button', { name: 'Update now' }).click();
  await page.getByRole('button', { name: 'Update anyway' }).click();
  await page.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined);
  await controlled(page);
  expect(await buildStamp(page)).toBe(`Build: ${B.slice(0, 12)}`);
  expect(srv.requests.filter((p) => p.startsWith('/api/'))).toEqual([]); // nothing was sent by the page itself either
});

test('an in-flight send attempt also needs confirmation, and is never resent by the update', async ({ page }) => {
  const be = await mockMessagingBackend(page);
  await page.goto(`${srv.url}/chats`);
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await controlled(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('maybe sent');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Queued')).toBeVisible(); // accepted, not final
  const posts = be.posts.length;
  await deployNew(page);
  await page.getByRole('button', { name: 'Update now' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('no final outcome');
  await expect(page.getByRole('alertdialog')).toContainText('will not be sent again');
  await page.getByRole('button', { name: 'Update anyway' }).click();
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
  expect(be.posts.length).toBe(posts); // exactly the one original POST; no resend during or after the update
});

async function twoTabs(context: BrowserContext) {
  const p1 = await context.newPage();
  const p2 = await context.newPage();
  await mockMessagingBackend(p1);
  await mockMessagingBackend(p2);
  await p1.goto(`${srv.url}/chats`);
  await controlled(p1);
  await p2.goto(`${srv.url}/chats`);
  await p2.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await controlled(p2);
  return { p1, p2 };
}

test('two tabs: updating in one tells the other, which keeps its draft and does not reload', async ({ context }) => {
  const { p1, p2 } = await twoTabs(context);
  await p2.getByRole('textbox', { name: 'Message', exact: true }).fill('draft in tab two');
  await p2.evaluate(() => ((window as unknown as { __marker: number }).__marker = 2));
  await deployNew(p1);
  await expect(p1.getByRole('status')).toContainText('Update available');
  await expect(p2.getByRole('status')).toContainText('Update available');

  await p1.getByRole('button', { name: 'Update now' }).click(); // tab one has nothing at risk
  await expect(p2.getByRole('status')).toContainText('Updated in another tab — reload when ready');
  await p2.waitForTimeout(1500);
  expect(await p2.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(2);
  await expect(p2.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('draft in tab two');

  // the old tab's rollback files are still there while it is open
  expect(await cacheNames(p2)).toContain(SHELL(A));
  await p1.waitForLoadState('load');

  // reloading the tab with a draft asks first
  await p2.getByRole('button', { name: 'Reload' }).click();
  await expect(p2.getByRole('alertdialog')).toContainText('1 unsent draft would be lost');
  await p2.getByRole('button', { name: 'Not now' }).click();
  expect(await p2.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(2);
  await p2.getByRole('button', { name: 'Reload' }).click();
  await p2.getByRole('button', { name: 'Reload anyway' }).click();
  await p2.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined);
  expect(await buildStamp(p2)).toBe(`Build: ${B.slice(0, 12)}`);
  // Two tabs are open, so the rollback cache is kept (either could still need it)...
  await p2.waitForTimeout(500);
  expect(await cacheNames(p2)).toContain(SHELL(A));
  // ...and released once a new page boots as the only tab.
  await p1.close();
  await p2.reload();
  await expect.poll(() => cacheNames(p2)).toEqual(['mecon-reader-meta', SHELL(B)]);
});
