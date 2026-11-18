import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockMessagingBackend } from './messagingBackend';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
];

async function openDm(page: Page) {
  await page.goto('/chats');
  await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
  await expect(page.getByText('Hello from the peer')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

for (const vp of VIEWPORTS) {
  test.describe(`messaging at ${vp.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test('browse, open a channel, send a DM and follow transmitted -> acked from events', async ({ page }) => {
      const violations: string[] = [];
      page.on('console', (m) => {
        if (m.text().includes('Content Security Policy')) violations.push(m.text());
      });
      const be = await mockMessagingBackend(page);
      await page.goto('/chats');
      await expect(page.getByRole('link', { name: /Demo Peer \(merged pair\)/ })).toBeVisible();
      // Filters work on the real list.
      await page.getByRole('button', { name: 'Channels' }).click();
      await expect(page.getByRole('link', { name: /Demo Peer/ })).toHaveCount(0);
      await page.getByRole('link', { name: /Demo Channel/ }).click();
      const channelMsg = page.getByText('Synthetic channel message').locator('xpath=ancestor::li[1]');
      await expect(channelMsg).toContainText('Demo Sender');
      await page.goto('/chats');
      await page.getByRole('link', { name: /Demo Peer \(merged pair\)/ }).click();
      await expect(page.getByText('Hello from the peer')).toBeVisible();

      await send(page, 'hello over the backend');
      await expect(page.getByText('Queued')).toBeVisible();
      expect(be.posts).toHaveLength(1);
      expect(be.posts[0]!.key).toBe(be.posts[0]!.body.client_attempt_id);
      expect(be.posts[0]!.csrf).toBe('csrf_synthetic_0123456789abcdef');

      be.setAttemptStatus('att_srv_1', 'transmitted');
      await expect(page.getByText('Transmitted', { exact: true })).toBeVisible({ timeout: 10_000 });
      be.setAttemptStatus('att_srv_1', 'acked');
      const acked = page.getByText('Delivered to device (acknowledged)');
      await expect(acked).toBeVisible({ timeout: 10_000 });
      await expect(acked).not.toContainText(/read/i);
      expect(be.posts).toHaveLength(1);
      // The stream resumed from the last event it had seen.
      expect(be.eventRequests.some((r) => r.lastEventId === 'evt_1')).toBe(true);
      expect(violations).toEqual([]);
    });

    test('an ambiguous POST failure shows unknown and posts exactly one attempt id until the user sends again', async ({ page }) => {
      const be = await mockMessagingBackend(page);
      be.postMode = 'abort';
      await openDm(page);
      await send(page, 'maybe sent');
      await expect(page.getByText('Outcome unknown — not resent')).toBeVisible();
      await expect(page.getByText('Failed', { exact: true })).toHaveCount(0);
      // Let the bounded same-attempt re-POSTs run, then wait longer: nothing new.
      await page.waitForTimeout(7000);
      expect(be.posts.length).toBeGreaterThanOrEqual(1);
      expect(new Set(be.posts.map((p) => p.key)).size).toBe(1);
      expect(new Set(be.posts.map((p) => p.body.client_attempt_id)).size).toBe(1);
      const before = be.posts.length;
      await page.waitForTimeout(3000);
      expect(be.posts.length).toBe(before);

      // The user sends again: confirmation, then a NEW attempt id for the same draft.
      be.postMode = 'ok';
      await page.getByRole('button', { name: 'Send again' }).click();
      await expect(page.getByText(/may already have been transmitted/)).toBeVisible();
      expect(be.posts.length).toBe(before);
      await page.getByRole('button', { name: 'Send as a new attempt' }).click();
      await expect(page.getByText('Queued')).toBeVisible();
      const ids = new Set(be.posts.map((p) => p.body.client_attempt_id));
      expect(ids.size).toBe(2);
      expect(new Set(be.posts.map((p) => p.body.client_draft_id)).size).toBe(1);
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`axe on the conversation view (${scheme}): 0 serious or critical`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        const be = await mockMessagingBackend(page);
        be.postMode = 'abort';
        await openDm(page);
        await send(page, 'status for axe');
        await expect(page.getByText('Outcome unknown — not resent')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible();
        await page.getByRole('button', { name: 'Send again' }).click(); // shows the confirmation too
        await expect(page.getByText(/may already have been transmitted/)).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
        await page.screenshot({ path: `e2e-artifacts/messaging-${scheme}-${vp.name}.png` });
      });
    }
  });
}
