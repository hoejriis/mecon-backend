import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, CapabilityError, type ApiClient } from '../api/client';
import { startObservationStream } from '../api/observationStream';
import type { StreamStatus } from '../api/eventStream';
import type { Observer } from '../api/types';

/** How long an observer stays highlighted after a live reception (the contract allows at most 15 s). */
export const HIGHLIGHT_MS = 10_000;
const MAX_OBSERVER_PAGES = 20;
const SEEN_LIMIT = 1000;

export type ObservationsStatus = 'loading' | 'ready' | 'error' | 'revoked';

export interface Highlight {
  /** `received_at` of the reception that caused it. */
  at: string;
  until: number;
}

export interface ObservationsState {
  status: ObservationsStatus;
  observers: Observer[];
  /** Latest `received_at` per observer, from the snapshot and the stream. */
  lastReception: Record<string, string>;
  /** Observers highlighted right now, by id. */
  highlights: Record<string, Highlight>;
  stream: StreamStatus | 'off';
  error: string | null;
  requestId: string | null;
}

const initial = (): ObservationsState => ({
  status: 'loading',
  observers: [],
  lastReception: {},
  highlights: {},
  stream: 'off',
  error: null,
  requestId: null,
});

const later = (a: string | undefined, b: string) => (a === undefined || Date.parse(b) > Date.parse(a) ? b : a);

/**
 * Loads the observer catalogue and a snapshot, then follows the SSE stream.
 * Call it only while `capabilities.observations` is `available` (the API
 * client enforces that too). Receptions only ever highlight an observer that
 * is already in the list: no line, route, or transmitter is derived from them.
 */
export function useObservations(api: ApiClient, refreshSession: () => Promise<unknown>) {
  const [state, setState] = useState<ObservationsState>(initial);
  const [restart, setRestart] = useState(0);
  const retry = useCallback(() => {
    setState(initial());
    setRestart((n) => n + 1);
  }, []);
  const refreshRef = useRef(refreshSession);
  useEffect(() => {
    refreshRef.current = refreshSession;
  });

  useEffect(() => {
    let alive = true;
    let generation = 0;
    let cursor: string | null = null;
    let stop: (() => void) | null = null;
    let reloadingForUnknown = false;
    const seen = new Set<string>();
    const known = new Set<string>();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const fail = (e: unknown) => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 403) {
        revoke();
        return;
      }
      const message =
        e instanceof CapabilityError
          ? 'Observations are not available for this account.'
          : e instanceof ApiError
            ? e.message
            : 'Could not load observers.';
      setState((s) => ({ ...s, status: 'error', error: message, requestId: e instanceof ApiError ? e.requestId : null }));
    };

    function revoke() {
      if (!alive) return;
      stop?.();
      stop = null;
      generation++;
      cursor = null;
      seen.clear();
      known.clear();
      setState({ ...initial(), status: 'revoked', stream: 'off' });
      void refreshRef.current();
    }

    async function load(adoptCursor: boolean): Promise<boolean> {
      const mine = ++generation;
      try {
        const observers: Observer[] = [];
        let page: string | null = null;
        for (let i = 0; i < MAX_OBSERVER_PAGES; i++) {
          const res = await api.listObservers({ cursor: page });
          observers.push(...res.items);
          page = res.next_cursor;
          if (!page) break;
        }
        const snap = await api.getObservationSnapshot({ limit: 100 });
        if (!alive || mine !== generation) return false;
        // After a resync the stream reconnects without a cursor (events seen twice are dropped by id).
        if (adoptCursor) cursor = snap.cursor;
        known.clear();
        observers.forEach((o) => known.add(o.observer_id));
        const last: Record<string, string> = {};
        for (const r of snap.items) {
          seen.add(r.event_id);
          last[r.observer_id] = later(last[r.observer_id], r.received_at);
        }
        setState((s) => ({
          ...s,
          status: 'ready',
          observers,
          lastReception: { ...last, ...mergeLater(last, s.lastReception) },
          error: null,
          requestId: null,
        }));
        return true;
      } catch (e) {
        if (mine === generation) fail(e);
        return false;
      }
    }

    void load(true).then((ok) => {
      if (!ok || !alive || stop) return;
      stop = startObservationStream(api, {
        getCursor: () => cursor,
        onStatus: (s) => alive && setState((st) => ({ ...st, stream: s })),
        onResync: () => {
          cursor = null; // the runner reconnects without a cursor; the snapshot is reloaded alongside
          void load(false);
        },
        onRevoked: revoke,
        onReception: (e) => {
          const r = e.reception;
          if (!r || seen.has(e.event_id)) return;
          seen.add(e.event_id);
          if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
          if (!known.has(r.observer_id)) {
            // A reception by an observer we have not listed: refresh the list once, never invent a place for it.
            if (!reloadingForUnknown) {
              reloadingForUnknown = true;
              void load(false).finally(() => (reloadingForUnknown = false));
            }
            return;
          }
          const until = Date.now() + HIGHLIGHT_MS;
          setState((s) => ({
            ...s,
            lastReception: { ...s.lastReception, [r.observer_id]: later(s.lastReception[r.observer_id], r.received_at) },
            highlights: { ...s.highlights, [r.observer_id]: { at: r.received_at, until } },
          }));
          const t = setTimeout(() => {
            timers.delete(t);
            if (!alive) return;
            setState((s) => {
              const h = s.highlights[r.observer_id];
              if (!h || h.until > Date.now()) return s;
              const rest = { ...s.highlights };
              delete rest[r.observer_id];
              return { ...s, highlights: rest };
            });
          }, HIGHLIGHT_MS + 20);
          timers.add(t);
        },
      });
    });

    return () => {
      alive = false;
      stop?.();
      timers.forEach(clearTimeout);
    };
  }, [api, restart]);

  return { state, retry };
}

function mergeLater(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = later(out[k], v);
  return out;
}
