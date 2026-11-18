/**
 * Mapping a Backend target to the connected device's own destination (a contact key, a channel
 * slot). Pure decisions: no I/O, no device code, so the main bundle may import it.
 *
 * Why this exists: the Reader API gives a conversation target only an opaque Backend id. A
 * message to the wrong channel slot or contact key is irreversible RF, so the destination is never
 * typed, guessed or defaulted. It is found by a matcher below, or the send is refused.
 *
 * Contacts: the Backend contact's `public_key_prefix` against the device's own contact keys.
 * Exactly one device key may start with it. A prefix shorter than MIN_PREFIX_HEX digits is too
 * weak to identify anyone and is refused.
 *
 * Channels: the device's `channel.list` (hoejriis/mecon-firmware docs/contract, class read, no
 * secret) gives slot, name and a one-byte hash. The Backend `Channel` has NO stable identifier
 * (id, name, visibility, favourite). The one-byte hash cannot be compared with anything the
 * Backend sends, and a name is not unique across fleets. So a channel matches only when ALL hold:
 *   1. the Backend channel is the caller's own linked channel (a conversation of the sending
 *      identity targets it),
 *   2. among the caller's Backend channels exactly one has this name,
 *   3. exactly one device channel has exactly this name (case-sensitive, byte for byte).
 * Anything else is refused with the reason. There is no fallback slot, ever.
 */

export const MIN_PREFIX_HEX = 6;

export interface DeviceContactRef {
  /** Full public key, 64 hex digits. */
  publicKey: string;
  name: string;
}

export interface DeviceChannelRef {
  slot: number;
  name: string;
  /** The one-byte channel hash on air, 2 hex digits. Informational: the Backend has nothing to compare it with. */
  hash: string;
}

export type DeviceChannelsState =
  | { status: 'idle' }
  /** The device does not offer a channel list over this link, with the reason. */
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'ready'; channels: readonly DeviceChannelRef[] };

/** What the Backend knows about the target of one send. */
export type BackendDest =
  | { kind: 'contact'; targetId: string; prefix: string | null }
  | {
      kind: 'channel';
      targetId: string;
      /** The Backend channel's name; null when the Reader does not hold the channel. */
      name: string | null;
      /** The channel is one of the sending identity's own: a conversation of that identity targets it. */
      ownLinked: boolean;
      /** How many of the caller's Backend channels have this name (at least 1 when `name` is set). */
      sameNameCount: number;
    };

export type Destination =
  | { kind: 'direct'; contactKey: string; name: string; via: 'prefix' | 'picked' }
  | { kind: 'channel'; slot: number; name: string; hash: string };

export type RefusalCode =
  | 'not_ready'
  | 'no_prefix'
  | 'prefix_too_short'
  | 'not_on_device'
  | 'ambiguous'
  | 'channel_list_unavailable'
  | 'channel_unknown'
  | 'channel_not_linked'
  | 'channel_name_shared'
  | 'channel_not_on_device'
  | 'channel_ambiguous';

export interface MapRefusal {
  ok: false;
  code: RefusalCode;
  /** Truthful, user-facing. */
  reason: string;
  /** For `ambiguous` contacts: the device contacts that match, and only those. */
  candidates: DeviceContactRef[];
}
export type MapOutcome = { ok: true; destination: Destination } | MapRefusal;

const refuse = (code: RefusalCode, reason: string, candidates: DeviceContactRef[] = []): MapRefusal => ({ ok: false, code, reason, candidates });

export function matchContact(prefix: string | null | undefined, contacts: readonly DeviceContactRef[], pick?: string): MapOutcome {
  const p = (prefix ?? '').trim().toLowerCase();
  if (p === '') return refuse('no_prefix', "This contact's public key is not known to the Reader, so it cannot be found on your device.");
  if (!/^[0-9a-f]+$/.test(p) || p.length < MIN_PREFIX_HEX) return refuse('prefix_too_short', "This contact's key prefix is too short to identify it on your device.");
  const seen = new Set<string>();
  const candidates: DeviceContactRef[] = [];
  for (const c of contacts) {
    const k = c.publicKey.toLowerCase();
    if (!k.startsWith(p) || seen.has(k)) continue;
    seen.add(k);
    candidates.push({ publicKey: k, name: c.name });
  }
  if (candidates.length === 0) return refuse('not_on_device', "This contact isn't on your device.");
  if (candidates.length === 1) {
    const c = candidates[0]!;
    return { ok: true, destination: { kind: 'direct', contactKey: c.publicKey, name: c.name, via: 'prefix' } };
  }
  const chosen = pick ? candidates.find((c) => c.publicKey === pick.toLowerCase()) : undefined;
  if (chosen) return { ok: true, destination: { kind: 'direct', contactKey: chosen.publicKey, name: chosen.name, via: 'picked' } };
  return refuse('ambiguous', `${candidates.length} contacts on your device match this contact's key prefix. Choose the right one.`, candidates);
}

export function matchChannel(dest: Extract<BackendDest, { kind: 'channel' }>, state: DeviceChannelsState): MapOutcome {
  if (dest.name === null) return refuse('channel_unknown', 'This channel is not known to the Reader, so it cannot be found on your device.');
  if (state.status !== 'ready') {
    const why = state.status === 'unavailable' || state.status === 'error' ? state.reason : 'The device channel list has not been read yet.';
    return refuse('channel_list_unavailable', `Sending to a channel through a device needs the device's channel list: ${why}`);
  }
  if (!dest.ownLinked) return refuse('channel_not_linked', "This channel isn't linked to the identity you send as, so it is not matched to a channel on your device.");
  if (dest.sameNameCount !== 1) return refuse('channel_name_shared', `${dest.sameNameCount} of your channels share the name "${dest.name}", so the device channel cannot be told apart.`);
  const matches = state.channels.filter((c) => c.name === dest.name);
  if (matches.length === 0) return refuse('channel_not_on_device', `No channel named "${dest.name}" is on your device.`);
  if (matches.length > 1) return refuse('channel_ambiguous', `${matches.length} channels on your device are named "${dest.name}", so none is chosen.`);
  const c = matches[0]!;
  return { ok: true, destination: { kind: 'channel', slot: c.slot, name: c.name, hash: c.hash } };
}

export function matchDestination(dest: BackendDest, contacts: readonly DeviceContactRef[], channels: DeviceChannelsState, pick?: string): MapOutcome {
  return dest.kind === 'contact' ? matchContact(dest.prefix, contacts, pick) : matchChannel(dest, channels);
}

export function sameDestination(a: Destination, b: Destination): boolean {
  if (a.kind === 'direct' && b.kind === 'direct') return a.contactKey === b.contactKey;
  if (a.kind === 'channel' && b.kind === 'channel') return a.slot === b.slot && a.name === b.name && a.hash === b.hash;
  return false;
}

/** The proof that the matcher chose this destination for exactly this Backend target. Only a DeviceSession mints one. */
export interface DestinationToken {
  readonly kind: 'direct' | 'channel';
  readonly targetId: string;
  readonly dest: BackendDest;
  readonly pick: string | undefined;
  readonly destination: Destination;
}

export type SessionMapping = { ok: true; destination: Destination; token: DestinationToken } | MapRefusal;
