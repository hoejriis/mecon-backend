import { expect, test } from '@playwright/test';
import { mockBackend } from './backend';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
];
const TABS = ['Chats', 'Nodes', 'Map', 'Tools', 'Settings'];

for (const vp of VIEWPORTS) {
  test(`five tabs at ${vp.width}x${vp.height}`, async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const state = await mockBackend(page);
    state.signedIn = true;
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(TABS);
    for (const tab of TABS) {
      await nav.getByRole('link', { name: tab }).click();
      await expect(nav.getByRole('link', { name: tab })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.screenshot({ path: `e2e-artifacts/${vp.name}-${tab.toLowerCase()}.png` });
    }
    const detail = page.locator('.pane-detail');
    if (vp.width >= 900) await expect(detail).toBeVisible();
    else await expect(detail).toBeHidden();
    expect(violations).toEqual([]);
  });
}
