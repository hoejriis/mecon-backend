import type {
  ApiErrorBody,
  DeviceList,
  Health,
  LoginStarted,
  LoginState,
  Session,
} from './types';

export const API_BASE = '/api/reader/v1';

/** A non-2xx answer (or an unreadable one) from the Backend. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(status: number, body: Partial<ApiErrorBody> | null, fallback: string) {
    super(body?.message || fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'unknown';
    this.requestId = body?.request_id ?? null;
    this.retryable = body?.retryable ?? false;
  }
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /** Called on any 401, before the error is thrown. */
  onUnauthorized?: () => void;
}

export interface ApiClient {
  getHealth(): Promise<Health>;
  startLogin(email: string): Promise<LoginStarted>;
  pollLogin(requestId: string): Promise<LoginState>;
  getSession(): Promise<Session>;
  logout(): Promise<void>;
  listDevices(): Promise<DeviceList>;
  /** Forget the held CSRF token (signed out). */
  reset(): void;
}

async function readError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') body = parsed as Partial<ApiErrorBody>;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, body, `Request failed (${res.status})`);
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const doFetch = (input: string, init?: RequestInit) =>
    (opts.fetchImpl ?? fetch)(input, init);
  let csrfToken: string | null = null;

  async function send(path: string, init: RequestInit): Promise<Response> {
    const res = await doFetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init });
    if (res.status === 401) opts.onUnauthorized?.();
    return res;
  }

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await send(path, init);
    if (!res.ok) throw await readError(res);
    return (await res.json()) as T;
  }

  async function getSession(): Promise<Session> {
    const session = await json<Session>('/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    csrfToken = session.csrf_token;
    return session;
  }

  /**
   * A state-changing request. Sends the current CSRF token. On 403
   * `csrf_failed` (a restarted Backend rotates its key) it refetches the
   * session once and retries exactly once; a second failure surfaces.
   */
  async function write(path: string, init: RequestInit): Promise<Response> {
    const attempt = () =>
      send(path, {
        ...init,
        method: 'POST',
        headers: { ...init.headers, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      });
    const first = await attempt();
    if (first.status !== 403) return first;
    const err = await readError(first.clone());
    if (err.code !== 'csrf_failed') return first;
    await getSession();
    return attempt();
  }

  return {
    getHealth: () => json<Health>('/health', { cache: 'no-store' }),
    startLogin: (email) =>
      json<LoginStarted>('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email }),
      }),
    pollLogin: (id) =>
      json<LoginState>(`/login/${encodeURIComponent(id)}`, { cache: 'no-store' }),
    getSession,
    async logout() {
      const res = await write('/logout', {});
      if (!res.ok) throw await readError(res);
    },
    listDevices: () => json<DeviceList>('/devices', { cache: 'no-store' }),
    reset() {
      csrfToken = null;
    },
  };
}
