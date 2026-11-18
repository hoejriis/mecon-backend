// Unauthenticated live checks. Read-only GETs and page loads only.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { API, apiRouted } from './api';

const NOT_ROUTED = 'API not routed yet: /api/reader/v1/health still answers 404 on this host';

test.describe('static shell and edge', () => {
  test('shell answers 200 with security headers', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const h = res.headers();
    const csp = h['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('same-origin');
    expect(h['strict-transport-security']).toMatch(/max-age=\d{7,}/);
  });

  for (const path of ['/chats', '/nodes', '/map', '/tools', '/settings', '/probe/ble']) {
    test(`SPA fallback serves the shell at ${path}`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/html');
      expect(await res.text()).toContain('<div id="root">');
      expect(res.headers()['cache-control']).toContain('no-cache');
    });
  }

  test('hashed assets are immutable', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      const res = await request.get(a);
      expect(res.status(), a).toBe(200);
      expect(res.headers()['cache-control'], a).toMatch(/immutable/);
      expect(res.headers()['cache-control'], a).toMatch(/max-age=31536000/);
    }
  });

  test('/version.json carries a 40-hex commit', async ({ request }) => {
    const res = await request.get('/version.json');
    expect(res.status()).toBe(200);
    expect((await res.json()).commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('non-allowlisted /api paths answer 404', async ({ request }) => {
    for (const p of ['/api/admin', '/api/reader/v2/session', '/api/reader/v1/not-a-route', '/api/']) {
      expect((await request.get(p)).status(), p).toBe(404);
    }
  });
});

test.describe('Reader API, signed out', () => {
  test('GET /health answers 200 {status, commit}', async ({ request }) => {
    test.skip(!(await apiRouted(request)), NOT_ROUTED);
    const res = await request.get(`${API}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(typeof body.commit).toBe('string');
  });

  test('GET /session signed out answers 401', async ({ request }) => {
    test.skip(!(await apiRouted(request)), NOT_ROUTED);
    expect((await request.get(`${API}/session`)).status()).toBe(401);
  });
});

test.describe('browser behaviour', () => {
  test('signed-out screen renders, passes axe, and raises no CSP violation', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => v.id)).toEqual([]);
    expect(violations).toEqual([]);
  });

  test('signed out shows only the login form: no tab navigation is exposed', async ({ page, request }) => {
    test.skip(!(await apiRouted(request)), `${NOT_ROUTED}; the shell shows a Backend-unreachable state, not the login screen`);
    await page.goto('/');
    await expect(page.getByLabel('Email address')).toBeVisible();
    // Access is restricted to existing accounts: the five tabs appear only once signed in
    // (checked in authenticated.spec.ts).
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('/probe/ble renders without sign-in', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    await page.goto('/probe/ble');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /connect and run probe/i })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('main entry chunk has no BLE UUID and no requestDevice', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const entry = /<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(entry, 'entry script in index.html').toBeTruthy();
    const js = (await (await request.get(entry!)).text()).toLowerCase();
    expect(js.includes('6e400001-b5a3-f393-e0a9-e50e24dcca9e')).toBe(false);
    expect(js.includes('requestdevice')).toBe(false);
  });
});
