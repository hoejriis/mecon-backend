/**
 * Reconnect: reconcile the cache with the Backend's snapshot.
 *
 * - The Backend is authoritative for what exists. A cached conversation the
 *   snapshot returns is refreshed from it.
 * - Identities that cannot be proven are never merged. A cached conversation
 *   whose identity is not among the caller's current identities, or whose
 *   identity changed for the same conversation id, is moved to a held area
 *   (kept encrypted, not shown as live, not merged with server data).
 * - Drafts are untouched.
 * - Attempts keep their ids and requests. Interrupted ones become ambiguous.
 *   Nothing here sends and nothing here takes a client: an uncertain attempt is
 *   resolved only by the user, by re-checking the same attempt or sending anew.
 */
import type { Channel, Conversation, Identity, Message } from '../api/types';
import type { OfflineCache } from './cache';

export interface Snapshot {
  identities: Identity[];
  conversations: Conversation[];
  channels: Channel[];
  /** Messages by conversation id, for conversations the caller refreshed. */
  messages?: Record<string, Message[]>;
}

export interface ReconcileResult {
  refreshed: number;
  held: string[];
  draftsKept: number;
  uncertainAttempts: number;
}

export async function reconcile(cache: OfflineCache, snap: Snapshot): Promise<ReconcileResult> {
  const provable = new Set(snap.identities.map((i) => i.id));
  await cache.putIdentities(snap.identities);
  const fresh = new Map(snap.conversations.map((c) => [c.id, c]));
  const held: string[] = [];

  for (const cached of await cache.listConversations()) {
    const id = cached.conversation.id;
    const server = fresh.get(id);
    const identityChanged = server !== undefined && server.identity_id !== cached.conversation.identity_id;
    if (!provable.has(cached.conversation.identity_id) || identityChanged) {
      await cache.hold(id);
      held.push(id);
    }
  }

  let refreshed = 0;
  for (const c of snap.conversations) {
    if (!provable.has(c.identity_id)) continue; // the Backend listed it, but not under an identity it lists: do not trust half a pair
    await cache.putConversation(c);
    const msgs = snap.messages?.[c.id];
    if (msgs) await cache.putMessages(c.id, msgs);
    refreshed += 1;
  }
  await cache.enforceCaps();

  await cache.recoverInterruptedAttempts();
  const uncertain = (await cache.listAttempts()).filter((a) => a.phase === 'ambiguous' || a.phase === 'posting').length;

  return { refreshed, held, draftsKept: (await cache.listDrafts()).length, uncertainAttempts: uncertain };
}
