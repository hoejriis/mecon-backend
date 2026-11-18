// Synthetic M2 fixtures for Reader tests. Every id, name and time is made up.
// Contract fixtures (contracts/reader-api/v1/fixtures) are reused where they exist.
import type {
  Channel,
  Conversation,
  Identity,
  Message,
  SendAttempt,
  SendRequest,
  SendStatus,
  EventEnvelope,
} from '../api/types';
import conversationOne from '../../../contracts/reader-api/v1/fixtures/conversation-one.json';
import error404 from '../../../contracts/reader-api/v1/fixtures/error-404-conversation.json';
import mergedPair from '../../../contracts/reader-api/v1/fixtures/conversations-merged-pair.json';
import channelMessages from '../../../contracts/reader-api/v1/fixtures/messages-channel-null-identity.json';
import deviceUnknown from '../../../contracts/reader-api/v1/fixtures/send-attempt-device-unknown.json';
import unsupportedTransmitted from '../../../contracts/reader-api/v1/fixtures/send-attempt-unsupported-transmitted.json';

export const notFound404 = error404;

export const AS_OF = '2030-01-15T10:00:00Z';

export const page = <T>(items: T[], next_cursor: string | null = null) => ({ items, next_cursor, as_of: AS_OF });

export const identities: Identity[] = [
  { id: 'ident_demo_0001', display_name: 'Demo Companion', public_key_prefix: 'a1b2c3', device_id: 'dev_demo_0001', can_send: true },
  { id: 'ident_demo_0002', display_name: 'Demo Spare', public_key_prefix: 'd4e5f6', device_id: null, can_send: true },
  { id: 'ident_demo_0003', display_name: 'Watch-only identity', public_key_prefix: '010203', device_id: null, can_send: false },
];

export const dmConversation = mergedPair.items[0] as Conversation;

/** A conversation outside the first list page, as GET /conversations/{id} returns it. */
export const deepConversation: Conversation = {
  ...(conversationOne as Conversation),
  id: 'conv_demo_0009',
  title: 'Deep Link Peer',
  unread_count: 0,
};

export const channelConversation: Conversation = {
  id: 'conv_demo_0002',
  identity_id: 'ident_demo_0001',
  target: { kind: 'channel', id: 'chan_demo_0001' },
  title: 'Demo Channel',
  unread_count: 0,
  last_activity_at: '2030-01-15T09:55:00Z',
};

export const olderConversation: Conversation = {
  id: 'conv_demo_0003',
  identity_id: 'ident_demo_0001',
  target: { kind: 'contact', id: 'contact_demo_0003' },
  title: 'Older Peer',
  unread_count: 0,
  last_activity_at: '2030-01-14T09:00:00Z',
};

export const channels: Channel[] = [
  { id: 'chan_demo_0001', name: 'Demo Channel', visibility: 'public' },
  { id: 'chan_demo_0002', name: 'Quiet Private Channel', visibility: 'private' },
];

export const channelMsgs = channelMessages.items as Message[];

export const dmMessages: Message[] = [
  {
    message_id: 'msg_dm_0002',
    conversation_id: dmConversation.id,
    identity_id: null,
    direction: 'inbound',
    sender_label: 'Demo Peer',
    source_path: 'backend',
    observed_at: '2030-01-15T09:58:00Z',
    content: { kind: 'text', text: 'Hello from the peer' },
    attempt_id: null,
  },
  {
    message_id: 'msg_dm_0001',
    conversation_id: dmConversation.id,
    identity_id: 'ident_demo_0001',
    direction: 'outbound',
    sender_label: null,
    source_path: 'backend',
    observed_at: '2030-01-15T09:50:00Z',
    content: { kind: 'text', text: 'Earlier outbound' },
    attempt_id: null,
  },
];

export function attempt(status: SendStatus, over: Partial<SendAttempt> = {}, source: 'device' | 'unsupported' = 'device'): SendAttempt {
  const base = (source === 'device' ? deviceUnknown : unsupportedTransmitted) as unknown as SendAttempt;
  return {
    ...base,
    id: 'att_srv_0001',
    client_attempt_id: 'will-be-overridden',
    status,
    status_evidence: { ...base.status_evidence, source, detail: null },
    ...over,
  };
}

/** Answer a POST /send-attempts body with an attempt for the same client_attempt_id. */
export function attemptFor(body: string | null, status: SendStatus, source: 'device' | 'unsupported' = 'device', over: Partial<SendAttempt> = {}): SendAttempt {
  const req = JSON.parse(body ?? '{}') as SendRequest;
  return attempt(status, { client_attempt_id: req.client_attempt_id, identity_id: req.identity_id, ...over }, source);
}

export function envelope(kind: string, id: string, resource: string | null = null): EventEnvelope {
  return { event_id: id, kind, occurred_at: AS_OF, resource_id: resource, version: 1 } as EventEnvelope;
}
