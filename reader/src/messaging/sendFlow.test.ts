import { AmbiguousSendError, ApiError } from '../api/client';
import type { SendRequest } from '../api/types';
import { attempt } from '../test/m2';
import { postAttempt } from './sendFlow';

const REQ: SendRequest = {
  client_draft_id: 'draft-1',
  client_attempt_id: 'attempt-1',
  identity_id: 'ident_demo_0001',
  target: { kind: 'contact', id: 'contact_demo_0001' },
  content: { kind: 'text', text: 'hi' },
};
const instant = async () => {};

describe('postAttempt', () => {
  it('automatic re-POSTs after an ambiguous failure send the identical request object content', async () => {
    const seen: SendRequest[] = [];
    const api = {
      createSendAttempt: vi.fn(async (r: SendRequest) => {
        seen.push(structuredClone(r));
        if (seen.length < 3) throw new AmbiguousSendError(new TypeError('x'));
        return { attempt: attempt('queued', { client_attempt_id: r.client_attempt_id }), created: false };
      }),
    };
    const out = await postAttempt(api, REQ, { retryDelaysMs: [1, 1], sleep: instant });
    expect(out.phase).toBe('accepted');
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.client_attempt_id))).toEqual(new Set(['attempt-1']));
    expect(seen.every((s) => JSON.stringify(s) === JSON.stringify(REQ))).toBe(true);
  });

  it('stays ambiguous (never mints an id) when every re-POST is ambiguous', async () => {
    const api = { createSendAttempt: vi.fn(async () => { throw new AmbiguousSendError(null); }) };
    const out = await postAttempt(api, REQ, { retryDelaysMs: [1, 1], sleep: instant });
    expect(out).toEqual({ phase: 'ambiguous' });
    expect(api.createSendAttempt).toHaveBeenCalledTimes(3);
    for (const call of api.createSendAttempt.mock.calls as unknown as Array<[SendRequest]>) {
      expect(call[0].client_attempt_id).toBe('attempt-1');
    }
  });

  it('with no retry delays it posts exactly once', async () => {
    const api = { createSendAttempt: vi.fn(async () => { throw new AmbiguousSendError(null); }) };
    expect(await postAttempt(api, REQ)).toEqual({ phase: 'ambiguous' });
    expect(api.createSendAttempt).toHaveBeenCalledTimes(1);
  });

  it('a 409 is rejected as a key conflict and never retried, even with retries allowed', async () => {
    const api = {
      createSendAttempt: vi.fn(async () => {
        throw new ApiError(409, { code: 'conflict', message: 'm', request_id: 'r', retryable: true }, 'x');
      }),
    };
    const out = await postAttempt(api, REQ, { retryDelaysMs: [1, 1, 1], sleep: instant });
    expect(out).toMatchObject({ phase: 'rejected', error: { status: 409, keyConflict: true } });
    expect(api.createSendAttempt).toHaveBeenCalledTimes(1);
  });

  it.each([403, 422, 429])('a %i refusal is final and is not retried', async (status) => {
    const api = {
      createSendAttempt: vi.fn(async () => {
        throw new ApiError(status, { code: 'x', message: 'refused', request_id: 'r', retryable: true }, 'x');
      }),
    };
    const out = await postAttempt(api, REQ, { retryDelaysMs: [1, 1], sleep: instant });
    expect(out).toMatchObject({ phase: 'rejected', error: { status } });
    expect(api.createSendAttempt).toHaveBeenCalledTimes(1);
  });
});
