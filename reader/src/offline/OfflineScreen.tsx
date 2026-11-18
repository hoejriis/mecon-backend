import { useEffect, useState } from 'react';
import type { Message } from '../api/types';
import { Header } from '../components/Header';
import { SkipLink } from '../components/SkipLink';
import { QuarantineNotice } from '../storage/QuarantineNotice';
import type { AttemptRecord, CachedConversation, DraftRecord } from './cache';
import { UnlockForm } from './UnlockForm';
import { useOffline } from './OfflineContext';

const fmt = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));

/**
 * Shown when the Backend cannot be reached and no session could be loaded.
 * Locked: the account-independent shell and an unlock form, nothing else.
 * Unlocked: cached history, read-only on this screen. Sending from here is not
 * offered; local device sends are gated separately by `offlineSendGuard`.
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

  useEffect(() => {
    if (!cache) return;
    let live = true;
    void (async () => {
      const [c, d, a] = await Promise.all([cache.listConversations(), cache.listDrafts(), cache.listAttempts()]);
      if (live) {
        setConvs(c);
        setDrafts(d);
        setAttempts(a.filter((x) => x.phase === 'ambiguous' || x.phase === 'posting'));
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
      {attempts.length > 0 && (
        <>
          <h2>Outcome unknown</h2>
          <p className="state-body">These sends may or may not have gone out. They are kept, and none will be sent again unless you choose to once you are back online.</p>
          <ul className="conv-list">
            {attempts.map((a) => (
              <li key={a.clientAttemptId}>{a.request.content.text}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
