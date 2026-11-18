/**
 * What the Reader holds about Backend contacts, channels and conversations, and what that says about
 * the target of one send. Pure. The result feeds the device mapping (device/destinations.ts); nothing
 * here knows a device slot or a device key.
 *
 * Contacts: a conversation's `target.id` of kind `contact` is looked up in the Backend contacts the
 * Reader loaded (and caches for offline); the contact's `public_key_prefix` is what the device's
 * contact keys are matched against. UNVERIFIED against a real Backend: that `Target.id` of a contact
 * conversation equals `Contact.id` (the contract does not say so). If no contact has that id, the
 * prefix is unknown and the send is refused, never guessed.
 */
import type { Channel, Contact, Conversation, Identity, Target } from '../api/types';
import type { BackendDest } from '../device/destinations';

export interface Directory {
  contacts: readonly Contact[];
  channels: readonly Channel[];
  conversations: readonly Conversation[];
}

/** The live directory from the messaging state. */
export const directoryOf = (m: { contacts: { items: Contact[] }; channels: { items: Channel[] }; conversations: { items: Conversation[] } }): Directory => ({
  contacts: m.contacts.items,
  channels: m.channels.items,
  conversations: m.conversations.items,
});

export const EMPTY_DIRECTORY: Directory = { contacts: [], channels: [], conversations: [] };

/** The Backend side of one send, for the device mapping. */
export function destFor(dir: Directory, target: Target, identity: Pick<Identity, 'id'> | null): BackendDest {
  if (target.kind === 'contact') {
    const c = dir.contacts.find((x) => x.id === target.id);
    return { kind: 'contact', targetId: target.id, prefix: c ? c.public_key_prefix : null };
  }
  const ch = dir.channels.find((x) => x.id === target.id);
  // "Own linked channel": a conversation of the sending identity targets this channel.
  const ownLinked = !!identity && dir.conversations.some((c) => c.target.kind === 'channel' && c.target.id === target.id && c.identity_id === identity.id);
  return {
    kind: 'channel',
    targetId: target.id,
    name: ch ? ch.name : null,
    ownLinked,
    sameNameCount: ch ? dir.channels.filter((x) => x.name === ch.name).length : 0,
  };
}
