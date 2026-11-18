import type { DeviceChannelRef } from './destinations';
import type { Envelope } from './meconIface';

/** Slots a device may have; a bound so a misbehaving device cannot loop the reader. */
export const MAX_CHANNEL_PAGES = 40;

export type ChannelPage = { ok: true; channels: DeviceChannelRef[]; next: number | null } | { ok: false; reason: string };

/**
 * Reads one `channel.list` answer (docs/contract/schema/channel.list.result.json: capacity, channels
 * [{slot, name, hash, key_bits}], next). Strict: one malformed entry rejects the whole page, so a
 * channel table is never half trusted. A secret never appears in the schema; one that does is ignored.
 */
export function parseChannelPage(env: Envelope): ChannelPage {
  if (env.status !== 'ok') return { ok: false, reason: `The device answered channel.list with "${String(env.status)}"${typeof env.error === 'string' ? ` (${env.error})` : ''}.` };
  const r = env.result as { channels?: unknown; next?: unknown } | undefined;
  if (!r || !Array.isArray(r.channels)) return { ok: false, reason: 'The device sent a channel list the Reader cannot read.' };
  const out: DeviceChannelRef[] = [];
  for (const c of r.channels as unknown[]) {
    const e = c as { slot?: unknown; name?: unknown; hash?: unknown } | null;
    if (!e || !Number.isInteger(e.slot) || (e.slot as number) < 0 || typeof e.name !== 'string' || e.name === '' || typeof e.hash !== 'string' || !/^[0-9a-f]{2}$/.test(e.hash)) {
      return { ok: false, reason: 'The device sent a malformed channel entry.' };
    }
    out.push({ slot: e.slot as number, name: e.name, hash: e.hash });
  }
  const next = r.next;
  if (next !== null && !(Number.isInteger(next) && (next as number) >= 0)) return { ok: false, reason: 'The device sent a malformed channel list cursor.' };
  return { ok: true, channels: out, next: next as number | null };
}
