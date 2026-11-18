import type { Page, Route } from '@playwright/test';
import { fixture } from './backend';

type Json = Record<string, unknown>;

export interface PostRecord {
  key: string;
  csrf: string;
  body: Json;
}

export interface MsgBackend {
  posts: PostRecord[];
  /** POST /conversations/{id}/read calls. */
  reads: Array<{ conversationId: string; csrf: string; body: Json }>;
  /** GET /conversations/{id} calls (deep links). */
  conversationGets: string[];
  /** ok: answer 201 queued. abort: the connection fails (ambiguous). */
  postMode: 'ok' | 'abort';
  attempts: Map<string, Json>;
  eventLog: Array<{ id: string; env: Json }>;
  eventRequests: Array<{ lastEventId: string | null }>;
  /** Move an accepted attempt to a new status and publish attempt_status. */
  setAttemptStatus(attemptId: string, status: string): void;
}

const AS_OF = '2030-01-15T10:00:00Z';
const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: AS_OF });

/**
 * A stateful fake Backend for the M2 journeys. Events are delivered as a
 * finite text/event-stream per connection (Playwright cannot hold a response
 * open): the Reader reconnects with Last-Event-ID, which is what is asserted.
 */
export async function mockMessagingBackend(
  page_: Page,
  opts: { identityPrefix?: string; channelName?: string; contactPrefix?: string } = {},
): Promise<MsgBackend> {
  const session = fixture('session-device-user');
  session.capabilities = { devices: 'available', messaging: 'available', send: 'available', events: 'available', observations: 'unavailable' };
  const conversations = [
    ...fixture('conversations-merged-pair').items,
    {
      id: 'conv_demo_0002',
      identity_id: 'ident_demo_0001',
      target: { kind: 'channel', id: 'chan_demo_0001' },
      title: 'Demo Channel',
      unread_count: 0,
      last_activity_at: '2030-01-15T09:55:00Z',
    },
  ];
  const identities = [
    { id: 'ident_demo_0001', display_name: 'Demo Companion', public_key_prefix: opts.identityPrefix ?? 'a1b2c3', device_id: 'dev_demo_0001', can_send: true },
    { id: 'ident_demo_0003', display_name: 'Watch-only identity', public_key_prefix: '010203', device_id: null, can_send: false },
  ];
  const channelMsgs = fixture('messages-channel-null-identity').items.filter((m: Json) => m.conversation_id === 'conv_demo_0002');
  const dmMsgs = [
    {
      message_id: 'msg_dm_0001', conversation_id: 'conv_demo_0001', identity_id: null, direction: 'inbound',
      sender_label: 'Demo Peer', source_path: 'backend', observed_at: '2030-01-15T09:58:00Z',
      content: { kind: 'text', text: 'Hello from the peer' }, attempt_id: null,
    },
  ];
  const channels = [{ id: 'chan_demo_0001', name: opts.channelName ?? 'Demo Channel', visibility: 'public' }];
  // The DM peer of the demo conversation is Alice on the synthetic device (key prefix a1a1a1).
  const contacts = [{ id: 'contact_demo_0001', display_name: 'Demo Peer', public_key_prefix: opts.contactPrefix ?? 'a1a1a1', kind: 'companion', last_heard_at: '2030-01-15T09:58:00Z' }];

  // Not in the list page, so reachable only by GET /conversations/{id}.
  const deepConversation = {
    id: 'conv_demo_0009',
    identity_id: 'ident_demo_0001',
    target: { kind: 'contact', id: 'contact_demo_0009' },
    title: 'Deep Link Peer',
    unread_count: 0,
    last_activity_at: '2030-01-14T09:00:00Z',
  };
  const st: MsgBackend = {
    posts: [],
    reads: [],
    conversationGets: [],
    postMode: 'ok',
    attempts: new Map(),
    eventLog: [],
    eventRequests: [],
    setAttemptStatus(attemptId, status) {
      const a = st.attempts.get(attemptId)!;
      a.status = status;
      a.updated_at = AS_OF;
      const n = st.eventLog.length + 1;
      st.eventLog.push({
        id: `evt_${n}`,
        env: { event_id: `evt_${n}`, kind: 'attempt_status', occurred_at: AS_OF, resource_id: attemptId, version: 1 },
      });
    },
  };
  const j = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  let seq = 0;

  await page_.route('**/api/reader/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/reader/v1', '');
    const m = req.method();
    if (m === 'GET' && path === '/session') return j(route, 200, session);
    if (m === 'GET' && path === '/health') return j(route, 200, fixture('health'));
    if (m === 'GET' && path === '/identities') return j(route, 200, page(identities));
    if (m === 'GET' && path === '/channels') return j(route, 200, page(channels));
    if (m === 'GET' && path === '/contacts') return j(route, 200, page(contacts));
    if (m === 'GET' && path === '/conversations') return j(route, 200, page(conversations));
    if (m === 'GET' && path === '/conversations/conv_demo_0001/messages') return j(route, 200, page(dmMsgs));
    if (m === 'GET' && path === '/conversations/conv_demo_0002/messages') return j(route, 200, page(channelMsgs));
    const cm = /^\/conversations\/([^/]+)$/.exec(path);
    if (m === 'GET' && cm) {
      const id = decodeURIComponent(cm[1]!);
      st.conversationGets.push(id);
      const found = id === deepConversation.id ? deepConversation : conversations.find((c) => c.id === id);
      return found ? j(route, 200, found) : j(route, 404, fixture('error-404-conversation'));
    }
    if (m === 'GET' && path === `/conversations/${deepConversation.id}/messages`) return j(route, 200, page([]));
    const rm = /^\/conversations\/([^/]+)\/read$/.exec(path);
    if (m === 'POST' && rm) {
      st.reads.push({
        conversationId: decodeURIComponent(rm[1]!),
        csrf: req.headers()['x-csrf-token'] ?? '',
        body: JSON.parse(req.postData() ?? '{}') as Json,
      });
      return route.fulfill({ status: 204 });
    }
    if (m === 'POST' && path === '/send-attempts') {
      const body = JSON.parse(req.postData() ?? '{}') as Json;
      const h = req.headers();
      st.posts.push({ key: h['idempotency-key'] ?? '', csrf: h['x-csrf-token'] ?? '', body });
      if (st.postMode === 'abort') return route.abort('failed');
      const existing = [...st.attempts.values()].find((a) => a.client_attempt_id === body.client_attempt_id);
      if (existing) return j(route, 200, existing);
      const attempt = {
        id: `att_srv_${++seq}`,
        client_attempt_id: body.client_attempt_id,
        path: 'backend',
        identity_id: body.identity_id,
        status: 'queued',
        status_evidence: { accepted_at: AS_OF, first_transmitted_at: null, transmissions: 0, acked_at: null, detail: null, source: 'device' },
        created_at: AS_OF,
        updated_at: AS_OF,
      };
      st.attempts.set(attempt.id as string, attempt);
      return j(route, 201, attempt);
    }
    const am = /^\/send-attempts\/(.+)$/.exec(path);
    if (m === 'GET' && am) {
      const a = st.attempts.get(decodeURIComponent(am[1]!));
      return a ? j(route, 200, a) : j(route, 404, { code: 'not_found', message: 'x', request_id: 'r', retryable: false });
    }
    if (m === 'GET' && path === '/events') {
      const last = req.headers()['last-event-id'] ?? null;
      st.eventRequests.push({ lastEventId: last });
      // Hold the connection briefly for news, then answer with what is new.
      const seen = () => {
        const i = last ? st.eventLog.findIndex((e) => e.id === last) : -1;
        return st.eventLog.slice(i + 1);
      };
      for (let t = 0; t < 20 && seen().length === 0; t++) await new Promise((r) => setTimeout(r, 100));
      const body = ': heartbeat\n\n' + seen().map((e) => `id: ${e.id}\ndata: ${JSON.stringify(e.env)}\n\n`).join('');
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }, body });
    }
    return j(route, 404, { code: 'not_found', message: 'x', request_id: 'r', retryable: false });
  });
  return st;
}
