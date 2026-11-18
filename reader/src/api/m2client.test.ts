import { AmbiguousSendError, ApiError, CapabilityError, createApiClient, type ApiClient } from './client';
import type { Capabilities, SendRequest } from './types';
import { createBackend, fx, json, sessionWith, type Backend } from '../test/backend';
import { attempt, identities, page } from '../test/m2';

const ALL: Partial<Capabilities> = { messaging: 'available', send: 'available', events: 'available' };

const REQ: SendRequest = {
  client_draft_id: 'draft-1',
  client_attempt_id: 'attempt-aaaaaaaa-1',
  identity_id: 'ident_demo_0001',
  target: { kind: 'contact', id: 'contact_demo_0001' },
  content: { kind: 'text', text: 'hi' },
};

async function signedIn(b: Backend, caps: Partial<Capabilities>, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  b.on('GET /session', json(sessionWith(caps)));
  const c = createApiClient({ fetchImpl: b.fetchMock as unknown as typeof fetch, ...extra });
  await c.getSession();
  b.calls.length = 0;
  return c;
}

describe('M2 capability gating', () => {
  const ops: Array<[string, (c: ApiClient) => Promise<unknown>]> = [
    ['listIdentities', (c) => c.listIdentities()],
    ['listConversations', (c) => c.listConversations()],
    ['listMessages', (c) => c.listMessages('conv_1')],
    ['listChannels', (c) => c.listChannels()],
    ['createSendAttempt', (c) => c.createSendAttempt(REQ)],
    ['getSendAttempt', (c) => c.getSendAttempt('att_1')],
    ['openEvents', (c) => c.openEvents({})],
  ];

  it.each(['unavailable', 'forbidden'] as const)('makes no request for any M2 op when messaging is %s', async (state) => {
    const b = createBackend();
    const c = await signedIn(b, { messaging: state, send: 'available', events: 'available' });
    for (const [, op] of ops) await expect(op(c)).rejects.toBeInstanceOf(CapabilityError);
    expect(b.calls).toEqual([]);
  });

  it('gates send and status ops on send, and the stream on events', async () => {
    const b = createBackend();
    const c = await signedIn(b, { messaging: 'available', send: 'unavailable', events: 'forbidden' });
    await expect(c.createSendAttempt(REQ)).rejects.toMatchObject({ capability: 'send', state: 'unavailable' });
    await expect(c.getSendAttempt('x')).rejects.toBeInstanceOf(CapabilityError);
    await expect(c.openEvents({})).rejects.toMatchObject({ capability: 'events', state: 'forbidden' });
    expect(b.calls).toEqual([]);
    b.on('GET /identities', json(page(identities)));
    await expect(c.listIdentities()).resolves.toBeTruthy();
    expect(b.calls).toHaveLength(1);
  });

  it('calls nothing before a session has told it the capabilities', async () => {
    const b = createBackend();
    const c = createApiClient({ fetchImpl: b.fetchMock as unknown as typeof fetch });
    await expect(c.listConversations()).rejects.toMatchObject({ state: 'unknown' });
    expect(b.calls).toEqual([]);
  });

  it('forgets capabilities after a 401 and after reset()', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('GET /conversations', json(fx.error401, 401));
    await expect(c.listConversations()).rejects.toBeInstanceOf(ApiError);
    await expect(c.listIdentities()).rejects.toBeInstanceOf(CapabilityError);
  });

  it('passes cursor and limit as query parameters', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('GET /conversations/c%2F1/messages?cursor=abc&limit=20', json(page([])));
    await c.listMessages('c/1', { cursor: 'abc', limit: 20 });
    expect(b.calls[0]!.path).toBe('/conversations/c%2F1/messages?cursor=abc&limit=20');
  });
});

describe('createSendAttempt', () => {
  it('sends the Idempotency-Key equal to client_attempt_id, the CSRF token and the body', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', (() => new Response(JSON.stringify(attempt('queued', { client_attempt_id: REQ.client_attempt_id })), { status: 201 })));
    const r = await c.createSendAttempt(REQ);
    expect(r.created).toBe(true);
    const call = b.calls[0]!;
    expect(call.headers.get('Idempotency-Key')).toBe(REQ.client_attempt_id);
    expect(call.headers.get('X-CSRF-Token')).toBe(fx.session.csrf_token);
    expect(JSON.parse(call.body!)).toEqual(REQ);
  });

  it('re-POSTing the same request is idempotent: same key and body, 200 is not "created"', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    const ok = (s: number) => () => new Response(JSON.stringify(attempt('transmitted', { client_attempt_id: REQ.client_attempt_id })), { status: s });
    b.on('POST /send-attempts', ok(201), ok(200));
    await c.createSendAttempt(REQ);
    const again = await c.createSendAttempt(REQ);
    expect(again.created).toBe(false);
    const [a, z] = b.calls;
    expect(z!.headers.get('Idempotency-Key')).toBe(a!.headers.get('Idempotency-Key'));
    expect(z!.body).toBe(a!.body);
  });

  it('a csrf_failed retry reuses the SAME Idempotency-Key and the SAME body, once', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on(
      'POST /send-attempts',
      json({ code: 'csrf_failed', message: 'x', request_id: 'r', retryable: false }, 403),
      () => new Response(JSON.stringify(attempt('queued', { client_attempt_id: REQ.client_attempt_id })), { status: 201 }),
    );
    b.on('GET /session', json({ ...sessionWith(ALL), csrf_token: 'csrf_rotated_0123456789' }));
    const r = await c.createSendAttempt(REQ);
    expect(r.attempt.status).toBe('queued');
    const posts = b.callsTo('POST /send-attempts');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers.get('Idempotency-Key')).toBe(posts[0]!.headers.get('Idempotency-Key'));
    expect(posts[1]!.headers.get('Idempotency-Key')).toBe(REQ.client_attempt_id);
    expect(posts[1]!.body).toBe(posts[0]!.body);
    expect(posts[1]!.headers.get('X-CSRF-Token')).toBe('csrf_rotated_0123456789');
  });

  it('retries csrf_failed at most once', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', json({ code: 'csrf_failed', message: 'x', request_id: 'r', retryable: false }, 403));
    b.on('GET /session', json(sessionWith(ALL)));
    await expect(c.createSendAttempt(REQ)).rejects.toMatchObject({ status: 403, code: 'csrf_failed' });
    expect(b.count('POST /send-attempts')).toBe(2);
  });

  it('a 409 is an error and is never retried', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', json({ code: 'conflict', message: 'key reuse', request_id: 'r9', retryable: false }, 409));
    const err = await c.createSendAttempt(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(b.count('POST /send-attempts')).toBe(1);
  });

  it('a network error is ambiguous, not a plain error, and is not retried inside the client', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(c.createSendAttempt(REQ)).rejects.toBeInstanceOf(AmbiguousSendError);
    expect(b.count('POST /send-attempts')).toBe(1);
  });

  it('a timeout is ambiguous', async () => {
    const b = createBackend();
    b.on('GET /session', json(sessionWith(ALL)));
    const hang = ((url: string, init?: RequestInit) =>
      url.endsWith('/session')
        ? b.fetchMock(url, init)
        : new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })) as unknown as typeof fetch;
    const c = createApiClient({ fetchImpl: hang, sendTimeoutMs: 20 });
    await c.getSession();
    await expect(c.createSendAttempt(REQ)).rejects.toBeInstanceOf(AmbiguousSendError);
  });

  it.each([500, 502, 503])('a %i answer is ambiguous (the request may have been processed)', async (status) => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', () => new Response('<html>bad gateway</html>', { status }));
    await expect(c.createSendAttempt(REQ)).rejects.toBeInstanceOf(AmbiguousSendError);
  });

  it('an unreadable 2xx, or an answer for another attempt, is ambiguous', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', () => new Response('not json', { status: 201 }));
    await expect(c.createSendAttempt(REQ)).rejects.toBeInstanceOf(AmbiguousSendError);
    b.on('POST /send-attempts', () => new Response(JSON.stringify(attempt('queued', { client_attempt_id: 'someone-else' })), { status: 201 }));
    await expect(c.createSendAttempt(REQ)).rejects.toBeInstanceOf(AmbiguousSendError);
  });

  it('422 is a definite refusal carrying the server message', async () => {
    const b = createBackend();
    const c = await signedIn(b, ALL);
    b.on('POST /send-attempts', json({ code: 'invalid', message: 'Text too long', request_id: 'r', retryable: false }, 422));
    await expect(c.createSendAttempt(REQ)).rejects.toMatchObject({ status: 422, message: 'Text too long' });
  });
});
