import { vi } from 'vitest';
import deviceOne from '../../../contracts/reader-api/v1/fixtures/devices-one.json';
import error401 from '../../../contracts/reader-api/v1/fixtures/error-401.json';
import error403 from '../../../contracts/reader-api/v1/fixtures/error-403.json';
import loginApproved from '../../../contracts/reader-api/v1/fixtures/login-approved.json';
import loginDelivered from '../../../contracts/reader-api/v1/fixtures/login-delivered.json';
import loginExpired from '../../../contracts/reader-api/v1/fixtures/login-expired.json';
import loginPending from '../../../contracts/reader-api/v1/fixtures/login-pending.json';
import loginStarted from '../../../contracts/reader-api/v1/fixtures/login-started.json';
import sessionUser from '../../../contracts/reader-api/v1/fixtures/session-device-user.json';

export const fx = {
  devicesOne: deviceOne,
  error401,
  error403,
  loginApproved,
  loginDelivered,
  loginExpired,
  loginPending,
  loginStarted,
  session: sessionUser,
};

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const empty = (status = 204) => () => new Response(null, { status });

export interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: string | null;
}

/**
 * A fake same-origin Backend. Each route holds a queue of responders; the last
 * one repeats once the queue is down to one. Unrouted calls fail the test.
 */
export function createBackend() {
  const routes = new Map<string, Array<() => Response>>();
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^\/api\/reader\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const q = routes.get(`${method} ${path}`);
    if (!q) throw new Error(`unrouted request: ${method} ${path}`);
    const next = q.length > 1 ? q.shift()! : q[0]!;
    return next();
  });
  return {
    fetchMock,
    calls,
    on(key: string, ...responders: Array<() => Response>) {
      routes.set(key, responders);
    },
    count(key: string) {
      return calls.filter((c) => `${c.method} ${c.path}` === key).length;
    },
    callsTo(key: string) {
      return calls.filter((c) => `${c.method} ${c.path}` === key);
    },
  };
}

export type Backend = ReturnType<typeof createBackend>;
