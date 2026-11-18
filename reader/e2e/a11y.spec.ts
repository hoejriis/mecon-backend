import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockBackend } from './backend';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
];
const TABS = ['Chats', 'Nodes', 'Map', 'Tools', 'Settings'];
const SCHEMES = ['light', 'dark'] as const;

for (const scheme of SCHEMES) {
  for (const vp of VIEWPORTS) {
    test(`axe + screenshots: ${scheme} ${vp.name}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const state = await mockBackend(page);
      state.signedIn = true;
      await page.goto('/');
      const nav = page.getByRole('navigation', { name: 'Main' });
      for (const tab of TABS) {
        await nav.getByRole('link', { name: tab }).click();
        await expect(nav.getByRole('link', { name: tab })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (tab === 'Nodes') await expect(page.getByText('Synthetic Companion')).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
        await page.screenshot({ path: `e2e-artifacts/${scheme}-${vp.name}-${tab.toLowerCase()}.png` });
      }
    });
  }
}

test('skip link moves focus to main; tab bar arrow keys move focus', async ({ page }) => {
  const state = await mockBackend(page);
  state.signedIn = true;
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chats' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('link', { name: 'Nodes' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('link', { name: 'Settings' })).toBeFocused();
});

test('axe on the signed-out login screen, both schemes', async ({ page }) => {
  await mockBackend(page);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByLabel('Email address')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  }
});
