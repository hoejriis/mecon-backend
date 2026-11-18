import type { ApiClient } from './client';
import { startEventStream, type ResyncReason, type StreamStatus } from './eventStream';
import type { ObservationEvent } from './types';

const KINDS = ['reception', 'resync_required', 'access_revoked'];

/** Parse an observation envelope; null when it is not one (including a reception without its body). */
export function parseObservationEvent(data: string): ObservationEvent | null {
  try {
    const v: unknown = JSON.parse(data);
    if (!v || typeof v !== 'object') return null;
    const e = v as Partial<ObservationEvent>;
    if (typeof e.event_id !== 'string' || typeof e.kind !== 'string' || !KINDS.includes(e.kind)) return null;
    if (e.kind === 'reception') {
      const r = e.reception;
      if (!r || typeof r !== 'object' || typeof r.observer_id !== 'string') return null;
    }
    return e as ObservationEvent;
  } catch {
    return null;
  }
}

export interface ObservationStreamHandlers {
  /** The first connection resumes from this snapshot cursor; read again on each (re)connect without a Last-Event-ID. */
  getCursor(): string | null;
  onReception(e: ObservationEvent): void;
  /** Reload observers and snapshot (410 `cursor_expired` or `resync_required`). */
  onResync(reason: ResyncReason): void;
  /** `access_revoked` event, or a 403 on connect: the stream is over for good. */
  onRevoked(): void;
  onStatus?(s: StreamStatus): void;
}

/**
 * The observation SSE stream, on the shared runner in eventStream.ts: resume
 * with Last-Event-ID, 410 resync, heartbeat watchdog, backoff. Returns stop.
 */
export function startObservationStream(api: ApiClient, h: ObservationStreamHandlers): () => void {
  return startEventStream<ObservationEvent>({
    open: ({ lastEventId, signal }) =>
      api.openObservationEvents({ lastEventId, cursor: lastEventId ? null : h.getCursor(), signal }),
    parse: parseObservationEvent,
    resyncKinds: ['resync_required'],
    revokedKinds: ['access_revoked'],
    onEvent: (e) => {
      if (e.kind === 'reception') h.onReception(e);
    },
    onResync: h.onResync,
    onRevoked: h.onRevoked,
    onForbidden: h.onRevoked,
    onStatus: h.onStatus,
  });
}
