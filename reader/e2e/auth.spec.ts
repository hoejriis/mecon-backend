import { expect, test } from '@playwright/test';
import { fixture, mockBackend } from './backend';

test('login -> signed in -> sign out at phone viewport', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) violations.push(m.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockBackend(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('If this address has an account, a sign-in link is on its way.')).toBeVisible();
  await page.screenshot({ path: 'e2e-artifacts/phone-login.png' });

  await page.getByLabel('Email address').fill('alice@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mecon.reader.pending-login'))).toContain(
    fixture('login-started').request_id,
  );

  // Signed in once the poll is approved.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem('mecon.reader.pending-login'))).toBeNull();

  await nav.getByRole('link', { name: 'Nodes' }).click();
  await expect(page.getByText('Synthetic Companion')).toBeVisible();
  await page.screenshot({ path: 'e2e-artifacts/phone-nodes.png' });

  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('Alice (synthetic)')).toBeVisible();
  await page.screenshot({ path: 'e2e-artifacts/phone-settings.png' });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(state.logoutCsrf).toEqual([fixture('session-device-user').csrf_token]);
  expect(violations).toEqual([]);
});

test('publishes /version.json next to the bundle', async ({ request }) => {
  const res = await request.get('/version.json');
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body).toHaveProperty('commit');
});
