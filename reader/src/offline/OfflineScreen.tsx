import { useEffect, useRef, useState } from 'react';
import type { Channel, Contact, Identity, Message, Target } from '../api/types';
import { Header } from '../components/Header';
import { SkipLink } from '../components/SkipLink';
import { describeAttempt, isUncertainAttempt, pathOf, type LocalAttempt, type LocalPath, type LocalTarget } from '../messaging/attemptStatus';
import type { Directory } from '../messaging/directory';
import { preflightLocal, runLocalSend } from '../messaging/localSend';
import { newAttemptId, newDraftId } from '../messaging/sendFlow';
import { SendPathControls, useSendPath, viaLabel } from '../routes/SendPathControls';
import { QuarantineNotice } from '../storage/QuarantineNotice';
import type { AttemptRecord, CachedConversation, DraftRecord } from './cache';
import { UnlockForm } from './UnlockForm';
import { useOffline } from './OfflineContext';

const targetKeyOf = (t: Target) => `${t.kind}:${t.id}`;
const fmt = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));

/**
 * Shown when the Backend cannot be reached and no session could be loaded.
 * Locked: the account-independent shell and an unlock form, nothing else.
 * Unlocked: cached history. With a valid lease, a message can be sent through a connected
 * Bluetooth or USB device (never through the Backend, which is unreachable here); every such send
 * is checked by `offlineSendGuard` against the lease (operation, identity, device, channel) before
 * anything is written. With no valid lease the screen is read-only and says why.
 */
export function OfflineScreen() {
  const off = useOffline();
  return (
    <div className="shell">
      <SkipLink />
      <Header />
      <main className="content" id="main" tabIndex={-1}>
        <div className="pane">
          <h1>Offline</h1>
          <p className="notice" role="status" data-testid="offline-banner">
            {off.mode.message}
          </p>
          {off.quarantined && <QuarantineNotice />}
          {off.unlockedUserId ? <Unlocked /> : <Locked />}
        </div>
      </main>
    </div>
  );
}

function Locked() {
  const off = useOffline();
  if (off.profiles.length === 0) return null;
  return (
    <section aria-labelledby="unlock-h">
      <h2 id="unlock-h">Unlock your cached messages</h2>
      <p className="state-body">Your messages stay encrypted on this device until you unlock them. Drafts and unsent messages are kept.</p>
      {off.profiles.map((p, i) => (
        <div key={p.userId}>
          {off.profiles.length > 1 && <h3>Account {i + 1}</h3>}
          <UnlockForm onPasskey={() => off.unlockPasskey(p.userId)} />
        </div>
      ))}
    </section>
  );
}

function Unlocked() {
  const off = useOffline();
  const cache = off.cache;
  const [convs, setConvs] = useState<CachedConversation[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [dir, setDir] = useState<{ contacts: Contact[]; channels: Channel[] }>({ contacts: [], channels: [] });

  useEffect(() => {
    if (!cache) return;
    let live = true;
    void (async () => {
      const [c, d, a, ids, cached] = await Promise.all([cache.listConversations(), cache.listDrafts(), cache.listAttempts(), cache.getIdentities(), cache.getDirectory()]);
      if (live) {
        setConvs(c);
        setDrafts(d);
        setAttempts(a);
        setIdentities(ids);
        setDir(cached);
      }
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cache]);

  useEffect(() => {
    if (!cache || !open) return;
    let live = true;
    void cache.getMessages(open).then((m) => live && setMsgs(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cache, open]);

  const readOnly = off.mode.kind !== 'offline-lease';
  const openConv = convs?.find((c) => c.conversation.id === open) ?? null;
  const shownUnknown = attempts.filter((a) => isUncertainAttempt(a) && !(openConv && targetKeyOf(a.request.target) === targetKeyOf(openConv.conversation.target)));
  return (
    <>
      {off.lease && (
        <p className="state-body" data-testid="lease-line">
          {off.lease.state === 'valid' ? `Offline lease valid until ${fmt(off.lease.expiresAtMs)}.` : off.lease.message}
        </p>
      )}
      {readOnly && (
        <p className="notice" role="status" data-testid="read-only">
          Read-only: cached messages can be read, but nothing can be sent until you reconnect.
        </p>
      )}
      <button type="button" className="btn btn-secondary" onClick={off.lock}>
        Lock
      </button>
      <h2>Cached conversations</h2>
      {convs === null ? (
        <p className="state-body">Loading…</p>
      ) : convs.length === 0 ? (
        <p className="state-body">Nothing is cached on this device yet.</p>
      ) : (
        <ul className="conv-list">
          {convs.map((c) => (
            <li key={c.conversation.id}>
              <button type="button" className="btn btn-small btn-secondary" aria-pressed={open === c.conversation.id} onClick={() => setOpen(c.conversation.id)}>
                {c.conversation.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && readOnly && (
        <p className="notice" role="status" data-testid="local-send-blocked">
          Sending through a device is blocked: {off.lease?.state === 'valid' ? off.mode.message : (off.lease?.message ?? off.mode.message)}
        </p>
      )}
      {open && (
        <ul className="msg-list" aria-label="Cached messages">
          {[...msgs].reverse().map((m) => (
            <li key={m.message_id} className={m.direction === 'outbound' ? 'msg msg-out' : 'msg msg-in'}>
              <p className="msg-meta">
                {m.sender_label ?? (m.direction === 'outbound' ? 'You' : 'Peer')} · cached copy, {m.source_path === 'backend' ? 'Backend' : m.source_path === 'ble' ? 'Bluetooth' : 'unknown source'}
              </p>
              <p className="msg-text">{m.content.text}</p>
            </li>
          ))}
        </ul>
      )}
      {open && openConv && (
        <LocalSection
          key={open}
          conversationTarget={openConv.conversation.target}
          identity={identities.find((i) => i.id === openConv.conversation.identity_id) ?? null}
          writable={!readOnly}
          directory={{ contacts: dir.contacts, channels: dir.channels, conversations: (convs ?? []).map((x) => x.conversation) }}
          attempts={attempts.filter((a) => targetKeyOf(a.request.target) === targetKeyOf(openConv.conversation.target))}
          onAttempt={(a) => {
            setAttempts((all) => (all.some((x) => x.clientAttemptId === a.clientAttemptId) ? all.map((x) => (x.clientAttemptId === a.clientAttemptId ? a : x)) : [...all, a]));
            void cache?.saveAttempt(a).catch(() => undefined);
          }}
        />
      )}
      {drafts.length > 0 && (
        <>
          <h2>Drafts kept</h2>
          <ul className="conv-list">
            {drafts.map((d) => (
              <li key={d.draftId}>{d.text}</li>
            ))}
          </ul>
        </>
      )}
      {shownUnknown.length > 0 && (
        <>
          <h2>Outcome unknown</h2>
          <p className="state-body">These sends may or may not have gone out. They are kept, and none will be sent again unless you choose to once you are back online.</p>
          <ul className="conv-list">
            {shownUnknown.map((a) => (
              <li key={a.clientAttemptId}>{a.request.content.text}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * Offline sending through a connected device, for one cached conversation. The path choice and the
 * device's own facts are the same as online; Backend is never offered here. Nothing is written
 * unless `preflightLocal` and then the device session's own guard both allow it.
 */
function LocalSection({
  conversationTarget,
  identity,
  writable,
  directory,
  attempts,
  onAttempt,
}: {
  conversationTarget: Target;
  identity: Identity | null;
  writable: boolean;
  directory: Directory;
  attempts: LocalAttempt[];
  onAttempt: (a: LocalAttempt) => void;
}) {
  return (
    <section aria-label="Send through a device" className="local-send">
      <h2>Through a device</h2>
      {attempts.length > 0 && (
        <ul className="msg-list" aria-label="Device sends">
          {attempts.map((a) => (
            <OfflineAttempt key={a.clientAttemptId} a={a} identity={identity} directory={directory} writable={writable} onAttempt={onAttempt} />
          ))}
        </ul>
      )}
      {writable && <OfflineComposer target={conversationTarget} identity={identity} directory={directory} onAttempt={onAttempt} />}
    </section>
  );
}

function newLocalAttempt(identity: Identity, target: Target, text: string, draftId: string, path: LocalPath, to: LocalTarget): LocalAttempt {
  const id = newAttemptId();
  return {
    clientAttemptId: id,
    draftId,
    request: { client_draft_id: draftId, client_attempt_id: id, identity_id: identity.id, target, content: { kind: 'text', text } },
    phase: 'posting',
    attempt: null,
    error: null,
    supersededBy: null,
    createdAt: Date.now(),
    path,
    localTarget: to,
    local: null,
  };
}

function OfflineComposer({ target, identity, directory, onAttempt }: { target: Target; identity: Identity | null; directory: Directory; onAttempt: (a: LocalAttempt) => void }) {
  const [text, setText] = useState('');
  const draftId = useRef(newDraftId());
  const [refusal, setRefusal] = useState<string | null>(null);
  const path = useSendPath({ identity, target, online: false, sendState: 'unavailable', directory });
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        const r = path.route;
        if (!r || r.path === 'backend' || !identity) return;
        const pre = preflightLocal(path.handle, identity, target, r.to, path.dest);
        if (!pre.ok) return setRefusal(pre.reason);
        setRefusal(null);
        const a = newLocalAttempt(identity, target, text, draftId.current, r.path, r.to);
        draftId.current = newDraftId();
        setText('');
        onAttempt(a);
        let cur = a;
        void runLocalSend(path.handle!, a, identity, path.dest, (patch) => {
          cur = { ...cur, ...patch };
          onAttempt(cur);
        });
      }}
    >
      <label className="composer-field">
        Message
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <SendPathControls s={path} target={target} idPrefix="offline" />
      {refusal && (
        <p className="state-meta" role="alert" data-testid="send-refused">
          Not sent: {refusal} Your message is kept.
        </p>
      )}
      <button type="submit" className="btn" disabled={text.trim() === '' || !path.route || !!path.blocked}>
        Send
      </button>
    </form>
  );
}

function OfflineAttempt({ a, identity, directory, writable, onAttempt }: { a: LocalAttempt; identity: Identity | null; directory: Directory; writable: boolean; onAttempt: (a: LocalAttempt) => void }) {
  const v = describeAttempt(a, a.request.target.kind);
  const [confirming, setConfirming] = useState(false);
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  const path = useSendPath({ identity, target: a.request.target, online: false, sendState: 'unavailable', directory, initial: { path: pathOf(a), to: a.localTarget } });
  const canAgain = writable && v.canSendAgain && !a.supersededBy && pathOf(a) !== 'backend';
  return (
    <li className="msg msg-out" data-path={pathOf(a)}>
      <p className="msg-meta">You · via {viaLabel(a)}</p>
      <p className="msg-text">{a.request.content.text}</p>
      <div className={`attempt tone-${v.tone}`}>
        <p className="attempt-status">
          <span className="attempt-label">{v.label}</span>
          {v.detail && <span className="attempt-detail"> {v.detail}</span>}
        </p>
        {v.facts && (
          <p className="state-meta" data-testid="attempt-facts">
            {v.facts}
          </p>
        )}
        {a.supersededBy && <p className="state-meta">Sent again as a new attempt.</p>}
        {canAgain && !confirming && (
          <button type="button" className="btn btn-small btn-secondary" onClick={() => setConfirming(true)}>
            Send again
          </button>
        )}
        {canAgain && confirming && (
          <div className="confirm" role="group" aria-label="Confirm sending again">
            {v.mayHaveTransmitted && <p>The earlier attempt may already have been transmitted. Sending again creates a new attempt and the recipient could receive the message twice.</p>}
            <p>Choose where the new attempt goes; the Reader never changes it for you.</p>
            <SendPathControls s={path} target={a.request.target} idPrefix={`again-${a.clientAttemptId}`} />
            {blockedMsg && (
              <p className="state-meta" role="alert">
                {blockedMsg}
              </p>
            )}
            <button
              type="button"
              className="btn btn-small"
              disabled={!path.route || path.route.path === 'backend' || !!path.blocked}
              onClick={() => {
                const r = path.route;
                if (!r || r.path === 'backend' || !identity) return;
                const pre = preflightLocal(path.handle, identity, a.request.target, r.to, path.dest);
                if (!pre.ok) return setBlockedMsg(pre.reason);
                // A new attempt id, the same draft id.
                const next = newLocalAttempt(identity, a.request.target, a.request.content.text, a.draftId, r.path, r.to);
                onAttempt({ ...a, supersededBy: next.clientAttemptId });
                onAttempt(next);
                let cur = next;
                void runLocalSend(path.handle!, next, identity, path.dest, (patch) => {
                  cur = { ...cur, ...patch };
                  onAttempt(cur);
                });
                setConfirming(false);
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
    </li>
  );
}
