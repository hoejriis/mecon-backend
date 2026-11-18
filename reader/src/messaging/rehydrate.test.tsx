import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createApiClient } from '../api/client';
import type { Target } from '../api/types';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { OfflineContext, type OfflineValue } from '../offline/OfflineContext';
import { OfflineCache, type DraftRecord } from '../offline/cache';
import { OfflineSync } from '../offline/OfflineSync';
import { fakePasskey as rawPasskey, freshStore } from '../offline/testkit';
import { setupWithPasskey } from '../offline/unlock';
import { createBackend, json, sessionWith, type Backend } from '../test/backend';
import { attempt, dmConversation, identities, page } from '../test/m2';
import { describeAttempt, type LocalAttempt } from './attemptStatus';
import { MessagingProvider, targetKey, useMessaging, type MessagingValue } from './MessagingContext';

const USER = 'usr_synthetic_alice';
const TARGET: Target = dmConversation.target;
const OTHER: Target = { kind: 'contact', id: 'contact_demo_0077' };
const A = 'attempt-'; // client attempt id prefix

const rec = (name: string, phase: LocalAttempt['phase'], over: Partial<LocalAttempt> = {}, target: Target = TARGET): LocalAttempt => ({
  clientAttemptId: A + name,
  draftId: `draft-${name}`,
  request: {
    client_draft_id: `draft-${name}`,
    client_attempt_id: A + name,
    identity_id: 'ident_demo_0001',
    target,
    content: { kind: 'text', text: `text ${name}` },
  },
  phase,
  attempt: null,
  error: null,
  supersededBy: null,
  createdAt: name.charCodeAt(0),
  ...over,
});

/** jsdom's ArrayBuffer is not Node's, so hand the PRF output back as a view, which both accept. */
function fakePasskey() {
  const p = rawPasskey();
  const get = p.get.bind(p);
  p.get = async (o) => {
    const c = (await get(o)) as unknown as { getClientExtensionResults(): { prf: { results?: { first: ArrayBuffer } } } };
    const first = c.getClientExtensionResults().prf.results?.first;
    return { getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(first!) } } }) } as unknown as Credential;
  };
  return p;
}

let b: Backend;
/** The latest messaging value, published by the probe from an effect. */
const latest: { current: MessagingValue | null } = { current: null };
const live = new Proxy({} as MessagingValue, {
  get: (_t, k) => (latest.current as unknown as Record<string | symbol, unknown>)[k],
});
function Probe() {
  const m = useMessaging();
  useEffect(() => {
    latest.current = m;
  });
  return (
    <ul>
      {m.attemptsFor(TARGET).map((a) => (
        <li key={a.clientAttemptId} data-testid={a.clientAttemptId}>
          {describeAttempt(a, 'contact').label}
        </li>
      ))}
    </ul>
  );
}

const posts = () => b.calls.filter((c) => c.method === 'POST');
const gets = () => b.callsTo('GET /send-attempts/att_srv_0001');

/** A fresh page load: a new provider tree over a cache that survived (the store is reused). */
async function reload(
  store: Awaited<ReturnType<typeof freshStore>>,
  keys: Awaited<ReturnType<typeof setupWithPasskey>>,
  send: 'available' | 'unavailable' = 'available',
) {
  const opened = await OfflineCache.open(store, keys);
  if (!opened.ok) throw new Error('quarantined');
  const caps = sessionWith({ messaging: 'available', send, events: 'unavailable' });
  // The client is deliberately permissive (send available), so a GET that gets through can only be stopped by the provider's own gate.
  const permissive = sessionWith({ messaging: 'available', send: 'available', events: 'unavailable' });
  const api = createApiClient({ fetchImpl: b.fetchMock as unknown as typeof fetch, initialCapabilities: permissive.capabilities });
  const auth = { status: 'signedIn', session: caps, api, refreshSession: async () => undefined } as unknown as AuthValue;
  const off = { unlockedUserId: USER, cache: opened.cache } as unknown as OfflineValue;
  render(
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <OfflineContext.Provider value={off}>
          <MessagingProvider pollMs={0}>
            <OfflineSync />
            <Probe />
          </MessagingProvider>
        </OfflineContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return opened.cache;
}

async function seeded() {
  const store = await freshStore();
  const keys = await setupWithPasskey(store, USER, { webauthn: fakePasskey() });
  const first = await OfflineCache.open(store, keys);
  if (!first.ok) throw new Error('quarantined');
  return { store, keys, cache: first.cache };
}

beforeEach(() => {
  b = createBackend();
  b.on('GET /conversations?limit=50', json(page([dmConversation])));
  b.on('GET /identities', json(page(identities)));
  b.on('GET /channels', json(page([])));
  b.on('POST /send-attempts', () => {
    throw new Error('rehydration must never POST');
  });
  b.on('GET /send-attempts/att_srv_0001', json(attempt('transmitted', { client_attempt_id: `${A}queued` })));
});

describe('rehydration after a reload', () => {
  it('shows an attempt in every phase with its original id and status, and POSTs nothing', async () => {
    const { store, keys, cache } = await seeded();
    const queued = attempt('queued', { id: 'att_srv_0001', client_attempt_id: `${A}queued` });
    const records = [
      rec('posting', 'posting'),
      rec('ambiguous', 'ambiguous'),
      rec('rejected', 'rejected', { error: { status: 422, code: 'x', message: 'Refused', requestId: null, keyConflict: false } }),
      rec('queued', 'accepted', { attempt: queued }),
      rec('unknown', 'accepted', { attempt: attempt('unknown', { id: 'att_srv_0002', client_attempt_id: `${A}unknown` }) }),
    ];
    for (const r of records) await cache.saveAttempt(r);
    await reload(store, keys, 'unavailable');

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    const text = (n: string) => screen.getByTestId(A + n).textContent;
    expect(text('posting')).toBe('Outcome unknown — not resent'); // never "Sending…" after a reload
    expect(text('ambiguous')).toBe('Outcome unknown — not resent');
    expect(text('rejected')).toBe('Not sent');
    expect(text('queued')).toBe('Queued');
    expect(text('unknown')).toBe('Outcome unknown — not resent');
    expect(live.attemptsFor(TARGET).map((a) => a.clientAttemptId).sort()).toEqual(records.map((r) => r.clientAttemptId).sort());
    expect(live.attemptsFor(TARGET).find((a) => a.clientAttemptId === `${A}posting`)!.request).toEqual(records[0]!.request);
    await act(async () => new Promise((r) => setTimeout(r, 150)));
    expect(posts()).toHaveLength(0);
  });

  it('reads the server state with GET only when the send capability is available, never POSTs', async () => {
    const queued = attempt('queued', { id: 'att_srv_0001', client_attempt_id: `${A}queued` });
    const withSend = await seeded();
    await withSend.cache.saveAttempt(rec('queued', 'accepted', { attempt: queued }));
    await withSend.cache.saveAttempt(rec('ambiguous', 'ambiguous')); // no server id: nothing to ask
    await reload(withSend.store, withSend.keys, 'available');
    await waitFor(() => expect(screen.getByTestId(A + 'queued').textContent).toBe('Transmitted'));
    expect(gets()).toHaveLength(1);
    expect(b.calls.filter((c) => c.path.startsWith('/send-attempts')).map((c) => `${c.method} ${c.path}`)).toEqual(['GET /send-attempts/att_srv_0001']);
    expect(screen.getByTestId(A + 'ambiguous').textContent).toBe('Outcome unknown — not resent');
    expect(posts()).toHaveLength(0);
  });

  it('makes no GET when the send capability is unavailable', async () => {
    const queued = attempt('queued', { id: 'att_srv_0001', client_attempt_id: `${A}queued` });
    const s = await seeded();
    await s.cache.saveAttempt(rec('queued', 'accepted', { attempt: queued }));
    await reload(s.store, s.keys, 'unavailable');
    await waitFor(() => expect(screen.getByTestId(A + 'queued').textContent).toBe('Queued'));
    await act(async () => new Promise((r) => setTimeout(r, 150)));
    expect(b.calls.filter((c) => c.path.startsWith('/send-attempts'))).toEqual([]);
  });

  it('only the explicit Send again makes a new attempt id, for the same draft id', async () => {
    const s = await seeded();
    await s.cache.saveAttempt(rec('ambiguous', 'ambiguous'));
    await reload(s.store, s.keys);
    await waitFor(() => expect(screen.getByTestId(A + 'ambiguous')).toBeInTheDocument());
    expect(posts()).toHaveLength(0);
    b.on('POST /send-attempts', () => new Response(JSON.stringify(attempt('queued', { client_attempt_id: 'x' })), { status: 201 }));
    act(() => live.sendAgain(A + 'ambiguous', { path: 'backend' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse(posts()[0]!.body!) as { client_attempt_id: string; client_draft_id: string };
    expect(body.client_attempt_id).not.toBe(A + 'ambiguous');
    expect(body.client_draft_id).toBe('draft-ambiguous');
  });
});

describe('drafts keep their id through a reload', () => {
  it('a draft round-trips by its client_draft_id, and the next send uses it', async () => {
    const s = await seeded();
    const d: DraftRecord = { draftId: 'draft-real-1', target: TARGET, identityId: null, text: 'typed before reload', updatedAt: 5 };
    await s.cache.saveDraft(d);
    const cache = await reload(s.store, s.keys);
    await waitFor(() => expect(live.draftText(TARGET)).toBe('typed before reload'));
    expect(live.draftIdFor(TARGET)).toBe('draft-real-1');
    act(() => live.loadConversations()); // the write-through covers targets of listed conversations
    await waitFor(async () => expect((await cache.listDrafts()).map((x) => x.draftId)).toEqual(['draft-real-1']));
    b.on('POST /send-attempts', () => new Response(JSON.stringify(attempt('queued', { client_attempt_id: 'x' })), { status: 201 }));
    act(() => live.send(TARGET, 'ident_demo_0001', { path: 'backend' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect((JSON.parse(posts()[0]!.body!) as { client_draft_id: string }).client_draft_id).toBe('draft-real-1');
    // The consumed draft's record goes away; it is not left behind to be restored again.
    await waitFor(async () => expect((await cache.listDrafts()).filter((x) => x.draftId === 'draft-real-1')).toHaveLength(0));
  });

  it('a draft typed before a reload is written under its own id and comes back with that id', async () => {
    const s = await seeded();
    const cache = await reload(s.store, s.keys);
    act(() => live.loadConversations());
    await waitFor(() => expect(live.conversations.status).toBe('ready'));
    act(() => live.setDraftText(TARGET, 'typed in session one'));
    const id = live.draftIdFor(TARGET)!;
    await waitFor(async () => expect((await cache.listDrafts()).map((x) => x.draftId)).toEqual([id]));
    cleanup(); // the page goes away; the encrypted cache stays
    await reload(s.store, s.keys);
    await waitFor(() => expect(live.draftText(TARGET)).toBe('typed in session one'));
    expect(live.draftIdFor(TARGET)).toBe(id);
  });

  it('a legacy draft:<target> record is restored under a new real id and rewritten', async () => {
    const s = await seeded();
    await s.cache.saveDraft({ draftId: `draft:${targetKey(TARGET)}`, target: TARGET, identityId: null, text: 'legacy text', updatedAt: 5 });
    const cache = await reload(s.store, s.keys);
    await waitFor(() => expect(live.draftText(TARGET)).toBe('legacy text'));
    const id = live.draftIdFor(TARGET)!;
    expect(id).not.toMatch(/^draft:/);
    await waitFor(async () => expect((await cache.listDrafts()).map((x) => x.draftId)).toEqual([id]));
  });

  it('text already typed in the composer is not overwritten by a restored draft', async () => {
    const s = await seeded();
    await s.cache.saveDraft({ draftId: 'draft-old', target: OTHER, identityId: null, text: 'old', updatedAt: 5 });
    await reload(s.store, s.keys);
    await waitFor(() => expect(live.draftText(OTHER)).toBe('old'));
    act(() => live.restoreDraft(OTHER, 'draft-other', 'would clobber'));
    expect(live.draftText(OTHER)).toBe('old');
    expect(live.draftIdFor(OTHER)).toBe('draft-old');
  });
});
