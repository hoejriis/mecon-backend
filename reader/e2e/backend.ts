import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Request } from '@playwright/test';

const FIX = resolve(process.cwd(), '../contracts/reader-api/v1/fixtures');
export const fixture = (name: string) => JSON.parse(readFileSync(resolve(FIX, `${name}.json`), 'utf8'));

export interface MockState {
  signedIn: boolean;
  polls: number;
  logoutCsrf: string[];
  requests: Request[];
}

/** Intercepts every /api/reader/v1/* call and answers from the contract fixtures. */
export async function mockBackend(page: Page, opts: { approveAfterPolls?: number } = {}): Promise<MockState> {
  const state: MockState = { signedIn: false, polls: 0, logoutCsrf: [], requests: [] };
  const approveAfter = opts.approveAfterPolls ?? 2;
  const started = fixture('login-started');
  const j = (status: number, body: unknown) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/reader/v1/**', async (route) => {
    const req = route.request();
    state.requests.push(req);
    const path = new URL(req.url()).pathname.replace('/api/reader/v1', '');
    const m = req.method();
    if (m === 'GET' && path === '/session') {
      return route.fulfill(state.signedIn ? j(200, fixture('session-device-user')) : j(401, fixture('error-401')));
    }
    if (m === 'POST' && path === '/login') return route.fulfill(j(202, started));
    if (m === 'GET' && path === `/login/${started.request_id}`) {
      state.polls += 1;
      if (state.polls >= approveAfter) {
        state.signedIn = true;
        return route.fulfill(j(200, fixture('login-approved')));
      }
      return route.fulfill(j(200, { ...fixture('login-pending'), poll_after_ms: 500 }));
    }
    if (m === 'GET' && path === '/devices') return route.fulfill(j(200, fixture('devices-one')));
    if (m === 'GET' && path === '/health') return route.fulfill(j(200, fixture('health')));
    if (m === 'POST' && path === '/logout') {
      state.logoutCsrf.push(req.headers()['x-csrf-token'] ?? '');
      state.signedIn = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill(j(404, { code: 'not_found', message: 'x', request_id: 'r', retryable: false }));
  });
  return state;
}
