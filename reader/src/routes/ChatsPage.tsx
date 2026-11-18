import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { CapabilityState, Conversation, Message, Target } from '../api/types';
import { Empty, ErrorState, Forbidden, Loading, Offline, Unavailable, useOnline } from '../components/States';
import { describeAttempt, type LocalAttempt } from '../messaging/attemptStatus';
import { useMessaging } from '../messaging/MessagingContext';

/*
 * Filter chips. Rooms is deliberately absent: it is rendered only when a
 * session capability says rooms exist, and the contract has none yet.
 */
const FILTERS = [
  { id: 'all', label: 'All', empty: 'No conversations' },
  { id: 'unread', label: 'Unread', empty: 'No unread conversations' },
  { id: 'dms', label: 'DMs', empty: 'No direct messages' },
  { id: 'channels', label: 'Channels', empty: 'No channels' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

export function filterConversations(items: Conversation[], filter: FilterId): Conversation[] {
  switch (filter) {
    case 'unread':
      return items.filter((c) => c.unread_count > 0);
    case 'dms':
      return items.filter((c) => c.target.kind === 'contact');
    case 'channels':
      return items.filter((c) => c.target.kind === 'channel');
    default:
      return items;
  }
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
};

/* ------------------------------------------------------------------ list */

export function ChatsList({ state }: { state: CapabilityState }) {
  const [filter, setFilter] = useState<FilterId>('all');
  const online = useOnline();
  const current = FILTERS.find((f) => f.id === filter)!;
  const m = useMessaging();
  const { conversations, channels } = m;
  const { loadConversations, loadChannels, loadIdentities } = m;
  const available = state === 'available';

  useEffect(() => {
    if (!available) return;
    loadConversations();
    loadChannels();
    loadIdentities();
  }, [available, loadConversations, loadChannels, loadIdentities]);

  const shown = useMemo(() => filterConversations(conversations.items, filter), [conversations.items, filter]);
  // Channels the caller may read but that have no conversation yet.
  const channelsWithoutChat = useMemo(() => {
    const have = new Set(conversations.items.filter((c) => c.target.kind === 'channel').map((c) => c.target.id));
    return channels.items.filter((ch) => !have.has(ch.id));
  }, [conversations.items, channels.items]);
  const showEmptyChannels = filter === 'channels' || filter === 'all';

  let list;
  if (state === 'forbidden') list = <Forbidden />;
  else if (!available) {
    list = <Unavailable body="Messaging is not provided by this Backend yet." />;
  } else if (conversations.status === 'error') {
    list = online ? (
      <ErrorState title="Could not load conversations" body={conversations.error ?? undefined} requestId={conversations.requestId} />
    ) : (
      <Offline />
    );
  } else if (conversations.status !== 'ready') {
    list = online ? <Loading label="Loading conversations" /> : <Offline />;
  } else if (shown.length === 0 && !(showEmptyChannels && channelsWithoutChat.length > 0)) {
    list = (
      <Empty
        title={current.empty}
        body={
          conversations.nextCursor
            ? 'Nothing among the conversations loaded so far. Load more to look further back.'
            : 'Conversations you are authorized to see appear here.'
        }
      />
    );
  } else {
    list = (
      <ul className="conv-list">
        {shown.map((c) => (
          <li key={c.id}>
            <Link to={`/chats/c/${encodeURIComponent(c.id)}`} className="conv">
              <span className="conv-title">{c.title}</span>
              <span className="conv-meta">
                {c.target.kind === 'channel' ? 'Channel' : 'Direct'} · {fmtTime(c.last_activity_at)}
              </span>
              {c.unread_count > 0 && (
                <span className="conv-unread">
                  {c.unread_count}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </Link>
          </li>
        ))}
        {showEmptyChannels &&
          channelsWithoutChat.map((ch) => (
            <li key={`ch-${ch.id}`}>
              <Link to={`/chats/channel/${encodeURIComponent(ch.id)}`} className="conv">
                <span className="conv-title">{ch.name}</span>
                <span className="conv-meta">Channel · {ch.visibility} · no messages yet</span>
              </Link>
            </li>
          ))}
      </ul>
    );
  }

  return (
    <>
      <div className="chip-row" role="group" aria-label="Filter conversations">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <section className="list-region" aria-label={`${current.label} conversations`}>
        {list}
        {available && conversations.nextCursor && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={conversations.loadingMore}
            onClick={m.loadMoreConversations}
          >
            {conversations.loadingMore ? 'Loading…' : 'Load more conversations'}
          </button>
        )}
      </section>
      {available && <LiveStatus />}
      <p className="secondary-link">
        <Link to="/chats/contacts">Contacts</Link>
      </p>
    </>
  );
}

function LiveStatus() {
  const { streamStatus } = useMessaging();
  const { session } = useAuth();
  const eventsCap = session?.capabilities.events;
  let text: string;
  if (eventsCap !== 'available') text = 'Live updates are not available; the list updates when you reload it.';
  else if (streamStatus === 'live') text = 'Live updates connected.';
  else if (streamStatus === 'stopped') text = 'Live updates stopped.';
  else text = 'Live updates reconnecting…';
  return <p className="state-meta live-status">{text}</p>;
}

/* --------------------------------------------------------------- detail */

function sourceLabel(m: Message): string {
  return m.source_path === 'backend' ? 'Backend' : m.source_path === 'ble' ? 'Bluetooth' : 'unknown source';
}

function AttemptLine({ a, targetKind }: { a: LocalAttempt; targetKind: Target['kind'] }) {
  const m = useMessaging();
  const [confirming, setConfirming] = useState(false);
  const v = describeAttempt(a, targetKind);
  const canAgain = v.canSendAgain && !a.supersededBy && m.sendState === 'available';
  return (
    <div className={`attempt tone-${v.tone}`}>
      <p className="attempt-status">
        <span className="attempt-label">{v.label}</span>
        {v.detail && <span className="attempt-detail"> {v.detail}</span>}
      </p>
      {a.supersededBy && <p className="state-meta">Sent again as a new attempt.</p>}
      {v.canRecheck && !a.supersededBy && (
        <button type="button" className="btn btn-small" onClick={() => m.recheck(a.clientAttemptId)}>
          Check status
        </button>
      )}
      {canAgain && !confirming && (
        <button
          type="button"
          className="btn btn-small btn-secondary"
          onClick={() => (v.mayHaveTransmitted ? setConfirming(true) : m.sendAgain(a.clientAttemptId))}
        >
          Send again
        </button>
      )}
      {canAgain && confirming && (
        <div className="confirm" role="group" aria-label="Confirm sending again">
          <p>
            The earlier attempt may already have been transmitted. Sending again creates a new attempt and the
            recipient could receive the message twice.
          </p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setConfirming(false);
              m.sendAgain(a.clientAttemptId);
            }}
          >
            Send as a new attempt
          </button>
          <button type="button" className="btn btn-small btn-secondary" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function Bubble({
  text,
  out,
  meta,
  children,
}: {
  text: string;
  out: boolean;
  meta: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={out ? 'msg msg-out' : 'msg msg-in'}>
      <p className="msg-meta">{meta}</p>
      <p className="msg-text">{text}</p>
      {children}
    </li>
  );
}

function MessageThread({ conversation, target }: { conversation: Conversation | null; target: Target }) {
  const m = useMessaging();
  const online = useOnline();
  const id = conversation?.id ?? null;
  const page = id ? m.messagesFor(id) : null;
  const attempts = m.attemptsFor(target);
  const { openConversation, loadMessages } = m;

  useEffect(() => {
    if (!id) return;
    openConversation(id);
    loadMessages(id);
    return () => openConversation(null);
  }, [id, openConversation, loadMessages]);

  const idents = m.identities.items;
  const nameOf = (identityId: string | null) =>
    idents.find((i) => i.id === identityId)?.display_name ?? 'You';

  // Server attempt id -> local attempt, so one message shows one status line.
  const byAttempt = new Map<string, LocalAttempt>();
  for (const a of attempts) {
    byAttempt.set(a.clientAttemptId, a);
    if (a.attempt) byAttempt.set(a.attempt.id, a);
  }
  const merged = new Set<string>();
  const chronological = page ? [...page.items].reverse() : [];
  for (const msg of chronological) {
    const a = msg.attempt_id ? byAttempt.get(msg.attempt_id) : undefined;
    if (a) merged.add(a.clientAttemptId);
  }
  const pending = attempts.filter((a) => !merged.has(a.clientAttemptId));

  let history = null;
  if (id && page) {
    if (page.status === 'error') {
      history = online ? (
        <ErrorState title="Could not load messages" body={page.error ?? undefined} requestId={page.requestId} />
      ) : (
        <Offline />
      );
    } else if (page.status !== 'ready') {
      history = online ? <Loading label="Loading messages" /> : <Offline />;
    } else if (chronological.length === 0) {
      history = <Empty title="No messages yet" />;
    }
  } else if (!id) {
    history = <Empty title="No messages yet" body="Messages appear here after the first one is sent or heard." />;
  }

  return (
    <div className="thread">
      {page?.nextCursor && (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page.loadingMore}
          onClick={() => m.loadOlderMessages(id!)}
        >
          {page.loadingMore ? 'Loading…' : 'Load older messages'}
        </button>
      )}
      {history}
      <ol className="msg-list" aria-label="Messages">
        {chronological.map((msg) => {
          const out = msg.direction === 'outbound';
          // Channel traffic has no identity: sender_label is all there is.
          const sender = out
            ? msg.identity_id
              ? nameOf(msg.identity_id)
              : 'You'
            : (msg.sender_label ?? 'Unknown sender');
          const a = msg.attempt_id ? byAttempt.get(msg.attempt_id) : undefined;
          return (
            <Bubble
              key={msg.message_id}
              out={out}
              text={msg.content.text}
              meta={`${sender} · ${fmtTime(msg.observed_at)} · via ${sourceLabel(msg)}`}
            >
              {a && <AttemptLine a={a} targetKind={target.kind} />}
            </Bubble>
          );
        })}
        {pending.map((a) => (
          <Bubble key={a.clientAttemptId} out text={a.request.content.text} meta="You · not yet in history · via Backend">
            <AttemptLine a={a} targetKind={target.kind} />
          </Bubble>
        ))}
      </ol>
    </div>
  );
}

function Composer({ target, defaultIdentityId }: { target: Target; defaultIdentityId: string | null }) {
  const m = useMessaging();
  const [picked, setPicked] = useState<string | null>(null);
  const sendable = m.identities.items.filter((i) => i.can_send);
  const chosen =
    sendable.find((i) => i.id === picked) ??
    sendable.find((i) => i.id === defaultIdentityId) ??
    sendable[0] ??
    null;
  const text = m.draftText(target);

  if (m.sendState === 'forbidden') return <Forbidden title="Sending is not permitted" />;
  if (m.sendState !== 'available') return <Unavailable title="Sending is not available" body="This Backend does not provide sending yet." />;
  if (m.identities.status === 'error') return <ErrorState title="Could not load your identities" body="Sending needs them." />;
  if (m.identities.status !== 'ready') return <Loading label="Loading identities" />;
  if (!chosen) {
    return <Unavailable title="No identity can send" body="None of your messaging identities is allowed to send." />;
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        m.send(target, chosen.id);
      }}
    >
      {sendable.length > 1 ? (
        <label className="composer-field">
          Send as
          <select value={chosen.id} onChange={(e) => setPicked(e.target.value)}>
            {sendable.map((i) => (
              <option key={i.id} value={i.id}>
                {i.display_name} ({i.public_key_prefix})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="state-meta">Sending as {chosen.display_name}</p>
      )}
      <label className="composer-field">
        Message
        <textarea rows={3} value={text} onChange={(e) => m.setDraftText(target, e.target.value)} />
      </label>
      <p className="state-meta">Sent through the Backend. Each tap of Send is one attempt.</p>
      <button type="submit" className="btn" disabled={text.trim() === ''}>
        Send
      </button>
    </form>
  );
}

function ConversationView({
  conversation,
  target,
  title,
}: {
  conversation: Conversation | null;
  target: Target | null;
  title: string;
}) {
  return (
    <div className="conv-view">
      <p className="secondary-link back-link">
        <Link to="/chats">Back to conversations</Link>
      </p>
      <h2 className="conv-heading">{title}</h2>
      {target ? (
        <>
          <MessageThread conversation={conversation} target={target} />
          <Composer target={target} defaultIdentityId={conversation?.identity_id ?? null} />
        </>
      ) : (
        <Unavailable
          title="Cannot reply here"
          body="This conversation is not in the loaded list, so its target is unknown. Open it from the list."
        />
      )}
    </div>
  );
}

function ConversationRoute() {
  const { conversationId = '' } = useParams();
  const { conversations } = useMessaging();
  const conv = conversations.items.find((c) => c.id === conversationId) ?? null;
  return (
    <ConversationView
      key={conversationId}
      conversation={conv ?? ({ id: conversationId } as Conversation)}
      target={conv?.target ?? null}
      title={conv?.title ?? 'Conversation'}
    />
  );
}

function ChannelRoute() {
  const { channelId = '' } = useParams();
  const { channels, conversations } = useMessaging();
  const ch = channels.items.find((c) => c.id === channelId);
  const existing = conversations.items.find((c) => c.target.kind === 'channel' && c.target.id === channelId);
  if (existing) return <Navigate to={`/chats/c/${encodeURIComponent(existing.id)}`} replace />;
  if (channels.status !== 'ready') return <Loading label="Loading channel" />;
  if (!ch) return <Unavailable title="Channel not available" body="This channel is not available to your account." />;
  return (
    <ConversationView
      key={channelId}
      conversation={null}
      target={{ kind: 'channel', id: ch.id }}
      title={ch.name}
    />
  );
}

function ChatsLayout({ detail }: { detail: React.ReactNode | null }) {
  const { session } = useAuth();
  const state: CapabilityState = session?.capabilities.messaging ?? 'unavailable';
  return (
    <section className={detail ? 'split has-detail' : 'split'} aria-labelledby="h-chats">
      <div className="pane pane-list">
        <h1 id="h-chats">Conversations</h1>
        <ChatsList state={state} />
      </div>
      <section className="pane pane-detail" aria-label="Chats detail">
        {detail ?? <p className="state-body">Nothing selected.</p>}
      </section>
    </section>
  );
}

export function ChatsRoutes() {
  const { session } = useAuth();
  const available = session?.capabilities.messaging === 'available';
  return (
    <Routes>
      <Route path="c/:conversationId" element={<ChatsLayout detail={available ? <ConversationRoute /> : null} />} />
      <Route path="channel/:channelId" element={<ChatsLayout detail={available ? <ChannelRoute /> : null} />} />
      <Route path="*" element={<ChatsLayout detail={null} />} />
    </Routes>
  );
}

export function ContactsPage() {
  return (
    <section className="split" aria-labelledby="h-contacts">
      <div className="pane pane-list">
        <p className="secondary-link">
          <Link to="/chats">Back to Chats</Link>
        </p>
        <h1 id="h-contacts">Contacts</h1>
        <Unavailable title="Contacts are not available" body="Contacts will appear here once the Backend provides them." />
      </div>
      <section className="pane pane-detail" aria-label="Contact detail">
        <p className="state-body">Nothing selected.</p>
      </section>
    </section>
  );
}


