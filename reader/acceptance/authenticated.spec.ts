// Authenticated live checks. Skipped unless ACCEPTANCE_SESSION_A / _B hold cookie values
// for two test users. Values are read from the environment only: never logged, never
// asserted with a message that includes them, and trace/video/screenshots are off.
// No message is sent by this suite: sending transmits over radio and is a manual row.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, apiRouted, BASE_URL, COOKIE_NAME, sessionContext, type SessionBody } from './api';

const A = process.env.ACCEPTANCE_SESSION_A;
const B = process.env.ACCEPTANCE_SESSION_B;

test.describe('signed-in test users', () => {
  test.skip(!A || !B, 'ACCEPTANCE_SESSION_A and ACCEPTANCE_SESSION_B are not set');
  test.describe.configure({ mode: 'serial' });

  let a: APIRequestContext;
  let b: APIRequestContext;

  test.beforeAll(async ({ request }) => {
    test.skip(!(await apiRouted(request)), 'API not routed yet');
    a = await sessionContext(A!);
    b = await sessionContext(B!);
  });
  test.afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  test('both sessions are valid and belong to different users', async () => {
    const [ra, rb] = [await a.get(`${API}/session`), await b.get(`${API}/session`)];
    expect(ra.status()).toBe(200);
    expect(rb.status()).toBe(200);
    expect(((await ra.json()) as SessionBody).user.id).not.toBe(((await rb.json()) as SessionBody).user.id);
  });

  test('Settings shows the signed-in name and every capability', async ({ browser }) => {
    const session = (await (await a.get(`${API}/session`)).json()) as SessionBody;
    const context = await browser.newContext();
    await context.addCookies([{ name: COOKIE_NAME, value: A!, url: BASE_URL, secure: true, httpOnly: true }]);
    const page = await context.newPage();
    await page.goto('/settings');
    await expect(page.getByText('Signed in as')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Chats', 'Nodes', 'Map', 'Tools', 'Settings']);
    await expect(page.locator('.settings strong')).toHaveText(session.user.display_name);
    for (const [name, state] of Object.entries(session.capabilities)) {
      await expect(page.locator('.cap-list li').filter({ hasText: name }).first()).toContainText(state);
    }
    await context.close();
  });

  test('/devices of A never includes a device of B, and the reverse', async () => {
    const ids = async (ctx: APIRequestContext) => {
      const res = await ctx.get(`${API}/devices`);
      expect([200, 403]).toContain(res.status()); // 403 = no devices capability, an empty set
      return res.status() === 200 ? ((await res.json()).items as Array<{ id: string }>).map((d) => d.id) : [];
    };
    const [ia, ib] = [await ids(a), await ids(b)];
    const shared = ia.filter((id) => ib.includes(id)).length;
    expect(shared, 'device ids visible to both users (count only)').toBe(0);
  });

  // --- Features shipped since the first matrix. No test here sends a message: sends transmit
  // over radio and stay manual rows. The only write is mark-read, which changes the test
  // user's own read mark and transmits nothing. Everything prints counts, never content.

  interface ConversationBody {
    id: string;
    unread_count: number;
  }

  test('Chats lists: conversations answer with the contract shape, and the screen shows the four filters and no Rooms', async ({ browser }) => {
    const session = (await (await a.get(`${API}/session`)).json()) as SessionBody;
    const res = await a.get(`${API}/conversations`);
    if (session.capabilities.messaging !== 'available') {
      expect([403, 404]).toContain(res.status()); // not offered: nothing to list
      return;
    }
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; meta?: unknown };
    expect(Array.isArray(body.items)).toBe(true);
    for (const c of body.items) {
      for (const k of ['id', 'identity_id', 'target', 'title', 'unread_count', 'last_activity_at']) expect(c, `conversation field ${k}`).toHaveProperty(k);
    }
    const context = await browser.newContext();
    await context.addCookies([{ name: COOKIE_NAME, value: A!, url: BASE_URL, secure: true, httpOnly: true }]);
    const page = await context.newPage();
    await page.goto('/chats');
    const chips = page.getByRole('group', { name: 'Filter conversations' });
    for (const name of ['All', 'Unread', 'DMs', 'Channels']) await expect(chips.getByRole('button', { name })).toBeVisible();
    await expect(chips.getByRole('button', { name: 'Rooms' })).toHaveCount(0);
    await context.close();
  });

  test('mark-read: a conversation with unread messages goes to zero, and a repeat is a no-op', async () => {
    const session = (await (await a.get(`${API}/session`)).json()) as SessionBody;
    test.skip(session.capabilities.messaging !== 'available', 'messaging is not available to test user A');
    const csrf = session.csrf_token;
    const list = (await (await a.get(`${API}/conversations?limit=50`)).json()) as { items: ConversationBody[] };
    const unread = list.items.find((c) => c.unread_count > 0);
    test.skip(!unread, 'test user A has no conversation with unread messages (count: 0)');
    const msgs = (await (await a.get(`${API}/conversations/${encodeURIComponent(unread!.id)}/messages?limit=1`)).json()) as {
      items: Array<{ message_id: string }>;
    };
    const newest = msgs.items[0]?.message_id;
    expect(newest, 'a newest message id').toBeTruthy();
    const post = () =>
      a.post(`${API}/conversations/${encodeURIComponent(unread!.id)}/read`, { headers: { 'X-CSRF-Token': csrf }, data: { up_to: newest } });
    expect((await post()).status()).toBe(204);
    expect((await post()).status()).toBe(204); // idempotent
    const after = (await (await a.get(`${API}/conversations/${encodeURIComponent(unread!.id)}`)).json()) as ConversationBody;
    expect(after.unread_count).toBe(0);
    // Without the CSRF token the write is refused.
    const bare = await a.post(`${API}/conversations/${encodeURIComponent(unread!.id)}/read`, { data: { up_to: newest } });
    expect([401, 403]).toContain(bare.status());
  });

  test('the send path offers the Backend only when no device is connected, and never a fallback', async ({ browser }) => {
    const session = (await (await a.get(`${API}/session`)).json()) as SessionBody;
    test.skip(session.capabilities.messaging !== 'available', 'messaging is not available to test user A');
    const list = (await (await a.get(`${API}/conversations?limit=1`)).json()) as { items: ConversationBody[] };
    test.skip(list.items.length === 0, 'test user A has no conversation to open (count: 0)');
    const context = await browser.newContext(); // a fresh browser has no Bluetooth or USB device connected
    await context.addCookies([{ name: COOKIE_NAME, value: A!, url: BASE_URL, secure: true, httpOnly: true }]);
    const page = await context.newPage();
    await page.goto(`/chats/c/${encodeURIComponent(list.items[0]!.id)}`);
    const sp = page.getByTestId('send-path');
    await expect(sp.first()).toBeVisible();
    // No radio choice is shown (a choice needs two paths), and neither device path is offered.
    await expect(sp.getByRole('radio')).toHaveCount(0);
    await expect(sp.getByRole('radio', { name: /Bluetooth|USB/ })).toHaveCount(0);
    const text = (await sp.first().innerText()).replace(/\s+/g, ' ');
    if (session.capabilities.send === 'available') expect(text).toContain('Sent through the Backend');
    else expect(text).toContain('No send path is available'); // honest: nothing replaces it
    // Nothing is typed or sent: the Send button stays disabled with an empty message.
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await context.close();
  });

  test('Map capability gating: observations unavailable or forbidden shows an honest state and makes no observation call', async ({ browser }) => {
    const session = (await (await a.get(`${API}/session`)).json()) as SessionBody;
    const cap = session.capabilities.observations;
    const context = await browser.newContext();
    await context.addCookies([{ name: COOKIE_NAME, value: A!, url: BASE_URL, secure: true, httpOnly: true }]);
    const page = await context.newPage();
    const calls: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/observations/')) calls.push(u.pathname + (u.search.includes('scope=self') ? '?scope=self' : ''));
    });
    await page.goto('/map');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Map' })).toBeVisible();
    if (cap !== 'available') {
      await expect(page.locator('.state-unavailable, .state-forbidden').first()).toBeVisible();
      await expect(page.locator('svg.obs-map')).toHaveCount(0);
      expect(calls, 'observation requests while the capability is not available').toEqual([]);
    } else {
      await expect(page.getByText('Observer positions only')).toBeVisible();
      expect(calls.every((c) => c.endsWith('?scope=self')), 'every observation request is scope=self').toBe(true);
      // When the Backend serves located observers, the Map draws them (counts only, no positions logged).
      const listed = (await (await a.get('/api/observations/v1/authorized/observers?scope=self&limit=200')).json()) as {
        items: Array<{ location: unknown }>;
      };
      const located = listed.items.filter((o) => o.location).length;
      test.info().annotations.push({ type: 'located-observers', description: String(located) });
      if (located > 0) {
        await expect.poll(() => page.locator('svg.obs-map .obs-pin').count(), { message: 'located observers become pins', timeout: 15_000 }).toBeGreaterThan(0);
      }
      // Located-only pins, and no route geometry of any kind.
      const pins = await page.locator('svg.obs-map .obs-pin').count();
      const rows = await page.locator('.obs-row').count();
      expect(pins, 'pins never exceed listed observers').toBeLessThanOrEqual(rows);
      await expect(page.locator('svg.obs-map line, svg.obs-map path, svg.obs-map polyline, svg.obs-map polygon')).toHaveCount(0);
    }
    await context.close();
  });

  test('a session for A is not accepted on mecon.cloud', async () => {
    test.skip(true, 'MANUAL: the mecon.cloud authenticated path is not defined here; see MVP1_ACCEPTANCE.md row M1-04');
  });

  test('logout answers 204, the cookie clear has no Domain, then /session is 401', async () => {
    const csrf = ((await (await a.get(`${API}/session`)).json()) as SessionBody).csrf_token;
    const out = await a.post(`${API}/logout`, { headers: { 'X-CSRF-Token': csrf } });
    expect(out.status()).toBe(204);
    const setCookie = out.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    test.info().annotations.push({
      type: 'cookie-domain',
      description: setCookie.length ? 'Set-Cookie observed on logout; Domain checked' : 'no Set-Cookie on logout: Domain attribute is a manual row',
    });
    for (const h of setCookie) expect(h.value.toLowerCase()).not.toMatch(/;\s*domain=/);
    expect((await a.get(`${API}/session`)).status()).toBe(401);
  });
});
