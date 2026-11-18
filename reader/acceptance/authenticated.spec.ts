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
