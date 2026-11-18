import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, CapabilityError } from '../api/client';
import { startEventStream, type StreamStatus } from '../api/eventStream';
import type {
  Channel,
  Conversation,
  EventEnvelope,
  Identity,
  Message,
  SendAttempt,
  SendRequest,
  Target,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useDevices } from '../device/DeviceContext';
import { registerUpdateGuard } from '../update/guards';
import { describeAttempt, isUncertainAttempt, pathOf, type LocalAttempt, type LocalPath, type LocalTarget } from './attemptStatus';
import { preflightLocal, runLocalSend } from './localSend';
import {
  DEFAULT_RETRY_DELAYS_MS,
  newAttemptId,
  newDraftId,
  postAttempt,
  type SendOutcome,
} from './sendFlow';

export interface Paged<T> {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: T[];
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
  requestId: string | null;
}

const idle = <T,>(): Paged<T> => ({
  status: 'idle',
  items: [],
  nextCursor: null,
  loadingMore: false,
  error: null,
  requestId: null,
});

export const PAGE_SIZE = 50;

export const targetKey = (t: Target) => `${t.kind}:${t.id}`;

/** Merge a freshly fetched first page into what is loaded, newest first. */
function mergeNewest<T>(
  old: T[],
  fresh: T[],
  key: (t: T) => string,
  time: (t: T) => string,
): T[] {
  const ids = new Set(fresh.map(key));
  const merged = [...fresh, ...old.filter((o) => !ids.has(key(o)))];
  return merged.sort((a, b) => (time(a) < time(b) ? 1 : time(a) > time(b) ? -1 : 0));
}

function failure(e: unknown): { error: string; requestId: string | null } {
  if (e instanceof ApiError) {
    return {
      error: e.status === 404 ? 'This is not available to your account.' : 'The Backend could not answer.',
      requestId: e.requestId,
    };
  }
  if (e instanceof CapabilityError) return { error: 'This is not available.', requestId: null };
  return { error: 'Could not reach the Backend.', requestId: null };
}

/** A conversation fetched by id because it was not in the loaded list pages. */
export type DeepLink =
  | { status: 'loading' }
  | { status: 'ready'; conversation: Conversation }
  | { status: 'notfound' }
  | { status: 'error'; error: string; requestId: string | null };

/**
 * The path of ONE send, chosen by the user for that send. There is no default here: a caller
 * must say where the message goes, and nothing in the Reader changes it afterwards.
 */
export type SendRoute = { path: 'backend' } | { path: LocalPath; to: LocalTarget };
/** `ok: false` means nothing was sent, nothing was written to any device, and the draft is kept. */
export type SendResult = { ok: true } | { ok: false; reason: string };

export interface MessagingValue {
  messaging: boolean;
  sendState: 'available' | 'unavailable' | 'forbidden';
  streamStatus: StreamStatus | 'off';
  conversations: Paged<Conversation>;
  identities: Paged<Identity>;
  channels: Paged<Channel>;
  messagesFor(conversationId: string): Paged<Message>;
  /** State of a by-id fetch (deep link); idle until loadConversation(id). */
  deepLinkFor(conversationId: string): DeepLink | null;
  /** GET /conversations/{id}, once per id until the state is reset. */
  loadConversation(conversationId: string): void;
  /**
   * POST /conversations/{id}/read up to `upTo`. At most one request per
   * (conversation, message) pair; a failure is silent and never retried.
   */
  markRead(conversationId: string, upTo: string): void;
  attemptsFor(target: Target): LocalAttempt[];
  loadConversations(): void;
  loadMoreConversations(): void;
  loadChannels(): void;
  loadIdentities(): void;
  openConversation(id: string | null): void;
  loadMessages(conversationId: string): void;
  loadOlderMessages(conversationId: string): void;
  draftText(target: Target): string;
  setDraftText(target: Target, text: string): void;
  /** The `client_draft_id` of the composer's current draft for a target, or null when there is none. */
  draftIdFor(target: Target): string | null;
  /**
   * Put a persisted draft back into the composer under its ORIGINAL draft id.
   * Does nothing when the composer already holds text for that target.
   */
  restoreDraft(target: Target, draftId: string, text: string): void;
  /**
   * Load cached attempts (original attempt id, draft id, request, evidence) into
   * the view after a reload. NEVER sends: a `posting` attempt becomes
   * `ambiguous` (shown as unknown), and where the server attempt id is known
   * its state is read back with GET /send-attempts/{id} once the send
   * capability is available. Only the explicit "Send again" makes a new attempt.
   */
  rehydrate(records: LocalAttempt[]): void;
  /** Explicit Send tap on the chosen path: a new attempt id, same draft id until it is sent. */
  send(target: Target, identityId: string, route: SendRoute): SendResult;
  /**
   * Explicit "Send again": a NEW attempt id for the same draft, on the path the user picks for it
   * (the same one or another; never chosen by the Reader).
   */
  sendAgain(clientAttemptId: string, route: SendRoute): SendResult;
  /** Re-POST the SAME Backend attempt (same key, same body) to learn its fate. Local attempts have nothing to re-check. */
  recheck(clientAttemptId: string): void;
}

const Ctx = createContext<MessagingValue | null>(null);

export function useMessaging(): MessagingValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMessaging outside MessagingProvider');
  return v;
}

export interface MessagingProviderProps {
  children: ReactNode;
  /** Delays for automatic same-attempt re-POSTs after an ambiguous failure. */
  retryDelaysMs?: readonly number[];
  /** Polling for non-terminal attempts when no live stream; 0 disables. */
  pollMs?: number;
}

export function MessagingProvider({
  children,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  pollMs = 4000,
}: MessagingProviderProps) {
  const { api, session, refreshSession } = useAuth();
  const devices = useDevices();
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const caps = session?.capabilities;
  const messaging = caps?.messaging === 'available';
  const sendState = caps?.send ?? 'unavailable';
  const eventsOn = messaging && caps?.events === 'available';

  const [conversations, setConversations] = useState<Paged<Conversation>>(idle);
  const [identities, setIdentities] = useState<Paged<Identity>>(idle);
  const [channels, setChannels] = useState<Paged<Channel>>(idle);
  const [messages, setMessages] = useState<Record<string, Paged<Message>>>({});
  const [deepLinks, setDeepLinks] = useState<Record<string, DeepLink>>({});
  const deepLinksRef = useRef(deepLinks);
  deepLinksRef.current = deepLinks;
  // Every (conversation, newest message) pair a mark-read was already tried for.
  const readTried = useRef(new Set<string>());
  const [attempts, setAttempts] = useState<LocalAttempt[]>([]);
  const [draftVersion, bumpDrafts] = useState(0);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | 'off'>('off');

  // Drafts live in memory only; message text never goes to web storage.
  const drafts = useRef(new Map<string, { draftId: string; text: string }>());
  const active = useRef<string | null>(null);
  const seq = useRef({ conv: 0, ident: 0, chan: 0 });
  const msgSeq = useRef(new Map<string, number>());
  const attemptsRef = useRef<LocalAttempt[]>([]);
  attemptsRef.current = attempts;
  // Rehydrated attempts whose server state is read back once sends are available.
  const pendingRefresh = useRef(new Set<string>());
  const [rehydrateGen, bumpRehydrate] = useState(0);

  // An update or reload would lose the in-memory drafts and the local view of
  // uncertain attempts; tell the update flow so it asks first.
  useEffect(
    () =>
      registerUpdateGuard(() => ({
        drafts: [...drafts.current.values()].filter((d) => d.text.trim() !== '').length,
        uncertainAttempts: attemptsRef.current.filter(isUncertainAttempt).length,
      })),
    [],
  );
  const live = useRef(false);

  const patchAttempt = useCallback((clientAttemptId: string, patch: Partial<LocalAttempt>) => {
    setAttempts((all) =>
      all.map((a) => (a.clientAttemptId === clientAttemptId ? { ...a, ...patch } : a)),
    );
  }, []);

  /* ---------------- snapshots ---------------- */

  const fetchConversations = useCallback(
    async (mode: 'first' | 'more' | 'reset') => {
      if (!messaging) return;
      const n = ++seq.current.conv;
      if (mode === 'more') setConversations((c) => ({ ...c, loadingMore: true }));
      else if (mode === 'reset') setConversations({ ...idle<Conversation>(), status: 'loading' });
      else setConversations((c) => (c.status === 'idle' ? { ...c, status: 'loading' } : c));
      try {
        const cursor = mode === 'more' ? conversationsRef.current.nextCursor : null;
        if (mode === 'more' && !cursor) return;
        const page = await api.listConversations({ cursor, limit: PAGE_SIZE });
        if (n !== seq.current.conv) return;
        setConversations((c) => {
          const items =
            mode === 'reset'
              ? page.items
              : mergeNewest(c.items, page.items, (x) => x.id, (x) => x.last_activity_at);
          // A refresh of page one keeps a cursor for older pages already loaded.
          const keepCursor = mode === 'first' && c.items.length > page.items.length;
          return {
            status: 'ready',
            items,
            nextCursor: keepCursor ? c.nextCursor : page.next_cursor,
            loadingMore: false,
            error: null,
            requestId: null,
          };
        });
      } catch (e) {
        if (n !== seq.current.conv) return;
        setConversations((c) => ({ ...c, status: c.items.length ? 'ready' : 'error', loadingMore: false, ...failure(e) }));
      }
    },
    [api, messaging],
  );
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const fetchIdentities = useCallback(async () => {
    if (!messaging) return;
    const n = ++seq.current.ident;
    setIdentities((c) => (c.status === 'idle' ? { ...c, status: 'loading' } : c));
    try {
      const page = await api.listIdentities();
      if (n !== seq.current.ident) return;
      setIdentities({ ...idle<Identity>(), status: 'ready', items: page.items, nextCursor: page.next_cursor });
    } catch (e) {
      if (n !== seq.current.ident) return;
      setIdentities((c) => ({ ...c, status: 'error', ...failure(e) }));
    }
  }, [api, messaging]);

  const fetchChannels = useCallback(async () => {
    if (!messaging) return;
    const n = ++seq.current.chan;
    setChannels((c) => (c.status === 'idle' ? { ...c, status: 'loading' } : c));
    try {
      const page = await api.listChannels();
      if (n !== seq.current.chan) return;
      setChannels({ ...idle<Channel>(), status: 'ready', items: page.items, nextCursor: page.next_cursor });
    } catch (e) {
      if (n !== seq.current.chan) return;
      setChannels((c) => ({ ...c, status: 'error', ...failure(e) }));
    }
  }, [api, messaging]);

  const fetchConversation = useCallback(
    async (id: string) => {
      if (!messaging || deepLinksRef.current[id]) return;
      deepLinksRef.current = { ...deepLinksRef.current, [id]: { status: 'loading' } };
      setDeepLinks(deepLinksRef.current);
      let next: DeepLink;
      try {
        next = { status: 'ready', conversation: await api.getConversation(id) };
      } catch (e) {
        next =
          e instanceof ApiError && e.status === 404
            ? { status: 'notfound' }
            : { status: 'error', ...failure(e) };
      }
      deepLinksRef.current = { ...deepLinksRef.current, [id]: next };
      setDeepLinks(deepLinksRef.current);
    },
    [api, messaging],
  );

  const markRead = useCallback(
    async (id: string, upTo: string) => {
      const key = `${id}\u0000${upTo}`;
      if (!messaging || readTried.current.has(key)) return;
      readTried.current.add(key);
      try {
        await api.markConversationRead(id, upTo);
      } catch {
        return; // non-fatal; the list keeps the server's count
      }
      const zero = (c: Conversation) => (c.id === id ? { ...c, unread_count: 0 } : c);
      setConversations((c) => ({ ...c, items: c.items.map(zero) }));
      const dl = deepLinksRef.current[id];
      if (dl?.status === 'ready') {
        deepLinksRef.current = { ...deepLinksRef.current, [id]: { status: 'ready', conversation: zero(dl.conversation) } };
        setDeepLinks(deepLinksRef.current);
      }
    },
    [api, messaging],
  );

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const fetchMessages = useCallback(
    async (id: string, mode: 'first' | 'more' | 'reset') => {
      if (!messaging) return;
      const n = (msgSeq.current.get(id) ?? 0) + 1;
      msgSeq.current.set(id, n);
      const cur = messagesRef.current[id] ?? idle<Message>();
      const cursor = mode === 'more' ? cur.nextCursor : null;
      if (mode === 'more' && !cursor) return;
      setMessages((m) => {
        const c = m[id] ?? idle<Message>();
        if (mode === 'more') return { ...m, [id]: { ...c, loadingMore: true } };
        if (mode === 'reset') return { ...m, [id]: { ...idle<Message>(), status: 'loading' } };
        return { ...m, [id]: c.status === 'idle' ? { ...c, status: 'loading' } : c };
      });
      try {
        const page = await api.listMessages(id, { cursor, limit: PAGE_SIZE });
        if (msgSeq.current.get(id) !== n) return;
        setMessages((m) => {
          const c = m[id] ?? idle<Message>();
          const items =
            mode === 'reset'
              ? page.items
              : mergeNewest(c.items, page.items, (x) => x.message_id, (x) => x.observed_at);
          const keepCursor = mode === 'first' && c.items.length > page.items.length;
          return {
            ...m,
            [id]: {
              status: 'ready',
              items,
              nextCursor: keepCursor ? c.nextCursor : page.next_cursor,
              loadingMore: false,
              error: null,
              requestId: null,
            },
          };
        });
      } catch (e) {
        if (msgSeq.current.get(id) !== n) return;
        setMessages((m) => {
          const c = m[id] ?? idle<Message>();
          return { ...m, [id]: { ...c, status: c.items.length ? 'ready' : 'error', loadingMore: false, ...failure(e) } };
        });
      }
    },
    [api, messaging],
  );

  /** GET /send-attempts/{id}: idempotent and read-only. The caller checks the send capability. */
  const readAttempt = useCallback(
    async (a: LocalAttempt) => {
      if (a.phase !== 'accepted' || !a.attempt) return;
      try {
        const fresh: SendAttempt = await api.getSendAttempt(a.attempt.id);
        patchAttempt(a.clientAttemptId, { attempt: fresh });
      } catch {
        /* keep what we have; the next event or poll tries again */
      }
    },
    [api, patchAttempt],
  );

  const refreshAttempt = useCallback(
    async (a: LocalAttempt) => {
      if (sendState !== 'available') return;
      await readAttempt(a);
    },
    [sendState, readAttempt],
  );

  /** Rehydration is read-only: this only ever calls GET (through refreshAttempt), never POST. */
  const rehydrate = useCallback(
    (records: LocalAttempt[]) => {
      if (!messaging) return;
      const have = new Set(attemptsRef.current.map((a) => a.clientAttemptId));
      const fresh = records
        .filter((r) => !have.has(r.clientAttemptId))
        // An attempt in flight when the page died has an unknown outcome. So does a local attempt the
        // device accepted but whose ACK was still awaited: the session that watched it is gone.
        .map((r): LocalAttempt =>
          r.phase === 'posting' || (pathOf(r) !== 'backend' && r.phase === 'local' && !describeAttempt(r, r.request.target.kind).terminal)
            ? { ...r, phase: 'ambiguous' }
            : r,
        );
      if (fresh.length === 0) return;
      attemptsRef.current = [...attemptsRef.current, ...fresh].sort((a, b) => a.createdAt - b.createdAt);
      setAttempts(attemptsRef.current);
      for (const a of fresh) {
        if (a.phase === 'accepted' && a.attempt?.id && !a.supersededBy) pendingRefresh.current.add(a.clientAttemptId);
      }
      bumpRehydrate((n) => n + 1);
    },
    [messaging],
  );

  // Read back the server's state for rehydrated attempts, once sends are available.
  useEffect(() => {
    if (!messaging || sendState !== 'available' || pendingRefresh.current.size === 0) return;
    const ids = [...pendingRefresh.current];
    pendingRefresh.current.clear();
    for (const id of ids) {
      const a = attemptsRef.current.find((x) => x.clientAttemptId === id);
      if (a) void readAttempt(a);
    }
  }, [messaging, sendState, rehydrateGen, readAttempt]);

  const resetSnapshots = useCallback(() => {
    msgSeq.current.clear();
    setMessages({});
    deepLinksRef.current = {};
    setDeepLinks({});
    void fetchConversations('reset');
    void fetchIdentities();
    void fetchChannels();
    if (active.current) void fetchMessages(active.current, 'reset');
  }, [fetchConversations, fetchIdentities, fetchChannels, fetchMessages]);

  /* ---------------- live updates ---------------- */

  const handlers = useRef<{
    event?: (e: EventEnvelope) => void;
    resync?: (reason: string) => void;
  }>({});
  const onEvent = (e: EventEnvelope) => {
    if (e.kind === 'message' || e.kind === 'conversation') {
      void fetchConversations('first');
      if (active.current) void fetchMessages(active.current, 'first');
    } else if (e.kind === 'attempt_status') {
      const hit = attemptsRef.current.filter(
        (a) => a.attempt?.id === e.resource_id || a.clientAttemptId === e.resource_id,
      );
      const todo = hit.length
        ? hit
        : attemptsRef.current.filter((a) => a.phase === 'accepted' && !describeAttempt(a, a.request.target.kind).terminal);
      todo.forEach((a) => void refreshAttempt(a));
      if (active.current) void fetchMessages(active.current, 'first');
    }
    // device_status concerns Nodes, not messaging.
  };
  const onResync = (reason: string) => {
    void (async () => {
      // Permissions may have changed: session first, then every snapshot.
      if (reason !== 'cursor_expired') await refreshSession();
      resetSnapshots();
    })();
  };
  useEffect(() => {
    handlers.current = { event: onEvent, resync: onResync };
  });

  useEffect(() => {
    if (!eventsOn) {
      setStreamStatus('off');
      live.current = false;
      return;
    }
    const stop = startEventStream({
      open: (o) => api.openEvents(o),
      onEvent: (e) => handlers.current.event?.(e),
      onResync: (r) => handlers.current.resync?.(r),
      onStatus: (s) => {
        live.current = s === 'live';
        setStreamStatus(s);
      },
    });
    return () => {
      stop();
      live.current = false;
    };
  }, [api, eventsOn]);

  // Without a live stream, poll attempts that can still change.
  useEffect(() => {
    if (!messaging || sendState !== 'available' || pollMs <= 0) return;
    const t = setInterval(() => {
      if (live.current) return;
      for (const a of attemptsRef.current) {
        if (a.phase === 'accepted' && !describeAttempt(a, a.request.target.kind).terminal) void refreshAttempt(a);
      }
    }, pollMs);
    return () => clearInterval(t);
  }, [messaging, sendState, pollMs, refreshAttempt]);

  // Drop everything when messaging stops being available (sign-out, revocation).
  useEffect(() => {
    if (messaging) return;
    msgSeq.current.clear();
    setConversations(idle());
    setIdentities(idle());
    setChannels(idle());
    setMessages({});
    deepLinksRef.current = {};
    setDeepLinks({});
    readTried.current.clear();
    setAttempts([]);
    pendingRefresh.current.clear();
    drafts.current.clear();
  }, [messaging]);

  /* ---------------- sending ---------------- */

  const runPost = useCallback(
    async (a: LocalAttempt, auto: boolean) => {
      patchAttempt(a.clientAttemptId, { phase: 'posting', error: null });
      const out: SendOutcome = await postAttempt(api, a.request, {
        retryDelaysMs: auto ? retryDelaysMs : [],
        onAmbiguous: () => patchAttempt(a.clientAttemptId, { phase: 'ambiguous' }),
      });
      if (out.phase === 'accepted') {
        patchAttempt(a.clientAttemptId, { phase: 'accepted', attempt: out.attempt, error: null });
        void fetchConversations('first');
        const conv = conversationsRef.current.items.find((c) => targetKey(c.target) === targetKey(a.request.target));
        if (conv) void fetchMessages(conv.id, 'first');
      } else if (out.phase === 'ambiguous') {
        patchAttempt(a.clientAttemptId, { phase: 'ambiguous' });
      } else {
        patchAttempt(a.clientAttemptId, { phase: 'rejected', error: out.error });
        // Sending was switched off after the session was read: refresh it so the
        // send capability shows unavailable and the composer says so.
        if (out.error.code === 'sending_disabled') void refreshSession();
      }
    },
    [api, retryDelaysMs, patchAttempt, fetchConversations, fetchMessages, refreshSession],
  );

  const identitiesRef = useRef(identities);
  identitiesRef.current = identities;

  /**
   * Starts a local attempt, or refuses without consuming anything. `beforeStart` runs only once the
   * preflight passed (it consumes the draft), so a blocked send keeps the user's text.
   */
  const startLocal = useCallback(
    (
      draftId: string,
      base: Omit<SendRequest, 'client_attempt_id' | 'client_draft_id'>,
      route: { path: LocalPath; to: LocalTarget },
      beforeStart?: () => void,
    ): { result: SendResult; attemptId: string | null } => {
      const identity = identitiesRef.current.items.find((i) => i.id === base.identity_id) ?? null;
      const handle = devicesRef.current.handles[route.path] ?? null;
      const pre = preflightLocal(handle, identity, base.target, route.to);
      if (!pre.ok) return { result: pre, attemptId: null };
      beforeStart?.();
      const clientAttemptId = newAttemptId();
      const a: LocalAttempt = {
        clientAttemptId,
        draftId,
        request: { ...base, client_draft_id: draftId, client_attempt_id: clientAttemptId },
        phase: 'posting',
        attempt: null,
        error: null,
        supersededBy: null,
        createdAt: Date.now(),
        path: route.path,
        localTarget: route.to,
        local: null,
      };
      attemptsRef.current = [...attemptsRef.current, a];
      setAttempts(attemptsRef.current);
      void runLocalSend(handle!, a, identity!, (patch) => patchAttempt(clientAttemptId, patch));
      return { result: { ok: true }, attemptId: clientAttemptId };
    },
    [patchAttempt],
  );

  const startAttempt = useCallback(
    (draftId: string, base: Omit<SendRequest, 'client_attempt_id' | 'client_draft_id'>) => {
      const clientAttemptId = newAttemptId();
      const request: SendRequest = { ...base, client_draft_id: draftId, client_attempt_id: clientAttemptId };
      const a: LocalAttempt = {
        clientAttemptId,
        draftId,
        request,
        phase: 'posting',
        attempt: null,
        error: null,
        supersededBy: null,
        createdAt: Date.now(),
        path: 'backend',
      };
      attemptsRef.current = [...attemptsRef.current, a];
      setAttempts(attemptsRef.current);
      void runPost(a, true);
      return clientAttemptId;
    },
    [runPost],
  );

  const send = useCallback(
    (target: Target, identityId: string, route: SendRoute): SendResult => {
      const key = targetKey(target);
      const d = drafts.current.get(key);
      const text = d?.text ?? '';
      if (!d || text.trim() === '') return { ok: false, reason: 'There is nothing to send.' };
      const base = { identity_id: identityId, target, content: { kind: 'text' as const, text } };
      // The draft is consumed synchronously so a double tap cannot send twice.
      const consume = () => {
        drafts.current.delete(key);
        bumpDrafts((n) => n + 1);
      };
      if (route.path === 'backend') {
        if (sendState !== 'available') return { ok: false, reason: 'Sending through the Backend is not available.' };
        consume();
        startAttempt(d.draftId, base);
        return { ok: true };
      }
      return startLocal(d.draftId, base, route, consume).result;
    },
    [sendState, startAttempt, startLocal],
  );

  const sendAgain = useCallback(
    (clientAttemptId: string, route: SendRoute): SendResult => {
      const old = attemptsRef.current.find((a) => a.clientAttemptId === clientAttemptId);
      if (!old || old.supersededBy) return { ok: false, reason: 'This attempt was already sent again.' };
      const { identity_id, target, content } = old.request;
      let next: string | null;
      if (route.path === 'backend') {
        if (sendState !== 'available') return { ok: false, reason: 'Sending through the Backend is not available.' };
        next = startAttempt(old.draftId, { identity_id, target, content });
      } else {
        const r = startLocal(old.draftId, { identity_id, target, content }, route);
        if (!r.result.ok) return r.result;
        next = r.attemptId;
      }
      if (next) patchAttempt(clientAttemptId, { supersededBy: next });
      return { ok: true };
    },
    [sendState, startAttempt, startLocal, patchAttempt],
  );

  const recheck = useCallback(
    (clientAttemptId: string) => {
      const a = attemptsRef.current.find((x) => x.clientAttemptId === clientAttemptId);
      if (!a || a.phase !== 'ambiguous' || pathOf(a) !== 'backend') return;
      void runPost(a, false);
    },
    [runPost],
  );

  /* ---------------- value ---------------- */

  // Stable action identities: components list them as effect dependencies.
  const actions = useMemo(
    () => ({
      loadConversations: () => void fetchConversations('first'),
      loadMoreConversations: () => void fetchConversations('more'),
      loadChannels: () => void fetchChannels(),
      loadIdentities: () => void fetchIdentities(),
      openConversation: (id: string | null) => {
        active.current = id;
      },
      loadConversation: (id: string) => void fetchConversation(id),
      markRead: (id: string, upTo: string) => void markRead(id, upTo),
      loadMessages: (id: string) => void fetchMessages(id, 'first'),
      loadOlderMessages: (id: string) => void fetchMessages(id, 'more'),
      draftText: (t: Target) => drafts.current.get(targetKey(t))?.text ?? '',
      setDraftText: (t: Target, text: string) => {
        const k = targetKey(t);
        const cur = drafts.current.get(k);
        drafts.current.set(k, { draftId: cur?.draftId ?? newDraftId(), text });
        bumpDrafts((n) => n + 1);
      },
      draftIdFor: (t: Target) => drafts.current.get(targetKey(t))?.draftId ?? null,
      restoreDraft: (t: Target, draftId: string, text: string) => {
        const k = targetKey(t);
        if ((drafts.current.get(k)?.text ?? '') !== '' || text.trim() === '') return;
        drafts.current.set(k, { draftId, text });
        bumpDrafts((n) => n + 1);
      },
      rehydrate,
      send,
      sendAgain,
      recheck,
    }),
    [rehydrate, fetchConversations, fetchChannels, fetchIdentities, fetchMessages, fetchConversation, markRead, send, sendAgain, recheck],
  );

  const value = useMemo<MessagingValue>(
    () => ({
      messaging,
      sendState,
      streamStatus,
      conversations,
      identities,
      channels,
      messagesFor: (id) => messages[id] ?? idle<Message>(),
      deepLinkFor: (id) => deepLinks[id] ?? null,
      attemptsFor: (t) => attempts.filter((a) => targetKey(a.request.target) === targetKey(t)),
      ...actions,
    }),
    // draftVersion re-renders consumers when a draft (kept in a ref) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messaging, sendState, streamStatus, conversations, identities, channels, messages, deepLinks, attempts, actions, draftVersion],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
