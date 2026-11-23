import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import type { SendRequest } from '../api/types';
import { collectBlockers } from '../update/guards';
import { createBackend, fx, json, sessionWith, type Backend } from './backend';
import {
  attemptFor,
  channelConversation,
  channelMsgs,
  channels,
  deepConversation,
  dmConversation,
  dmMessages,
  envelope,
  identities,
  notFound404,
  olderConversation,
  page,
} from './m2';

let b: Backend;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const posted = () => b.callsTo('POST /send-attempts');
const sentIds = () => posted().map((c) => (JSON.parse(c.body!) as SendRequest).client_attempt_id);

function mount(path = '/chats') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function routes(over: { send?: 'available' | 'unavailable'; messaging?: 'available' | 'unavailable' } = {}) {
  b.on('GET /session', json(sessionWith({ messaging: over.messaging ?? 'available', send: over.send ?? 'available', events: 'unavailable' })));
  b.on('GET /conversations?limit=50', json(page([dmConversation, channelConversation], 'cur_2')));
  b.on('GET /conversations?cursor=cur_2&limit=50', json(page([olderConversation])));
  b.on('GET /identities', json(page(identities)));
  b.on('GET /channels', json(page(channels)));
  b.on(`GET /conversations/${dmConversation.id}/messages?limit=50`, json(page(dmMessages, 'old_1')));
  b.on(`GET /conversations/${dmConversation.id}/messages?cursor=old_1&limit=50`, json(page([{ ...dmMessages[1]!, message_id: 'msg_dm_0000', content: { kind: 'text', text: 'Much older' } }])));
  b.on(`GET /conversations/${channelConversation.id}/messages?limit=50`, json(page(channelMsgs.filter((m) => m.conversation_id === channelConversation.id))));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  b = createBackend();
  vi.stubGlobal('fetch', b.fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openDm(user: ReturnType<typeof userEvent.setup>) {
  mount();
  await user.click(await screen.findByRole('link', { name: /Demo Peer \(merged pair\)/ }));
  await screen.findByText('Hello from the peer');
}

describe('conversation list', () => {
  it('lists real conversations, filters them, and pages with next_cursor', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    expect(await screen.findByRole('link', { name: /Demo Peer \(merged pair\)/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Demo Channel/ })).toBeInTheDocument();
    expect(screen.queryByText('Older Peer')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unread' }));
    expect(screen.getByRole('link', { name: /Demo Peer/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Demo Channel/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'DMs' }));
    expect(screen.getByRole('link', { name: /Demo Peer/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Demo Channel/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Channels' }));
    expect(screen.getByRole('link', { name: /Demo Channel/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Demo Peer/ })).not.toBeInTheDocument();
    // A channel the user may read, with no conversation yet, is listed too.
    expect(screen.getByRole('link', { name: /Quiet Private Channel/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Load more conversations' }));
    expect(await screen.findByRole('link', { name: /Older Peer/ })).toBeInTheDocument();
    expect(b.count('GET /conversations?cursor=cur_2&limit=50')).toBe(1);
    expect(screen.queryByRole('button', { name: 'Load more conversations' })).not.toBeInTheDocument();
    // a merged pair is one row: trust the server's ids
    expect(screen.getAllByRole('link', { name: /Demo Peer/ })).toHaveLength(1);
  });

  it('makes no messaging request when the capability is unavailable, and says so', async () => {
    routes({ messaging: 'unavailable' });
    mount();
    expect(await screen.findByText('Messaging is not provided by this Backend yet.')).toBeInTheDocument();
    expect(b.calls.filter((c) => c.api && c.path !== '/session')).toEqual([]);
  });

  it('a 401 on the list takes the existing sign-out path', async () => {
    routes();
    b.on('GET /conversations?limit=50', json(fx.error401, 401));
    mount();
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
  });
});

describe('event stream', () => {
  it('a session_revoked envelope takes the existing sign-out path and the stream is not reopened', async () => {
    routes();
    b.on('GET /session', json(sessionWith({ messaging: 'available', send: 'available', events: 'available' })));
    b.on('GET /events', () =>
      new Response(`data: ${JSON.stringify(envelope('session_revoked', 'evc_1'))}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    mount();
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    await tick(60_000);
    expect(b.count('GET /events')).toBe(1);
  });
});

describe('conversation view', () => {
  it('shows history oldest-to-newest, with older pages on demand', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    const list = screen.getByRole('list', { name: 'Messages' });
    const texts = within(list).getAllByText(/Earlier outbound|Hello from the peer/).map((e) => e.textContent);
    expect(texts).toEqual(['Earlier outbound', 'Hello from the peer']);
    await user.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Much older')).toBeInTheDocument();
    expect(b.count(`GET /conversations/${dmConversation.id}/messages?cursor=old_1&limit=50`)).toBe(1);
  });

  it('a channel message with a null identity shows sender_label only', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.click(await screen.findByRole('link', { name: /Demo Channel/ }));
    const msg = (await screen.findByText('Synthetic channel message')).closest('li')!;
    expect(msg).toHaveTextContent('Demo Sender');
    expect(msg).not.toHaveTextContent(/You|Demo Companion/);
  });

  it('offers only identities with can_send, and sends with the chosen one', async () => {
    routes();
    b.on('POST /send-attempts', (() => {
      const body = b.calls.at(-1)!.body;
      return new Response(JSON.stringify(attemptFor(body, 'queued')), { status: 201 });
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    const select = screen.getByLabelText('Send as');
    const opts = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toHaveLength(2);
    expect(opts.join()).not.toMatch(/Watch-only/);
    await user.selectOptions(select, 'ident_demo_0002');
    await user.type(screen.getByLabelText('Message'), 'hello there');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Queued');
    const body = JSON.parse(posted()[0]!.body!) as SendRequest;
    expect(body).toMatchObject({ identity_id: 'ident_demo_0002', target: dmConversation.target, content: { kind: 'text', text: 'hello there' } });
    expect(body.client_draft_id).toBeTruthy();
    expect(posted()[0]!.headers.get('Idempotency-Key')).toBe(body.client_attempt_id);
  });

  it('no composer without the send capability, and no message text in web storage', async () => {
    routes({ send: 'unavailable' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    expect(screen.getByText('Sending is not available')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(b.count('GET /send-attempts/x')).toBe(0);
  });
});

describe('deep link to a conversation outside the loaded pages', () => {
  it('fetches it by id and shows its target and composer', async () => {
    routes();
    b.on(`GET /conversations/${deepConversation.id}`, json(deepConversation));
    b.on(`GET /conversations/${deepConversation.id}/messages?limit=50`, json(page([])));
    mount(`/chats/c/${deepConversation.id}`);
    expect(await screen.findByRole('heading', { name: 'Deep Link Peer' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Message')).toBeInTheDocument();
    expect(screen.queryByText('Cannot reply here')).not.toBeInTheDocument();
    expect(b.count(`GET /conversations/${deepConversation.id}`)).toBe(1);
  });

  it('a 404 is an honest not-found state with no composer and no messages request', async () => {
    routes();
    b.on('GET /conversations/conv_missing', json(notFound404, 404));
    mount('/chats/c/conv_missing');
    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(b.calls.filter((c) => c.path.includes('conv_missing/messages'))).toEqual([]);
  });

  it('a listed conversation is not fetched by id', async () => {
    routes();
    b.on(`POST /conversations/${dmConversation.id}/read`, () => new Response(null, { status: 204 }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    expect(b.calls.filter((c) => c.path === `/conversations/${dmConversation.id}`)).toEqual([]);
  });
});

describe('mark read', () => {
  const readKey = `POST /conversations/${dmConversation.id}/read`;

  it('opening a conversation with unread messages POSTs up_to the newest message once, with CSRF', async () => {
    routes();
    b.on(readKey, () => new Response(null, { status: 204 }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await waitFor(() => expect(b.count(readKey)).toBe(1));
    const call = b.callsTo(readKey)[0]!;
    expect(JSON.parse(call.body!)).toEqual({ up_to: 'msg_dm_0002' });
    expect(call.headers.get('X-CSRF-Token')).toBe('csrf_synthetic_0123456789abcdef');
    await tick(10_000);
    expect(b.count(readKey)).toBe(1);
  });

  it('is not sent when unread_count is 0', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.click(await screen.findByRole('link', { name: /Demo Channel/ }));
    await screen.findByText('Synthetic channel message');
    await tick(5_000);
    expect(b.calls.filter((c) => c.path.endsWith('/read'))).toEqual([]);
  });

  it('a failure is non-fatal and never retried in a loop', async () => {
    routes();
    b.on(readKey, json({ code: 'unavailable', message: 'x', request_id: 'r', retryable: true }, 503));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await waitFor(() => expect(b.count(readKey)).toBe(1));
    await tick(60_000);
    expect(b.count(readKey)).toBe(1);
    expect(screen.getByText('Hello from the peer')).toBeInTheDocument();
  });

  it('is not sent when messaging is unavailable', async () => {
    routes({ messaging: 'unavailable' });
    mount(`/chats/c/${dmConversation.id}`);
    await tick(2_000);
    expect(b.calls.filter((c) => c.api && c.path !== '/session')).toEqual([]);
  });
});

describe('send safety in the UI', () => {
  async function typeAndSend(user: ReturnType<typeof userEvent.setup>, text = 'hello there') {
    await user.type(screen.getByLabelText('Message'), text);
    await user.click(screen.getByRole('button', { name: 'Send' }));
  }

  it('an ambiguous POST shows "outcome unknown", never failed, re-POSTs only the SAME attempt, then waits for the user', async () => {
    routes();
    b.on('POST /send-attempts', () => {
      throw new TypeError('Failed to fetch');
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await screen.findByText('Outcome unknown — not resent');
    await tick(10_000); // both automatic same-attempt re-POSTs have run
    expect(posted()).toHaveLength(3);
    expect(new Set(sentIds()).size).toBe(1);
    expect(new Set(posted().map((c) => c.headers.get('Idempotency-Key'))).size).toBe(1);
    expect(new Set(posted().map((c) => c.body)).size).toBe(1);
    expect(screen.queryByText(/^Failed$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument();
    await tick(60_000);
    expect(posted()).toHaveLength(3); // nothing more without a user action
    expect(new Set(sentIds()).size).toBe(1);
  });

  it('"Check status" re-POSTs the same attempt and learns it was accepted', async () => {
    routes();
    let n = 0;
    b.on('POST /send-attempts', () => {
      if (n++ < 3) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'transmitted')), { status: 200 });
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await tick(10_000);
    await user.click(await screen.findByRole('button', { name: 'Check status' }));
    await screen.findByText('Transmitted');
    expect(new Set(sentIds()).size).toBe(1);
    expect(posted()).toHaveLength(4);
  });

  it('"Send again" asks first, then uses a NEW attempt id for the same draft', async () => {
    routes();
    let n = 0;
    b.on('POST /send-attempts', () => {
      if (n++ < 3) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'queued')), { status: 201 });
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await tick(10_000);
    await user.click(await screen.findByRole('button', { name: 'Send again' }));
    expect(screen.getByText(/may already have been transmitted/)).toBeInTheDocument();
    expect(posted()).toHaveLength(3); // nothing sent by asking
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posted()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    await user.click(screen.getByRole('button', { name: 'Send as a new attempt' }));
    await screen.findByText('Queued');
    const ids = sentIds();
    expect(new Set(ids).size).toBe(2);
    const bodies = posted().map((c) => JSON.parse(c.body!) as SendRequest);
    expect(bodies[3]!.client_attempt_id).not.toBe(bodies[0]!.client_attempt_id);
    expect(bodies[3]!.client_draft_id).toBe(bodies[0]!.client_draft_id);
    expect(bodies[3]!.content).toEqual(bodies[0]!.content);
  });

  it('a 409 is shown as an error and nothing is retried', async () => {
    routes();
    b.on('POST /send-attempts', json({ code: 'conflict', message: 'x', request_id: 'r', retryable: true }, 409));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await screen.findByText(/internal error/);
    await tick(60_000);
    expect(posted()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Send again' })).not.toBeInTheDocument();
  });

  it.each([400, 404])('a %i is a definite "Not sent", not an unknown outcome, and is not retried', async (status) => {
    routes();
    b.on('POST /send-attempts', json({ code: 'invalid', message: 'Refused', request_id: 'r', retryable: false }, status));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await screen.findByText('Not sent');
    expect(screen.queryByText('Outcome unknown — not resent')).not.toBeInTheDocument();
    await tick(60_000);
    expect(posted()).toHaveLength(1);
  });

  it('403 sending_disabled is a definite "Not sent", is not retried, and refreshes the session', async () => {
    routes();
    b.on('POST /send-attempts', json({ code: 'sending_disabled', message: 'off', request_id: 'r', retryable: false }, 403));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    const sessionsBefore = b.calls.filter((c) => c.path === '/session').length;
    await typeAndSend(user);
    await screen.findByText('Not sent');
    await screen.findByText(/Sending is switched off on this Backend/);
    expect(screen.queryByText('Outcome unknown — not resent')).not.toBeInTheDocument();
    await tick(60_000);
    expect(posted()).toHaveLength(1);
    expect(b.calls.filter((c) => c.path === '/session').length).toBeGreaterThan(sessionsBefore);
  });

  it('a 503 is ambiguous: the SAME attempt is re-POSTed and the outcome is never shown as not sent', async () => {
    routes();
    b.on('POST /send-attempts', () => new Response('unavailable', { status: 503 }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await screen.findByText('Outcome unknown — not resent');
    await tick(10_000);
    expect(posted()).toHaveLength(3);
    expect(new Set(sentIds()).size).toBe(1);
    expect(screen.queryByText('Not sent')).not.toBeInTheDocument();
  });

  it('a 422 surfaces the server text and the message was not sent', async () => {
    routes();
    b.on('POST /send-attempts', json({ code: 'invalid', message: 'Text exceeds the radio limit', request_id: 'r', retryable: false }, 422));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user, 'x'.repeat(10));
    await screen.findByText('Not sent');
    expect(screen.getByText(/Text exceeds the radio limit/)).toBeInTheDocument();
    expect(posted()).toHaveLength(1);
  });

  it('follows queued -> transmitted -> acked and labels acked as delivered to device, never read', async () => {
    routes();
    b.on('POST /send-attempts', (() => new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'queued')), { status: 201 })));
    b.on('GET /send-attempts/att_srv_0001', () => new Response(JSON.stringify(attemptFor(posted()[0]!.body, 'transmitted')), { status: 200 }), () => new Response(JSON.stringify(attemptFor(posted()[0]!.body, 'acked')), { status: 200 }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await screen.findByText('Queued');
    await tick(4100);
    await screen.findByText('Transmitted');
    await tick(4100);
    const label = await screen.findByText('Delivered to device (acknowledged)');
    expect(label.textContent).not.toMatch(/read/i);
    expect(sentIds()).toHaveLength(1);
  });

  it('a device-reported unknown from the server is not shown as failed', async () => {
    routes();
    b.on('POST /send-attempts', (() => new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'unknown')), { status: 201 })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await typeAndSend(user);
    await screen.findByText('Outcome unknown — not resent');
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
    expect(sentIds()).toHaveLength(1);
  });

  it('double-tapping Send creates one attempt', async () => {
    routes();
    b.on('POST /send-attempts', (() => new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'queued')), { status: 201 })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await user.type(screen.getByLabelText('Message'), 'once');
    const send = screen.getByRole('button', { name: 'Send' });
    await user.dblClick(send);
    await screen.findByText('Queued');
    expect(posted()).toHaveLength(1);
  });

  it('keeps message text out of web storage', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await user.type(screen.getByLabelText('Message'), 'secret words');
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/secret words/);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/secret words/);
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('secret words'));
  });
});

describe('update guards from the messaging state', () => {
  it('counts a non-empty draft, then an in-flight attempt, and counts nothing for a blank draft', async () => {
    routes();
    b.on('POST /send-attempts', (() => new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'queued')), { status: 201 })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    expect(collectBlockers()).toMatchObject({ drafts: 0, uncertainAttempts: 0 });
    await user.type(screen.getByLabelText('Message'), '   ');
    expect(collectBlockers().drafts).toBe(0);
    await user.clear(screen.getByLabelText('Message'));
    await user.type(screen.getByLabelText('Message'), 'unsent words');
    expect(collectBlockers().drafts).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Queued');
    // the draft was consumed by the send; the queued attempt has no final outcome
    expect(collectBlockers()).toMatchObject({ drafts: 0, uncertainAttempts: 1 });
  });

  it('counts an ambiguous (unknown) attempt', async () => {
    routes();
    b.on('POST /send-attempts', (() => {
      throw new TypeError('Failed to fetch');
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openDm(user);
    await user.type(screen.getByLabelText('Message'), 'maybe sent');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Outcome unknown — not resent');
    expect(collectBlockers().uncertainAttempts).toBe(1);
  });

  it('removes its guard when the messaging view unmounts', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const r = mount();
    await user.click(await screen.findByRole('link', { name: /Demo Peer \(merged pair\)/ }));
    await user.type(await screen.findByLabelText('Message'), 'gone soon');
    expect(collectBlockers().drafts).toBe(1);
    r.unmount();
    expect(collectBlockers().drafts).toBe(0);
  });
});
