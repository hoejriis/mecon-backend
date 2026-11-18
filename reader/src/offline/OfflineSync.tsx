import { useEffect, useRef } from 'react';
import type { Message, Target } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useMessaging, targetKey } from '../messaging/MessagingContext';
import type { DraftRecord } from './cache';
import { useOffline } from './OfflineContext';
import { reconcile } from './reconcile';

/**
 * Online and unlocked: mirrors what the Backend returned into the encrypted
 * cache (conversations, loaded messages, drafts, send attempts), and reconciles
 * on each snapshot. Renders nothing. It never sends and never reads the lease.
 * Locked: does nothing, so no private content is written anywhere.
 */
export function OfflineSync() {
  const off = useOffline();
  const { session } = useAuth();
  const m = useMessaging();
  const cache = off.unlockedUserId && off.unlockedUserId === session?.user.id ? off.cache : null;
  const restored = useRef<string | null>(null);

  const convs = m.conversations;
  const idents = m.identities;
  const channels = m.channels;

  // A short signature, so the effect runs when something changed rather than on every render.
  const sig =
    convs.items.map((c) => `${c.id}:${c.last_activity_at}:${c.unread_count}:${m.messagesFor(c.id).items.length}:${m.messagesFor(c.id).items[0]?.message_id ?? ''}`).join('|') +
    `#${idents.items.length}#${channels.items.length}`;

  useEffect(() => {
    if (!cache || convs.status !== 'ready' || idents.status !== 'ready') return;
    const messages: Record<string, Message[]> = {};
    for (const c of convs.items) {
      const p = m.messagesFor(c.id);
      if (p.status === 'ready') messages[c.id] = p.items;
    }
    const h = setTimeout(() => {
      void reconcile(cache, { identities: idents.items, conversations: convs.items, channels: channels.items, messages })
        .then(() => cache.checkPressure())
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, sig, convs.status, idents.status]);

  // Drafts and send attempts: write through; restore saved drafts and attempts once per unlock.
  const targets: Target[] = convs.items.map((c) => c.target);
  const dsig = targets
    .map((t) => `${targetKey(t)}=${m.draftText(t).length}/${m.draftIdFor(t) ?? ''}/${m.attemptsFor(t).map((a) => `${a.clientAttemptId}${a.phase}${a.attempt?.status ?? ''}${a.supersededBy ?? ''}`).join(',')}`)
    .join('|');
  // The draft id last written per target, so a consumed or replaced draft's record is removed.
  const savedDraftIds = useRef(new Map<string, string>());

  useEffect(() => {
    if (!cache) {
      restored.current = null;
      savedDraftIds.current.clear();
      return;
    }
    if (!m.messaging) return; // nothing to restore into yet; retried when messaging is available
    let stale = false;
    void (async () => {
      if (restored.current !== cache.userId) {
        restored.current = cache.userId;
        // Newest draft per target wins; it keeps its original draft id.
        const newest = new Map<string, DraftRecord>();
        for (const d of await cache.listDrafts()) {
          const k = targetKey(d.target);
          if (!newest.has(k) || newest.get(k)!.updatedAt < d.updatedAt) newest.set(k, d);
        }
        // Attempts first, so a draft's conversation shows them as soon as it opens. Read-only: never sends.
        m.rehydrate(await cache.listAttempts());
        for (const d of newest.values()) m.restoreDraft(d.target, d.draftId, d.text);
      }
      if (stale) return;
      for (const t of targets) {
        const k = targetKey(t);
        const text = m.draftText(t);
        const id = m.draftIdFor(t);
        const prev = savedDraftIds.current.get(k);
        if (prev && prev !== id) {
          await cache.deleteDraft(prev);
          savedDraftIds.current.delete(k);
        }
        if (id) {
          await cache.saveDraft({ draftId: id, target: t, identityId: null, text, updatedAt: Date.now() });
          if (text.trim() !== '') savedDraftIds.current.set(k, id);
        }
        for (const a of m.attemptsFor(t)) await cache.saveAttempt(a);
      }
    })().catch(() => undefined);
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, dsig, m.messaging]);

  return null;
}
