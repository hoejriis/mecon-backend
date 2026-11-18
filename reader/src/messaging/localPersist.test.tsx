import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createApiClient } from '../api/client';
import type { Target } from '../api/types';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { DeviceContext } from '../device/DeviceContext';
import { companionRig } from '../device/rig.test-util';
import { OfflineGate, registerGate } from '../offline/gate';
import { leaseSource } from '../offline/leaseSource.test-util';
import { OfflineCache } from '../offline/cache';
import { OfflineContext, type OfflineValue } from '../offline/OfflineContext';
import { OfflineSync } from '../offline/OfflineSync';
import { fakePasskey as rawPasskey, freshStore, leasePayload } from '../offline/testkit';
import { setupWithPasskey } from '../offline/unlock';
import { createBackend, json, sessionWith, type Backend } from '../test/backend';
import { contacts, dmConversation, page } from '../test/m2';
import { describeAttempt } from './attemptStatus';
import type { LocalDeviceHandle } from './localPath';
import { MessagingProvider, useMessaging, type MessagingValue } from './MessagingContext';

// SIMULATED: fake Backend, simulated Companion over a fake serial port, fake IndexedDB. No hardware, no RF.
const USER = 'usr_synthetic_alice';
const TARGET: Target = dmConversation.target;
const IDENT = 'ident_demo_0001';
const identities = [{ id: IDENT, display_name: 'Demo Companion', public_key_prefix: '111111', device_id: 'dev_demo_0001', can_send: true }];

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
let rig: ReturnType<typeof companionRig>;
const latest: { current: MessagingValue | null } = { current: null };
const live = new Proxy({} as MessagingValue, { get: (_t, k) => (latest.current as unknown as Record<string | symbol, unknown>)[k] });
function Probe() {
  const m = useMessaging();
  useEffect(() => {
    latest.current = m;
  });
  return (
    <ul>
      {m.attemptsFor(TARGET).map((a) => (
        <li key={a.clientAttemptId} data-testid={a.clientAttemptId} data-path={a.path ?? 'none'}>
          {describeAttempt(a, 'contact').label}|{describeAttempt(a, 'contact').facts ?? ''}
        </li>
      ))}
    </ul>
  );
}
const posts = () => b.calls.filter((c) => c.method === 'POST');

function mountTree(cache: OfflineCache | null, handle: LocalDeviceHandle | null) {
  const caps = sessionWith({ messaging: 'available', send: 'available', events: 'unavailable' });
  const api = createApiClient({ fetchImpl: b.fetchMock as unknown as typeof fetch, initialCapabilities: caps.capabilities });
  const auth = { status: 'signedIn', session: caps, api, refreshSession: async () => undefined } as unknown as AuthValue;
  const off = { unlockedUserId: cache ? USER : null, cache } as unknown as OfflineValue;
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <OfflineContext.Provider value={off}>
          <DeviceContext.Provider value={{ handles: handle ? { usb: handle } : {}, hasApi: () => true, connect: async () => null, disconnect: async () => undefined }}>
            <MessagingProvider pollMs={0}>
              <OfflineSync />
              <Probe />
            </MessagingProvider>
          </DeviceContext.Provider>
        </OfflineContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}
async function ready() {
  act(() => live.loadConversations());
  act(() => live.loadIdentities());
  act(() => live.loadContacts());
  await waitFor(() => expect(live.identities.status).toBe('ready'));
  await waitFor(() => expect(live.contacts.status).toBe('ready'));
}
const USB_TO = { path: 'usb' as const, to: {} };

beforeEach(async () => {
  b = createBackend();
  b.on('GET /conversations?limit=50', json(page([dmConversation])));
  b.on('GET /identities', json(page(identities)));
  b.on('GET /channels', json(page([])));
  b.on('GET /contacts?limit=200', json(page(contacts)));
  b.on('POST /send-attempts', () => {
    throw new Error('a local send must never POST');
  });
  rig = companionRig();
  await rig.session.connect();
});
afterEach(() => {
  cleanup();
  rig.session.dispose();
  registerGate(null);
});

describe('SIMULATED: a UI bypass is refused by the guard inside the send call', () => {
  const blockedWith = async (g: OfflineGate, re: RegExp) => {
    registerGate(g);
    mountTree(null, rig.session);
    await ready();
    act(() => live.setDraftText(TARGET, 'must not go out'));
    const before = rig.mock.writes.length;
    let r!: ReturnType<MessagingValue['send']>;
    act(() => {
      r = live.send(TARGET, IDENT, USB_TO); // not through the UI: its disabled button and path checks are not involved
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && re.test(r.reason)).toBe(true);
    expect(rig.mock.writes.length).toBe(before);
    expect(rig.mock.sendWrites()).toHaveLength(0);
    expect(live.attemptsFor(TARGET)).toHaveLength(0);
    expect(live.draftText(TARGET)).toBe('must not go out'); // the draft is kept
    expect(posts()).toHaveLength(0);
  };

  it('offline and locked', async () => {
    await blockedWith(new OfflineGate(false), /locked/i);
  });
  it('offline with no lease', async () => {
    const g = new OfflineGate(false);
    g.setLeases(leaseSource('missing'));
    await blockedWith(g, /No offline lease/);
  });
  it('offline with a lease that does not name this identity', async () => {
    const g = new OfflineGate(false);
    g.setLeases(leaseSource('valid', leasePayload({ identities: [{ identity_id: 'someone_else', operations: ['send.direct'] }], devices: ['dev_demo_0001'] })));
    await blockedWith(g, /identity is not on your offline lease/);
  });

  it('offline with a lease that names it: allowed, and the device is written exactly once', async () => {
    const g = new OfflineGate(false);
    g.setLeases(leaseSource('valid', leasePayload({ identities: [{ identity_id: IDENT, operations: ['receive', 'send.direct'] }], devices: ['dev_demo_0001'] })));
    registerGate(g);
    mountTree(null, rig.session);
    await ready();
    act(() => live.setDraftText(TARGET, 'allowed'));
    let r!: ReturnType<MessagingValue['send']>;
    act(() => {
      r = live.send(TARGET, IDENT, USB_TO);
    });
    expect(r).toEqual({ ok: true });
    await waitFor(() => expect(rig.mock.sendWrites()).toHaveLength(1));
    expect(posts()).toHaveLength(0);
  });
});

describe('SIMULATED: a local attempt is persisted with its path, and comes back after a reload without sending anything', () => {
  it('path usb and the device facts survive; nothing is written to the device or the Backend on the way back', async () => {
    const store = await freshStore();
    const keys = await setupWithPasskey(store, USER, { webauthn: fakePasskey() });
    const opened = await OfflineCache.open(store, keys);
    if (!opened.ok) throw new Error('quarantined');
    registerGate(new OfflineGate(true));
    mountTree(opened.cache, rig.session);
    await ready();

    // One attempt that is acknowledged, one whose reply is lost (unknown).
    act(() => live.setDraftText(TARGET, 'first'));
    act(() => void live.send(TARGET, IDENT, USB_TO));
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('Acknowledged by the recipient device'));
    rig.mock.faults.dropNextSendReply = true;
    act(() => live.setDraftText(TARGET, 'second'));
    act(() => void live.send(TARGET, IDENT, USB_TO));
    await waitFor(() => expect(screen.getAllByRole('listitem')[1]!.textContent).toContain('Outcome unknown — not resent'));

    await waitFor(async () => {
      const saved = await opened.cache.listAttempts();
      expect(saved).toHaveLength(2);
      expect(saved.every((a) => a.path === 'usb')).toBe(true);
      expect(saved.find((a) => a.request.content.text === 'first')).toMatchObject({ phase: 'local', local: { deviceAccepted: true, dmAck: true, rfTransmitted: false } });
      expect(saved.find((a) => a.request.content.text === 'second')).toMatchObject({ phase: 'ambiguous', local: { unknown: true } });
    });
    const savedRaw = JSON.stringify(await store.keys(''));
    expect(savedRaw).not.toContain('first'); // sealed: no plaintext keys
    const writes = rig.mock.writes.length;

    // A new page: no device connected, the same cache.
    cleanup();
    const again = await OfflineCache.open(store, keys);
    if (!again.ok) throw new Error('quarantined');
    mountTree(again.cache, null);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['usb', 'usb']);
    expect(rows[0]!.textContent).toBe('Acknowledged by the recipient device|Device accepted: yes · Radio transmitted: not observed · Recipient ACK: yes');
    expect(rows[1]!.textContent).toContain('Outcome unknown — not resent');
    expect(rig.mock.writes.length).toBe(writes);
    expect(posts()).toHaveLength(0);
  });

  it('an attempt the device accepted but whose ACK was still awaited comes back as unknown (the session that watched it is gone)', async () => {
    const store = await freshStore();
    const keys = await setupWithPasskey(store, USER, { webauthn: fakePasskey() });
    const first = await OfflineCache.open(store, keys);
    if (!first.ok) throw new Error('quarantined');
    await first.cache.saveAttempt({
      clientAttemptId: 'att_pending_ack',
      draftId: 'draft_x',
      request: { client_draft_id: 'draft_x', client_attempt_id: 'att_pending_ack', identity_id: IDENT, target: TARGET, content: { kind: 'text', text: 'waiting' } },
      phase: 'local',
      attempt: null,
      error: null,
      supersededBy: null,
      createdAt: 1,
      path: 'ble',
      localTarget: {},
      local: { writeIssued: true, notSent: false, deviceAccepted: true, rfTransmitted: false, dmAck: false, ackTimedOut: false, unknown: false, deviceError: null, reason: null },
    });
    mountTree(first.cache, null);
    await ready();
    await waitFor(() => expect(screen.getByTestId('att_pending_ack').textContent).toContain('Outcome unknown — not resent'));
    expect(screen.getByTestId('att_pending_ack').getAttribute('data-path')).toBe('ble');
    expect(screen.getByTestId('att_pending_ack').textContent).toContain('Device accepted: yes');
    expect(posts()).toHaveLength(0);
  });
});
