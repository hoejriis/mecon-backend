import { ApiError } from './client';
import { parseEnvelope, SseParser } from './sse';
import type { EventEnvelope } from './types';

/** Backend heartbeats at least every 25 s; two missed intervals = dead. */
export const HEARTBEAT_DEAD_MS = 50_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** The two fields every stream envelope has. */
export interface EnvelopeLike {
  event_id: string;
  kind: string;
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'stopped';
export type ResyncReason = 'cursor_expired' | 'authorization_changed' | 'resync_required';

export interface EventStreamOptions<E = EventEnvelope> {
  /** Opens GET /events (gated by capabilities in the api client). */
  open(opts: { lastEventId: string | null; signal: AbortSignal }): Promise<Response>;
  onEvent(e: E): void;
  /** Parses one event's data; null drops it. Defaults to the Reader API envelope. */
  parse?(data: string): (E & EnvelopeLike) | null;
  /** Kinds that mean "reload snapshots"; defaults to the Reader API's two. */
  resyncKinds?: readonly string[];
  /**
   * Kinds that end the stream for good (access withdrawn). The stream stops
   * without reconnecting and `onRevoked` runs; nothing after it is delivered.
   */
  revokedKinds?: readonly string[];
  onRevoked?(kind: string): void;
  /** A 403 on (re)connect: access is gone. When given, the stream stops instead of retrying. */
  onForbidden?(): void;
  /** Snapshots must be reloaded (410, authorization_changed, resync_required). */
  onResync(reason: ResyncReason): void;
  onStatus?(s: StreamStatus): void;
  /** Called when a 401 ends the stream; the caller's sign-out path runs. */
  onUnauthorized?(): void;
  deadAfterMs?: number;
}

/**
 * SSE over fetch + ReadableStream (EventSource hides comment lines). Resumes
 * with Last-Event-ID. 410 drops the cursor and asks for a resync; 401 stops.
 * Returns a stop function.
 */
export function startEventStream<E = EventEnvelope>(o: EventStreamOptions<E>): () => void {
  const ctl = new AbortController();
  const deadAfter = o.deadAfterMs ?? HEARTBEAT_DEAD_MS;
  const parse = (o.parse ?? parseEnvelope) as (d: string) => (E & EnvelopeLike) | null;
  const resyncKinds = o.resyncKinds ?? ['authorization_changed', 'resync_required'];
  const revokedKinds = o.revokedKinds ?? [];
  let lastEventId: string | null = null;
  let stopped = false;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      ctl.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });

  async function once(): Promise<'ended' | 'gone' | 'stop' | 'revoked'> {
    const conn = new AbortController();
    const abortConn = () => conn.abort();
    ctl.signal.addEventListener('abort', abortConn);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let dead = false;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        dead = true;
        conn.abort();
      }, deadAfter);
    };
    try {
      arm();
      const res = await o.open({ lastEventId, signal: conn.signal });
      if (res.status === 401) {
        o.onUnauthorized?.();
        return 'stop';
      }
      if (res.status === 403 && o.onForbidden) {
        o.onForbidden();
        return 'revoked';
      }
      if (res.status === 410) {
        lastEventId = null;
        return 'gone';
      }
      if (!res.ok || !res.body) throw new ApiError(res.status, null, 'Event stream refused');
      o.onStatus?.('live');
      const reader = res.body.getReader();
      // Make an abort (watchdog or stop) end the read even if the transport does not.
      conn.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'ended';
        arm(); // any bytes, comment or event, prove the stream alive
        for (const item of parser.push(decoder.decode(value, { stream: true }))) {
          if (item.type !== 'event') continue;
          if (item.id) lastEventId = item.id;
          const env = parse(item.data);
          if (!env) continue;
          if (!item.id) lastEventId = env.event_id;
          if (revokedKinds.includes(env.kind)) {
            o.onRevoked?.(env.kind);
            return 'revoked';
          }
          if (resyncKinds.includes(env.kind)) {
            o.onResync(env.kind as ResyncReason);
          } else {
            o.onEvent(env);
          }
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return 'stop';
      if (dead) return 'ended';
      throw e;
    } finally {
      clearTimeout(watchdog);
      ctl.signal.removeEventListener('abort', abortConn);
      conn.abort();
    }
  }

  void (async () => {
    let backoff = BACKOFF_START_MS;
    o.onStatus?.('connecting');
    while (!stopped) {
      let result: 'ended' | 'gone' | 'stop' | 'revoked';
      try {
        result = await once();
        if (result === 'ended') backoff = BACKOFF_START_MS;
      } catch {
        result = 'ended';
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
      if (stopped || result === 'stop' || result === 'revoked') break;
      if (result === 'gone') {
        o.onResync('cursor_expired');
        o.onStatus?.('reconnecting');
        await wait(BACKOFF_START_MS);
        continue;
      }
      o.onStatus?.('reconnecting');
      await wait(backoff);
    }
    o.onStatus?.('stopped');
  })();

  return () => {
    stopped = true;
    ctl.abort();
  };
}
