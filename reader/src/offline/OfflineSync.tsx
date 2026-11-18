import { useEffect, useRef } from 'react';
import type { Message, Target } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useMessaging, targetKey } from '../messaging/MessagingContext';
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

  // Drafts and send attempts: write through; restore saved drafts once per unlock.
  const targets: Target[] = convs.items.map((c) => c.target);
  const dsig = targets
    .map((t) => `${targetKey(t)}=${m.draftText(t).length}/${m.attemptsFor(t).map((a) => `${a.clientAttemptId}${a.phase}${a.attempt?.status ?? ''}${a.supersededBy ?? ''}`).join(',')}`)
    .join('|');

  useEffect(() => {
    if (!cache) {
      restored.current = null;
      return;
    }
    void (async () => {
      if (restored.current !== cache.userId) {
        restored.current = cache.userId;
        for (const d of await cache.listDrafts()) if (m.draftText(d.target) === '') m.setDraftText(d.target, d.text);
      }
      for (const t of targets) {
        const text = m.draftText(t);
        await cache.saveDraft({ draftId: `draft:${targetKey(t)}`, target: t, identityId: null, text, updatedAt: Date.now() });
        for (const a of m.attemptsFor(t)) await cache.saveAttempt(a);
      }
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, dsig]);

  return null;
}
