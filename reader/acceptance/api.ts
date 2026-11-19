import { request, type APIRequestContext } from '@playwright/test';

export const BASE_URL = process.env.ACCEPTANCE_BASE_URL ?? 'https://reader.mecon.cloud';
export const API = '/api/reader/v1';
export const COOKIE_NAME = '__Host-mecon_session';

/** True once the Reader API is routed: a JSON answer rather than the edge's plain 404. */
export async function apiRouted(ctx: APIRequestContext): Promise<boolean> {
  const res = await ctx.get(`${API}/health`);
  return res.status() !== 404 && (res.headers()['content-type'] ?? '').includes('application/json');
}

/** A request context that carries one session cookie. The value is never logged. */
export async function sessionContext(value: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE_URL,
    // Origin as a browser sends it: the host refuses a state-changing request whose Origin is
    // missing or not its own, on top of the CSRF header.
    extraHTTPHeaders: { Cookie: `${COOKIE_NAME}=${value}`, Accept: 'application/json', Origin: new URL(BASE_URL).origin },
  });
}

export interface SessionBody {
  user: { id: string; display_name: string };
  capabilities: Record<string, string>;
  csrf_token: string;
}
