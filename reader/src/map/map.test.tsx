import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CapabilityError, createApiClient, type ApiClient } from '../api/client';
import type { Capabilities, Session } from '../api/types';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { TabPage } from '../routes/TabPage';
import { TABS } from '../tabs';
import { fx, sessionWith } from '../test/backend';
import { parseObservationEvent } from '../api/observationStream';
import { projectPins, MAP_H, MAP_W } from './projection';
import { HIGHLIGHT_MS } from './useObservations';
import observersEmpty from '../../../contracts/observations/v1/fixtures/observers-empty.json';
import observersMulti from '../../../contracts/observations/v1/fixtures/observers-multi.json';
import observersWithheld from '../../../contracts/observations/v1/fixtures/observers-location-withheld.json';
import observersSingle from '../../../contracts/observations/v1/fixtures/observers-single.json';
import snapshotEmpty from '../../../contracts/observations/v1/fixtures/snapshot-empty.json';
import snapshotCorrelated from '../../../contracts/observations/v1/fixtures/snapshot-correlated.json';
import snapshotSingle from '../../../contracts/observations/v1/fixtures/snapshot-single.json';
import eventReception from '../../../contracts/observations/v1/fixtures/event-reception.json';
import eventRevoked from '../../../contracts/observations/v1/fixtures/event-access-revoked.json';
import error410 from '../../../contracts/observations/v1/fixtures/error-410-cursor-expired.json';
import error403 from '../../../contracts/observations/v1/fixtures/error-403.json';

const mapTab = TABS.find((t) => t.id === 'map')!;
const BASE = '/api/observations/v1/authorized';

/* ------------------------------ test harness ------------------------------ */

const enc = new TextEncoder();
function sseStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    res: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => {
      try {
        ctl.close();
      } catch {
        /* already closed */
      }
    },
  };
}
const frame = (e: { event_id: string; [k: string]: unknown }) => `id: ${e.event_id}\ndata: ${JSON.stringify(e)}\n\n`;
const jsonRes = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Opened {
  url: string;
  lastEventId: string | null;
}

/** A fake Backend for the observation API; every request is recorded. */
function backend(o: {
  observers?: unknown | Array<unknown>;
  snapshot?: unknown | Array<unknown>;
  streams?: Array<() => Response>;
}) {
  const requests: string[] = [];
  const opened: Opened[] = [];
  const queue = <T,>(v: T | T[]) => (Array.isArray(v) ? [...v] : [v]);
  const observers = queue(o.observers ?? observersMulti);
  const snaps = queue(o.snapshot ?? snapshotEmpty);
  const streams = [...(o.streams ?? [])];
  const take = <T,>(q: T[]) => (q.length > 1 ? q.shift()! : q[0]!);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith(`${BASE}/observers`)) return jsonRes(take(observers))();
    if (url.startsWith(`${BASE}/snapshot`)) return jsonRes(take(snaps))();
    if (url.startsWith(`${BASE}/events`)) {
      opened.push({ url, lastEventId: new Headers(init?.headers).get('Last-Event-ID') });
      const next = streams.length > 1 ? streams.shift()! : streams[0];
      if (!next) throw new Error('no stream scripted');
      return next();
    }
    throw new Error(`unrouted request: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, requests, opened };
}

function authValue(api: ApiClient, session: Session, refreshSession = async () => null as Session | null): AuthValue {
  return {
    status: 'signedIn',
    session,
    devices: { status: 'idle' },
    api,
    refreshSession,
    loginPhase: 'idle',
    loginMessage: null,
    signOutError: null,
    submitEmail: async () => {},
    restartLogin: () => {},
    signOut: async () => {},
    loadDevices: async () => {},
  };
}

function mount(fetchImpl: typeof fetch, caps: Partial<Capabilities> = { observations: 'available' }, extra?: Partial<AuthValue>) {
  const session = sessionWith(caps);
  const api = createApiClient({ fetchImpl, initialCapabilities: session.capabilities });
  const value = { ...authValue(api, session), ...extra };
  return render(
    <MemoryRouter initialEntries={['/map']}>
      <AuthContext.Provider value={value}>
        <TabPage tab={mapTab} />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const svg = () => document.querySelector('svg.obs-map');
const pinLabels = () => Array.from(svg()?.querySelectorAll('circle[role="img"]') ?? []).map((c) => c.getAttribute('aria-label') ?? '');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/* --------------------------------- tests --------------------------------- */

describe('capability gating', () => {
  for (const state of ['unavailable', 'forbidden'] as const) {
    it(`makes no observation request while observations is ${state}`, async () => {
      const b = backend({});
      const spy = vi.fn(b.fetchImpl);
      mount(spy as typeof fetch, { observations: state });
      await settle(2000);
      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 1, name: 'Map' })).toBeInTheDocument();
      expect(screen.getByText(state === 'forbidden' ? 'Not permitted' : 'Not available')).toBeInTheDocument();
      expect(svg()).toBeNull();
    });
  }

  it('does not call the API client at all while unavailable', async () => {
    const calls = { observers: 0, snapshot: 0, events: 0 };
    const session = sessionWith({ observations: 'unavailable' });
    const real = createApiClient({ fetchImpl: backend({}).fetchImpl, initialCapabilities: session.capabilities });
    const api: ApiClient = {
      ...real,
      listObservers: (...a) => (calls.observers++, real.listObservers(...a)),
      getObservationSnapshot: (...a) => (calls.snapshot++, real.getObservationSnapshot(...a)),
      openObservationEvents: (...a) => (calls.events++, real.openObservationEvents(...a)),
    };
    render(
      <MemoryRouter initialEntries={['/map']}>
        <AuthContext.Provider value={authValue(api, session)}>
          <TabPage tab={mapTab} />
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    await settle(2000);
    expect(calls).toEqual({ observers: 0, snapshot: 0, events: 0 });
  });

  it('the client itself refuses without a request unless observations is available', async () => {
    const fetchSpy = vi.fn();
    for (const state of ['unavailable', 'forbidden'] as const) {
      const api = createApiClient({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        initialCapabilities: sessionWith({ observations: state }).capabilities,
      });
      await expect(api.listObservers()).rejects.toBeInstanceOf(CapabilityError);
      await expect(api.getObservationSnapshot()).rejects.toBeInstanceOf(CapabilityError);
      await expect(api.openObservationEvents({})).rejects.toBeInstanceOf(CapabilityError);
    }
    const unknown = createApiClient({ fetchImpl: fetchSpy as unknown as typeof fetch });
    await expect(unknown.listObservers()).rejects.toBeInstanceOf(CapabilityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls /observers and /snapshot with scope=self when available, same origin with the session cookie', async () => {
    const b = backend({ observers: observersSingle, snapshot: snapshotSingle, streams: [() => sseStream().res] });
    mount(b.fetchImpl);
    await settle();
    expect(b.requests[0]).toBe(`${BASE}/observers?scope=self`);
    expect(b.requests[1]).toBe(`${BASE}/snapshot?scope=self&limit=100`);
    expect(b.opened[0]!.url).toBe(`${BASE}/events?scope=self&cursor=cur_synthetic_0001`);
    expect(screen.getByRole('list', { name: 'Observers' })).toBeInTheDocument();
  });
});

describe('pins and list', () => {
  it('draws a pin only for observers with a location; the list shows all, marking the rest', async () => {
    const b = backend({ observers: observersWithheld, streams: [() => sseStream().res] });
    mount(b.fetchImpl);
    await settle();
    expect(pinLabels()).toHaveLength(1);
    expect(pinLabels()[0]).toContain('Synthetic Observer One');
    expect(pinLabels().join('|')).not.toContain('Shared Observer');
    expect(pinLabels().join('|')).not.toContain('Never Heard');
    // No pin geometry for the null-location observers: exactly one dot in the canvas.
    expect(svg()!.querySelectorAll('circle.obs-dot')).toHaveLength(1);
    const list = screen.getByRole('list', { name: 'Observers' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('Synthetic Shared Observer')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Location not shared')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Location not shared')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('Location not shared')).toBeNull();
    expect(screen.getByText(/2 observers without a shared location are listed below but not drawn/)).toBeInTheDocument();
  });

  it('with no located observer draws no canvas at all, only the list', async () => {
    const none = { ...observersWithheld, items: observersWithheld.items.filter((i) => i.location === null) };
    const b = backend({ observers: none, streams: [() => sseStream().res] });
    mount(b.fetchImpl);
    await settle();
    expect(svg()).toBeNull();
    expect(screen.getByText('No observer locations shared')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Observers' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows an honest empty state for no observers', async () => {
    const b = backend({ observers: observersEmpty, streams: [() => sseStream().res] });
    mount(b.fetchImpl);
    await settle();
    expect(screen.getByText('No observers')).toBeInTheDocument();
    expect(svg()).toBeNull();
  });

  it('shows freshness as text for live, stale, offline and never heard', async () => {
    const b = backend({ observers: observersWithheld, streams: [() => sseStream().res] });
    mount(b.fetchImpl);
    await settle();
    const rows = within(screen.getByRole('list', { name: 'Observers' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Live')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Last heard 09:59:30 UTC/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Offline')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/Last heard never/)).toBeInTheDocument();
  });

  it('shows live, stale and offline states, on the list and in the pin labels', async () => {
    const b = backend({ observers: observersMulti, streams: [() => sseStream().res] });
    mount(b.fetchImpl);
    await settle();
    const rows = within(screen.getByRole('list', { name: 'Observers' })).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/^(Live|Stale|Offline)$/).textContent)).toEqual(['Live', 'Stale', 'Offline']);
    expect(pinLabels().map((l) => l.split(', ')[1])).toEqual(['live', 'stale', 'offline']);
    expect(svg()!.querySelectorAll('.obs-live, .obs-stale, .obs-offline')).toHaveLength(3);
  });
});

describe('live activity', () => {
  it('highlights the observer with the reception time, then clears it within 15 s', async () => {
    const s = sseStream();
    const b = backend({ observers: observersMulti, streams: [() => s.res] });
    mount(b.fetchImpl);
    await settle();
    expect(svg()!.querySelectorAll('.obs-active')).toHaveLength(0);
    s.push(frame(eventReception));
    await settle();
    const active = svg()!.querySelectorAll('.obs-active');
    expect(active).toHaveLength(1);
    expect(active[0]!.getAttribute('data-observer')).toBe('ob_synthetic_7c1e40a2');
    expect(screen.getByText('Heard a packet at 10:00:05 UTC')).toBeInTheDocument();
    expect(pinLabels()[0]).toContain('heard a packet at 10:00:05 UTC');
    expect(HIGHLIGHT_MS).toBeLessThanOrEqual(15_000);
    await settle(HIGHLIGHT_MS + 100);
    expect(svg()!.querySelectorAll('.obs-active')).toHaveLength(0);
    expect(screen.queryByText(/Heard a packet at/)).toBeNull();
    // The latest reception time stays on the list row.
    expect(screen.getByText('Latest reception 10:00:05 UTC')).toBeInTheDocument();
  });

  it('ignores a duplicate event id and a reception by an observer it cannot place', async () => {
    const s = sseStream();
    const b = backend({ observers: observersMulti, streams: [() => s.res] });
    mount(b.fetchImpl);
    await settle();
    s.push(frame(eventReception));
    await settle();
    await settle(HIGHLIGHT_MS + 100);
    s.push(frame(eventReception)); // delivered again: at-least-once
    await settle();
    expect(svg()!.querySelectorAll('.obs-active')).toHaveLength(0);
    const stranger = { ...eventReception, event_id: 'evt_x', reception: { ...eventReception.reception, event_id: 'evt_x', observer_id: 'obs_unknown' } };
    s.push(frame(stranger));
    await settle();
    expect(svg()!.querySelectorAll('.obs-active')).toHaveLength(0);
    expect(svg()!.querySelectorAll('circle.obs-dot')).toHaveLength(3); // nothing was invented for it
  });

  it('never draws a line, path or polygon, even for correlated receptions by several observers', async () => {
    const s = sseStream();
    const b = backend({ observers: observersMulti, snapshot: snapshotCorrelated, streams: [() => s.res] });
    mount(b.fetchImpl);
    await settle();
    for (const r of snapshotCorrelated.items) {
      s.push(frame({ event_id: `live_${r.event_id}`, kind: 'reception', occurred_at: r.received_at, version: 1, reception: { ...r, event_id: `live_${r.event_id}` } } ));
    }
    await settle();
    expect(svg()!.querySelectorAll('.obs-active')).toHaveLength(3);
    const tags = new Set(Array.from(svg()!.querySelectorAll('*')).map((n) => n.tagName.toLowerCase()));
    expect([...tags].sort()).toEqual(['circle', 'g', 'rect', 'text']);
    expect(svg()!.querySelectorAll('line, polyline, polygon, path, ellipse, use, image, [d], [points]')).toHaveLength(0);
  });
});

describe('observation stream', () => {
  it('resumes with Last-Event-ID after the stream drops', async () => {
    const s1 = sseStream();
    const s2 = sseStream();
    const b = backend({ observers: observersMulti, snapshot: snapshotSingle, streams: [() => s1.res, () => s2.res] });
    mount(b.fetchImpl);
    await settle();
    expect(b.opened[0]).toMatchObject({ lastEventId: null });
    expect(b.opened[0]!.url).toContain('cursor=cur_synthetic_0001');
    s1.push(frame(eventReception));
    await settle();
    s1.end();
    await settle(1500);
    expect(b.opened).toHaveLength(2);
    expect(b.opened[1]!.lastEventId).toBe('evt_synthetic_0030');
    expect(b.opened[1]!.url).not.toContain('cursor=');
  });

  it('after 410 cursor_expired reloads observers and snapshot and reconnects without a cursor', async () => {
    const s2 = sseStream();
    const b = backend({
      observers: observersMulti,
      snapshot: [snapshotSingle, snapshotEmpty],
      streams: [jsonRes(error410, 410), () => s2.res],
    });
    mount(b.fetchImpl);
    await settle();
    await settle(1500);
    expect(b.opened).toHaveLength(2);
    expect(b.opened[0]!.url).toContain('cursor=cur_synthetic_0001');
    expect(b.opened[1]!.url).toBe(`${BASE}/events?scope=self`);
    expect(b.requests.filter((u) => u.startsWith(`${BASE}/observers`))).toHaveLength(2);
    expect(b.requests.filter((u) => u.startsWith(`${BASE}/snapshot`))).toHaveLength(2);
    s2.push(frame(eventReception));
    await settle();
    expect(svg()!.querySelectorAll('.obs-active')).toHaveLength(1);
  });

  it('on resync_required reloads and reconnects without a cursor', async () => {
    const s1 = sseStream();
    const b = backend({ observers: observersMulti, snapshot: snapshotSingle, streams: [() => s1.res] });
    mount(b.fetchImpl);
    await settle();
    s1.push(frame({ event_id: 'evt_r', kind: 'resync_required', occurred_at: '2030-01-15T10:02:00Z', version: 1 }));
    await settle();
    expect(b.requests.filter((u) => u.startsWith(`${BASE}/snapshot`))).toHaveLength(2);
  });

  it('on access_revoked drops everything it holds, does not reconnect and re-reads the session', async () => {
    const s1 = sseStream();
    const refresh = vi.fn(async () => null as Session | null);
    const b = backend({ observers: observersMulti, streams: [() => s1.res] });
    mount(b.fetchImpl, { observations: 'available' }, { refreshSession: refresh });
    await settle();
    expect(svg()).not.toBeNull();
    s1.push(frame(eventRevoked));
    await settle(5000);
    expect(screen.getByText('Access withdrawn')).toBeInTheDocument();
    expect(svg()).toBeNull();
    expect(screen.queryByText('Synthetic Observer One')).toBeNull();
    expect(b.opened).toHaveLength(1);
    expect(refresh).toHaveBeenCalled();
  });

  it('treats a 403 on reconnect as revoked and does not retry', async () => {
    const s1 = sseStream();
    const b = backend({ observers: observersMulti, streams: [() => s1.res, jsonRes(error403, 403)] });
    mount(b.fetchImpl);
    await settle();
    s1.end();
    await settle(1500);
    await settle(60_000);
    expect(screen.getByText('Access withdrawn')).toBeInTheDocument();
    expect(b.opened).toHaveLength(2);
  });

  it('a heartbeat-silent stream is reconnected after 50 s; heartbeats keep it alive', async () => {
    const s1 = sseStream();
    const s2 = sseStream();
    const b = backend({ observers: observersMulti, streams: [() => s1.res, () => s2.res] });
    mount(b.fetchImpl);
    await settle();
    await settle(40_000);
    s1.push(': heartbeat\n\n');
    await settle(40_000);
    expect(b.opened).toHaveLength(1);
    await settle(11_000);
    await settle(1500);
    expect(b.opened).toHaveLength(2);
  });

  it('shows an error with the request id when the observer list fails, and retries on request', async () => {
    let n = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${BASE}/observers`)) {
        n++;
        if (n === 1) return new Response(JSON.stringify({ code: 'unavailable', message: 'Try later.', request_id: 'req_abc', retryable: true }), { status: 503 });
        return new Response(JSON.stringify(observersSingle), { status: 200 });
      }
      if (url.startsWith(`${BASE}/snapshot`)) return new Response(JSON.stringify(snapshotEmpty), { status: 200 });
      return sseStream().res;
    }) as typeof fetch;
    mount(fetchImpl);
    await settle();
    expect(screen.getByText('Could not load observers')).toBeInTheDocument();
    expect(screen.getByText('Request ID: req_abc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(within(screen.getByRole('list', { name: 'Observers' })).getByText('Synthetic Observer One')).toBeInTheDocument();
  });
});

describe('parseObservationEvent and projection', () => {
  it('accepts the three kinds and rejects a reception without a body or an unknown kind', () => {
    expect(parseObservationEvent(JSON.stringify(eventReception))).not.toBeNull();
    expect(parseObservationEvent(JSON.stringify(eventRevoked))).not.toBeNull();
    expect(parseObservationEvent(JSON.stringify({ ...eventReception, reception: undefined }))).toBeNull();
    expect(parseObservationEvent(JSON.stringify({ ...eventRevoked, kind: 'mystery' }))).toBeNull();
    expect(parseObservationEvent('nope')).toBeNull();
  });

  it('projects only located observers, inside the canvas, and a lone pin at the centre', () => {
    const pins = projectPins(observersWithheld.items as never);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ x: MAP_W / 2, y: MAP_H / 2 });
    const many = projectPins(observersMulti.items as never);
    expect(many).toHaveLength(3);
    for (const p of many) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(MAP_W);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(MAP_H);
    }
    // north is up, east is right
    expect(many[1]!.x).toBeGreaterThan(many[0]!.x);
    expect(many[1]!.y).toBeLessThan(many[0]!.y);
    expect(projectPins([])).toEqual([]);
  });
});

void fx;
