import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ApiClient } from '../api/client';
import type { SendRequest, Target } from '../api/types';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { sessionWith } from '../test/backend';
import { attempt, dmConversation } from '../test/m2';
import { MessagingProvider, useMessaging, type MessagingValue } from './MessagingContext';

// The client below accepts every request, so only MessagingContext's own gate can refuse one.
const TARGET: Target = dmConversation.target;
const IDENT = 'ident_demo_0001';
const NOT_AVAILABLE = { ok: false, reason: 'Sending through the Backend is not available.' };
const ALREADY = { ok: false, reason: 'This attempt was already sent again.' };

const latest: { current: MessagingValue | null } = { current: null };
const live = new Proxy({} as MessagingValue, {
  get: (_t, k) => (latest.current as unknown as Record<string | symbol, unknown>)[k],
});
function Probe() {
  const m = useMessaging();
  useEffect(() => {
    latest.current = m;
  });
  return null;
}

const createSendAttempt = vi.fn(async (req: SendRequest) => ({ attempt: attempt('queued', { client_attempt_id: req.client_attempt_id }), created: true }));
const api = { createSendAttempt } as unknown as ApiClient;

function tree(send: 'available' | 'unavailable') {
  const auth = { status: 'signedIn', session: sessionWith({ messaging: 'available', send, events: 'unavailable' }), api, refreshSession: async () => undefined } as unknown as AuthValue;
  return (
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <MessagingProvider pollMs={0} retryDelaysMs={[]}>
          <Probe />
        </MessagingProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  createSendAttempt.mockClear();
  latest.current = null;
});
afterEach(cleanup);

const backend = { path: 'backend' } as const;
const typed = (text: string) => act(() => live.setDraftText(TARGET, text));

describe('MessagingContext Backend send gate (the client would accept the request)', () => {
  it('send refuses when Backend sending is not available: the draft is kept and nothing is posted', async () => {
    render(tree('unavailable'));
    await waitFor(() => expect(latest.current).not.toBeNull());
    typed('hello');
    let r: unknown;
    act(() => {
      r = live.send(TARGET, IDENT, backend);
    });
    expect(r).toEqual(NOT_AVAILABLE);
    expect(live.draftText(TARGET)).toBe('hello');
    expect(live.attemptsFor(TARGET)).toHaveLength(0);
    await act(async () => new Promise((res) => setTimeout(res, 50)));
    expect(createSendAttempt).not.toHaveBeenCalled();
  });

  it('control: the same send goes through when Backend sending is available', async () => {
    render(tree('available'));
    await waitFor(() => expect(latest.current).not.toBeNull());
    typed('hello');
    let r: unknown;
    act(() => {
      r = live.send(TARGET, IDENT, backend);
    });
    expect(r).toEqual({ ok: true });
    await waitFor(() => expect(createSendAttempt).toHaveBeenCalledTimes(1));
  });

  it('send again refuses when Backend sending is not available: no new attempt and nothing is posted', async () => {
    const view = render(tree('available'));
    await waitFor(() => expect(latest.current).not.toBeNull());
    typed('hello');
    act(() => void live.send(TARGET, IDENT, backend));
    await waitFor(() => expect(createSendAttempt).toHaveBeenCalledTimes(1));
    const first = live.attemptsFor(TARGET)[0]!.clientAttemptId;

    view.rerender(tree('unavailable'));
    let r: unknown;
    act(() => {
      r = live.sendAgain(first, backend);
    });
    expect(r).toEqual(NOT_AVAILABLE);
    expect(live.attemptsFor(TARGET)).toHaveLength(1);
    expect(live.attemptsFor(TARGET)[0]!.supersededBy).toBeNull();
    await act(async () => new Promise((res) => setTimeout(res, 50)));
    expect(createSendAttempt).toHaveBeenCalledTimes(1);
  });

  it('an attempt that was already sent again is not sent a second time', async () => {
    render(tree('available'));
    await waitFor(() => expect(latest.current).not.toBeNull());
    typed('hello');
    act(() => void live.send(TARGET, IDENT, backend));
    await waitFor(() => expect(createSendAttempt).toHaveBeenCalledTimes(1));
    const first = live.attemptsFor(TARGET)[0]!.clientAttemptId;

    let r1: unknown;
    act(() => {
      r1 = live.sendAgain(first, backend);
    });
    expect(r1).toEqual({ ok: true });
    await waitFor(() => expect(createSendAttempt).toHaveBeenCalledTimes(2));

    let r2: unknown;
    act(() => {
      r2 = live.sendAgain(first, backend);
    });
    expect(r2).toEqual(ALREADY);
    await act(async () => new Promise((res) => setTimeout(res, 50)));
    expect(createSendAttempt).toHaveBeenCalledTimes(2);
    expect(live.attemptsFor(TARGET)).toHaveLength(2);
  });
});
