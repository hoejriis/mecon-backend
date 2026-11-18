import type {
  ApiErrorBody,
  Capabilities,
  CapabilityState,
  ChannelList,
  ContactList,
  Conversation,
  ConversationList,
  DeviceList,
  Health,
  IdentityList,
  LoginStarted,
  LoginState,
  MessageList,
  ObservationSnapshot,
  ObserverList,
  LeaseIssued,
  LeaseKeyList,
  SendAttempt,
  SendRequest,
  Session,
} from './types';

export const API_BASE = '/api/reader/v1';
/** Live observation API, authorized projection (contracts/observations/v1). Same origin and session cookie. */
export const OBSERVATIONS_BASE = '/api/observations/v1/authorized';

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

/**
 * Thrown, before any request is made, when the session does not advertise
 * the capability an operation needs as `available`.
 */
export class CapabilityError extends Error {
  readonly capability: keyof Capabilities;
  readonly state: CapabilityState | 'unknown';
  constructor(capability: keyof Capabilities, state: CapabilityState | 'unknown') {
    super(`Capability ${capability} is ${state}`);
    this.name = 'CapabilityError';
    this.capability = capability;
    this.state = state;
  }
}

/**
 * A POST whose outcome the Reader cannot know: the request may or may not
 * have reached the Backend (network error, timeout, 5xx, unreadable answer).
 * Never a reason to mint a new attempt id.
 */
export class AmbiguousSendError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('The send request got no usable answer');
    this.name = 'AmbiguousSendError';
    this.cause = cause;
  }
}

export const SEND_TIMEOUT_MS = 20_000;

export interface PageOpts {
  cursor?: string | null;
  limit?: number;
}

export interface SendResult {
  attempt: SendAttempt;
  /** true for 201 (created), false for 200 (idempotent repeat of an existing attempt). */
  created: boolean;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /** Capabilities to start from (tests); normally learned from GET /session. */
  initialCapabilities?: Capabilities | null;
  /** Abort a send POST after this long (ambiguous outcome). */
  sendTimeoutMs?: number;
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
  // M2 (draft) operations. Each throws CapabilityError without a request unless
  // the needed capability is `available`.
  listIdentities(): Promise<IdentityList>;
  listConversations(page?: PageOpts): Promise<ConversationList>;
  /** One conversation; a 404 (not found or not visible) is an ApiError. */
  getConversation(conversationId: string): Promise<Conversation>;
  /**
   * Mark a conversation read up to a message id. State-changing: carries the
   * CSRF token. One request, no retry beyond the single csrf_failed refetch.
   */
  markConversationRead(conversationId: string, upTo: string): Promise<void>;
  listMessages(conversationId: string, page?: PageOpts): Promise<MessageList>;
  /** M2 draft: Backend contacts, one page. The Reader needs each one's `public_key_prefix` to find it on a connected device. */
  listContacts(page?: PageOpts): Promise<ContactList>;
  listChannels(): Promise<ChannelList>;
  /**
   * POST one attempt. The Idempotency-Key is the request's client_attempt_id.
   * Calling it again with the same SendRequest is the idempotent re-POST that
   * learns an attempt's fate; it never creates another attempt. Throws
   * AmbiguousSendError when the outcome is unknown, ApiError otherwise (a 409
   * is a key/body mismatch bug and is never retried here).
   */
  createSendAttempt(req: SendRequest): Promise<SendResult>;
  getSendAttempt(attemptId: string): Promise<SendAttempt>;
  /** M3 (draft): issue or renew the offline lease. A 404 means this Backend issues none. */
  createLease(): Promise<LeaseIssued>;
  /** M3 (draft): the public keys that verify leases. */
  listLeaseKeys(): Promise<LeaseKeyList>;
  /**
   * Observation API (authorized projection). Each throws CapabilityError, with
   * no request made, unless `capabilities.observations` is `available`.
   */
  listObservers(page?: PageOpts): Promise<ObserverList>;
  getObservationSnapshot(opts?: { since?: string | null; limit?: number }): Promise<ObservationSnapshot>;
  /** Open the observation SSE stream (raw Response; parse with api/sse). */
  openObservationEvents(opts: {
    lastEventId?: string | null;
    /** A snapshot's cursor, used only when there is no `lastEventId` (the header wins). */
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<Response>;
  /** Open the SSE stream (raw Response; parse with api/sse). */
  openEvents(opts: { lastEventId?: string | null; signal?: AbortSignal }): Promise<Response>;
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
  // Learned from every GET /session; every M2 call is checked against it.
  let capabilities: Capabilities | null = opts.initialCapabilities ?? null;

  async function send(path: string, init: RequestInit, base = API_BASE): Promise<Response> {
    const res = await doFetch(`${base}${path}`, { credentials: 'same-origin', ...init });
    if (res.status === 401) {
      capabilities = null;
      opts.onUnauthorized?.();
    }
    return res;
  }

  function need(...caps: Array<keyof Capabilities>) {
    const c = capabilities;
    for (const name of caps) {
      const state = c ? c[name] ?? 'unavailable' : 'unknown';
      if (state !== 'available') throw new CapabilityError(name, state);
    }
  }

  function pageQuery(page?: PageOpts): string {
    const q = new URLSearchParams();
    if (page?.cursor) q.set('cursor', page.cursor);
    if (page?.limit) q.set('limit', String(page.limit));
    const s = q.toString();
    return s ? `?${s}` : '';
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
    capabilities = session.capabilities;
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
    async listIdentities() {
      need('messaging');
      return json<IdentityList>('/identities', { cache: 'no-store' });
    },
    async listConversations(page) {
      need('messaging');
      return json<ConversationList>(`/conversations${pageQuery(page)}`, { cache: 'no-store' });
    },
    async getConversation(conversationId) {
      need('messaging');
      return json<Conversation>(`/conversations/${encodeURIComponent(conversationId)}`, {
        cache: 'no-store',
      });
    },
    async markConversationRead(conversationId, upTo) {
      need('messaging');
      const res = await write(`/conversations/${encodeURIComponent(conversationId)}/read`, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ up_to: upTo }),
      });
      if (!res.ok) throw await readError(res);
    },
    async listMessages(conversationId, page) {
      need('messaging');
      return json<MessageList>(
        `/conversations/${encodeURIComponent(conversationId)}/messages${pageQuery(page)}`,
        { cache: 'no-store' },
      );
    },
    async listContacts(page) {
      need('messaging');
      return json<ContactList>(`/contacts${pageQuery(page)}`, { cache: 'no-store' });
    },
    async listChannels() {
      need('messaging');
      return json<ChannelList>('/channels', { cache: 'no-store' });
    },
    async createLease() {
      const res = await write('/leases', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw await readError(res);
      return (await res.json()) as LeaseIssued;
    },
    listLeaseKeys: () => json<LeaseKeyList>('/leases/keys', { cache: 'no-store' }),
    async createSendAttempt(req) {
      need('messaging', 'send');
      // One serialized body, reused as-is by the CSRF retry inside write().
      const body = JSON.stringify(req);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.sendTimeoutMs ?? SEND_TIMEOUT_MS);
      let res: Response;
      let text: string;
      try {
        res = await write('/send-attempts', {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Idempotency-Key': req.client_attempt_id,
          },
          body,
          signal: ctl.signal,
        });
        if (!res.ok && res.status < 500) throw await readError(res);
        text = await res.text();
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new AmbiguousSendError(e);
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 500) throw new AmbiguousSendError(new ApiError(res.status, null, 'Server error'));
      let attempt: SendAttempt;
      try {
        attempt = JSON.parse(text) as SendAttempt;
      } catch (e) {
        throw new AmbiguousSendError(e);
      }
      if (attempt?.client_attempt_id !== req.client_attempt_id) {
        throw new AmbiguousSendError(new Error('Answer is for a different attempt'));
      }
      return { attempt, created: res.status === 201 };
    },
    async getSendAttempt(id) {
      need('messaging', 'send');
      return json<SendAttempt>(`/send-attempts/${encodeURIComponent(id)}`, { cache: 'no-store' });
    },
    async listObservers(page) {
      need('observations');
      const q = new URLSearchParams({ scope: 'self' });
      if (page?.cursor) q.set('cursor', page.cursor);
      if (page?.limit) q.set('limit', String(page.limit));
      const res = await send(`/observers?${q}`, { cache: 'no-store', headers: { Accept: 'application/json' } }, OBSERVATIONS_BASE);
      if (!res.ok) throw await readError(res);
      return (await res.json()) as ObserverList;
    },
    async getObservationSnapshot(o) {
      need('observations');
      const q = new URLSearchParams({ scope: 'self' });
      if (o?.since) q.set('since', o.since);
      if (o?.limit) q.set('limit', String(o.limit));
      const res = await send(`/snapshot?${q}`, { cache: 'no-store', headers: { Accept: 'application/json' } }, OBSERVATIONS_BASE);
      if (!res.ok) throw await readError(res);
      return (await res.json()) as ObservationSnapshot;
    },
    async openObservationEvents({ lastEventId, cursor, signal }) {
      need('observations');
      const q = new URLSearchParams({ scope: 'self' });
      if (cursor && !lastEventId) q.set('cursor', cursor);
      return send(
        `/events?${q}`,
        {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
          },
          cache: 'no-store',
          signal,
        },
        OBSERVATIONS_BASE,
      );
    },
    async openEvents({ lastEventId, signal }) {
      need('messaging', 'events');
      return send('/events', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        cache: 'no-store',
        signal,
      });
    },
    reset() {
      csrfToken = null;
      capabilities = null;
    },
  };
}
