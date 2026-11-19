import { useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import type { SendRequest } from '../api/types';
import { DeviceContext, type DevicesValue } from '../device/DeviceContext';
import { companionRig } from '../device/rig.test-util';
import { COLLISION_CONTACTS } from '../device/sim/lists';
import type { DeviceSession } from '../device/session';
import { OfflineGate, registerGate } from '../offline/gate';
import { createBackend, json, sessionWith, type Backend } from './backend';
import { attemptFor, channelConversation, channelMsgs, channels, contacts, dmConversation, dmMessages, olderConversation, page } from './m2';
import type { LocalDeviceHandle } from '../messaging/localPath';

// SIMULATED: a fake Backend (fetch mock) and a simulated Companion over a fake Web Serial port. No hardware, no RF.
let b: Backend;
let rig: ReturnType<typeof companionRig> | null = null;
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const posted = () => b.callsTo('POST /send-attempts');

// The synthetic Companion's own key starts 111111; this is the identity that belongs to it.
const identities = [
  { id: 'ident_demo_0001', display_name: 'Demo Companion', public_key_prefix: '111111', device_id: 'dev_demo_0001', can_send: true },
  { id: 'ident_demo_0002', display_name: 'Demo Spare', public_key_prefix: 'd4e5f6', device_id: null, can_send: true },
];

function devicesValue(handle: LocalDeviceHandle | null): DevicesValue {
  return { handles: handle ? { usb: handle } : {}, hasApi: () => true, connect: async () => null, disconnect: async () => undefined };
}

function mount(handle: LocalDeviceHandle | null, value: DevicesValue = devicesValue(handle)) {
  return render(
    <MemoryRouter initialEntries={['/chats']}>
      <AuthProvider>
        <DeviceContext.Provider value={value}>
          <App />
        </DeviceContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function routes(send: 'available' | 'unavailable' = 'available', channelName: string | null = null) {
  b.on('GET /session', json(sessionWith({ messaging: 'available', send, events: 'unavailable' })));
  b.on('GET /conversations?limit=50', json(page([dmConversation, channelConversation], 'cur_2')));
  b.on('GET /conversations?cursor=cur_2&limit=50', json(page([olderConversation])));
  b.on('GET /identities', json(page(identities)));
  b.on('GET /channels', json(page(channelName ? [{ ...channels[0]!, name: channelName }, ...channels.slice(1)] : channels)));
  b.on('GET /contacts?limit=200', json(page(contacts)));
  b.on(`GET /conversations/${dmConversation.id}/messages?limit=50`, json(page(dmMessages, 'old_1')));
  b.on(`GET /conversations/${channelConversation.id}/messages?limit=50`, json(page(channelMsgs.filter((m) => m.conversation_id === channelConversation.id))));
  b.on(`POST /conversations/${dmConversation.id}/read`, () => new Response(null, { status: 204 }));
}

async function connectedRig(mock: Parameters<typeof companionRig>[0] extends infer O ? (O extends { mock?: infer M } ? M : never) : never = {}) {
  rig = companionRig({ mock: { channels: true, ...mock } });
  expect(await rig.session.connect()).toEqual({ ok: true, error: null });
  return rig;
}

async function openDm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('link', { name: /Demo Peer \(merged pair\)/ }));
  await screen.findByText('Hello from the peer');
}
/** There is nothing to choose: Alice is found on the device by her key prefix. This waits for that to be shown. */
async function chooseContact(user: ReturnType<typeof userEvent.setup>) {
  void user;
  expect(await screen.findByTestId('device-destination')).toHaveTextContent('Device contact: Alice Synthetic (a1a1a1)');
  expect(screen.queryByLabelText('Device contact')).not.toBeInTheDocument();
}
const pathNames = () => within(screen.getByTestId('send-path')).queryAllByRole('radio').map((r) => (r as HTMLInputElement).parentElement!.textContent);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  b = createBackend();
  vi.stubGlobal('fetch', b.fetchMock);
});
afterEach(() => {
  cleanup();
  rig?.session.dispose();
  rig = null;
  registerGate(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SIMULATED: the composer offers only the paths that can carry the send', () => {
  it('no device: Backend only, and the old wording stands', async () => {
    routes();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(null);
    await openDm(user);
    expect(await screen.findByText(/Sent through the Backend\./)).toBeInTheDocument();
    expect(pathNames()).toEqual([]);
  });

  it('a connected own device: Backend and USB are both shown, Backend is the default', async () => {
    routes();
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await screen.findByRole('radio', { name: 'USB' });
    expect(pathNames()).toEqual(['Backend', 'USB']);
    expect(screen.getByRole('radio', { name: 'Backend' })).toBeChecked();
  });

  it('a device that belongs to another identity is not offered (pick the spare identity)', async () => {
    routes();
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await screen.findByRole('radio', { name: 'USB' });
    await user.selectOptions(screen.getByLabelText('Send as'), 'ident_demo_0002');
    expect(screen.queryByRole('radio', { name: 'USB' })).not.toBeInTheDocument();
    expect(screen.getByText(/Sent through the Backend\./)).toBeInTheDocument();
  });

  it('a device whose detected capabilities lack the send operation is not offered (capability, not role)', async () => {
    routes();
    const r = await connectedRig();
    const weak = new Proxy(r.session, {
      get(t, k) {
        if (k === 'can') return () => false;
        if (k === 'getSnapshot') {
          return () => {
            const s = t.getSnapshot();
            return { ...s, detected: s.detected ? { ...s.detected, capabilities: s.detected.capabilities.filter((c) => !c.startsWith('message.send')) } : null };
          };
        }
        return Reflect.get(t, k) as unknown;
      },
    }) as DeviceSession;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(weak);
    await openDm(user);
    expect(await screen.findByText(/Sent through the Backend\./)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'USB' })).not.toBeInTheDocument();
  });

  it('a channel the device does not have gets no local path, no slot entry, and the reason is stated', async () => {
    routes();
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await user.click(await screen.findByRole('link', { name: /Demo Channel/ }));
    await screen.findByText('Synthetic channel message');
    expect(await screen.findByTestId('local-unavailable-usb')).toHaveTextContent('No channel named "Demo Channel" is on your device.');
    expect(screen.queryByRole('radio', { name: 'USB' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/slot/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Sent through the Backend\./)).toBeInTheDocument();
  });

  it('a channel that is the caller’s own and has exactly one namesake on the device is offered, with no slot to type', async () => {
    routes('available', 'Crew');
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await user.click(await screen.findByRole('link', { name: /Demo Channel/ }));
    await screen.findByText('Synthetic channel message');
    await screen.findByRole('radio', { name: 'USB' });
    await user.click(screen.getByRole('radio', { name: 'USB' }));
    expect(await screen.findByTestId('device-destination')).toHaveTextContent('Device channel: Crew');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Message'), 'hello crew');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(r.mock.sendWrites()).toHaveLength(1));
    expect(r.mock.rf).toEqual([expect.objectContaining({ kind: 'channel', target: '1' })]); // Crew is slot 1 on the device
    expect(posted()).toHaveLength(0);
  });

  it('a DM contact that is not on the device gets no local path, with the reason, and no contact list to pick from', async () => {
    routes();
    const r = await connectedRig({ contacts: [{ key: 'b2'.repeat(32), name: 'Bob Synthetic' }] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    expect(await screen.findByTestId('local-unavailable-usb')).toHaveTextContent("This contact isn't on your device.");
    expect(screen.queryByRole('radio', { name: 'USB' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Device contact')).not.toBeInTheDocument();
  });

  it('an ambiguous DM contact: the picker offers only the matching candidates (not Bob), and nothing is written until one is chosen', async () => {
    routes();
    const r = await connectedRig({ contacts: COLLISION_CONTACTS });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await screen.findByRole('radio', { name: 'USB' });
    await user.click(screen.getByRole('radio', { name: 'USB' }));
    const picker = await screen.findByLabelText('Device contact');
    const names = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual([expect.stringContaining('match'), expect.stringContaining('Alice Synthetic'), expect.stringContaining('Alice Clone')]);
    expect(names.join('|')).not.toContain('Bob');
    await user.type(screen.getByLabelText('Message'), 'which alice');
    expect(screen.getByTestId('local-blocked')).toHaveTextContent('Choose which of the matching device contacts');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(r.mock.sendWrites()).toHaveLength(0);
    await user.selectOptions(picker, screen.getByRole('option', { name: /Alice Clone/ }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(r.mock.sendWrites()).toHaveLength(1));
    expect(r.mock.rf).toEqual([expect.objectContaining({ kind: 'direct', target: 'a1a1a1a1e0e0' })]);
    expect(posted()).toHaveLength(0);
  });

  it('with sending switched off on the Backend, a connected device is the only path, and says so', async () => {
    routes('unavailable');
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    expect(await screen.findByText(/Sent through the USB\./)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Backend' })).not.toBeInTheDocument();
  });

  // Issue 87: with the Backend unable to send, the composer (and so the only Connect control) must still be reachable.
  it('Backend sending off, both device APIs, nothing connected: a composer with a connect button for each API, Send disabled, no Backend route', async () => {
    routes('unavailable');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(null);
    await openDm(user);
    expect(await screen.findByLabelText('Message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Bluetooth device' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect USB device' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(/No send path is available\. Connect your device/)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sent through the Backend/)).not.toBeInTheDocument();
    expect(screen.queryByText('Sending is not available')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Message'), 'typed but no route');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(posted()).toHaveLength(0);
  });

  it('Backend sending off, only Web Serial: only the USB connect button', async () => {
    routes('unavailable');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(null, { ...devicesValue(null), hasApi: (p) => p === 'usb' });
    await openDm(user);
    expect(await screen.findByRole('button', { name: 'Connect USB device' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Bluetooth device' })).not.toBeInTheDocument();
  });

  it('Backend sending off and no device API and no device: the unavailable state, no composer', async () => {
    routes('unavailable');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(null, { ...devicesValue(null), hasApi: () => false });
    await openDm(user);
    expect(await screen.findByText('Sending is not available')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });

  it('Backend sending forbidden keeps its own state even with device APIs', async () => {
    routes('unavailable');
    b.on('GET /session', json(sessionWith({ messaging: 'available', send: 'forbidden', events: 'unavailable' })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(null);
    await openDm(user);
    expect(await screen.findByText('Sending is not permitted')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });

  it('Backend sending off: after a simulated device connects, the local path is offered and selected, and Send is enabled', async () => {
    routes('unavailable');
    const r = await connectedRig();
    function Harness() {
      const [h, setH] = useState<LocalDeviceHandle | null>(null);
      const value: DevicesValue = { ...devicesValue(h), connect: async () => { setH(r.session); return null; } };
      return (
        <DeviceContext.Provider value={value}>
          <App />
        </DeviceContext.Provider>
      );
    }
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <MemoryRouter initialEntries={['/chats']}>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </MemoryRouter>,
    );
    await openDm(user);
    await user.type(await screen.findByLabelText('Message'), 'hello over usb');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Connect USB device' }));
    expect(await screen.findByText(/Sent through the USB\./)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Backend' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Send as')).toHaveValue('ident_demo_0001'); // the device's own identity is chosen
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(posted()).toHaveLength(0);
  });
});

describe('SIMULATED: a local send, and what it never does', () => {
  async function sendViaUsb(user: ReturnType<typeof userEvent.setup>, text = 'hello over usb') {
    await screen.findByRole('radio', { name: 'USB' });
    await user.click(screen.getByRole('radio', { name: 'USB' }));
    await chooseContact(user);
    await user.type(screen.getByLabelText('Message'), text);
    await user.click(screen.getByRole('button', { name: 'Send' }));
  }

  it('online, USB: the device accepts, then the recipient ACK shows; zero Backend POSTs; one device write; RF is "not observed"', async () => {
    routes();
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await sendViaUsb(user);
    await screen.findByText('Acknowledged by the recipient device');
    expect(screen.getByTestId('attempt-facts')).toHaveTextContent('Device accepted: yes · Radio transmitted: not observed · Recipient ACK: yes');
    expect(screen.getByText(/You · not yet in history · via USB/)).toBeInTheDocument();
    expect(posted()).toHaveLength(0);
    expect(r.mock.sendWrites()).toHaveLength(1);
  });

  it('a lost reply is "outcome unknown": one device write, zero Backend POSTs, nothing after a long wait, no automatic resend or reroute', async () => {
    routes();
    const r = await connectedRig();
    r.mock.faults.dropNextSendReply = true;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await sendViaUsb(user);
    await screen.findByText('Outcome unknown — not resent');
    await tick(120_000);
    expect(r.mock.sendWrites()).toHaveLength(1);
    expect(posted()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument(); // there is no Backend attempt to re-check
  });

  it('a Backend ambiguous send with a device connected: only the same Backend attempt is re-POSTed; zero device writes', async () => {
    routes();
    b.on('POST /send-attempts', () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await user.type(await screen.findByLabelText('Message'), 'via backend');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Outcome unknown — not resent');
    await tick(60_000);
    expect(posted()).toHaveLength(3);
    expect(new Set(posted().map((c) => (JSON.parse(c.body!) as SendRequest).client_attempt_id)).size).toBe(1);
    expect(r.mock.writes.filter((w) => w[0] === 2 || w[0] === 3)).toHaveLength(0); // no send command ever reached the device
    expect(r.mock.sendWrites()).toHaveLength(0);
  });

  it('Send again is explicit: a new attempt id, the same draft id, on the path the user picks (here: Backend after a local unknown)', async () => {
    routes();
    b.on('POST /send-attempts', () => new Response(JSON.stringify(attemptFor(b.calls.at(-1)!.body, 'queued')), { status: 201 }));
    const r = await connectedRig();
    r.mock.faults.dropNextSendReply = true;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await sendViaUsb(user, 'again please');
    await screen.findByText('Outcome unknown — not resent');
    const firstDraft = r.session.getSnapshot().companion!.attempts[0]!.clientDraftId;
    const firstAttempt = r.session.getSnapshot().companion!.attempts[0]!.clientAttemptId;
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    const confirm = screen.getByRole('group', { name: 'Confirm sending again' });
    // The path starts where the earlier attempt went. After an unknown the link was reset, so USB is
    // gone: the Reader says so and does not pick another path for the user.
    expect(within(confirm).getByTestId('path-gone')).toHaveTextContent('USB is no longer available');
    expect(within(confirm).getByRole('button', { name: 'Send as a new attempt' })).toBeDisabled();
    await user.click(within(confirm).getByRole('radio', { name: 'Backend' }));
    await user.click(within(confirm).getByRole('button', { name: 'Send as a new attempt' }));
    await screen.findByText('Queued');
    expect(posted()).toHaveLength(1);
    const body = JSON.parse(posted()[0]!.body!) as SendRequest;
    expect(body.client_draft_id).toBe(firstDraft);
    expect(body.client_attempt_id).not.toBe(firstAttempt);
    expect(r.mock.sendWrites()).toHaveLength(1); // the device was not asked again
  });

  it('Send again on the same local path writes once more under a new attempt id and the same draft id', async () => {
    routes();
    const r = await connectedRig();
    r.mock.faults.dropNextSendReply = true;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await sendViaUsb(user, 'twice');
    await screen.findByText('Outcome unknown — not resent');
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    // After an unknown the link was reset; the user reconnects explicitly before sending again.
    expect(await r.session.reconnect()).toEqual({ ok: true, error: null });
    await user.click(within(screen.getByRole('group', { name: 'Confirm sending again' })).getByRole('button', { name: 'Send as a new attempt' }));
    await waitFor(() => expect(r.mock.sendWrites()).toHaveLength(2));
    const [first, second] = r.session.getSnapshot().companion!.attempts;
    expect(second!.clientAttemptId).not.toBe(first!.clientAttemptId);
    expect(second!.clientDraftId).toBe(first!.clientDraftId);
    expect(posted()).toHaveLength(0);
  });

  it('if the chosen path disappears, nothing replaces it: the send stays disabled until the user chooses again', async () => {
    routes();
    const r = await connectedRig();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await screen.findByRole('radio', { name: 'USB' });
    await user.click(screen.getByRole('radio', { name: 'USB' }));
    await user.type(screen.getByLabelText('Message'), 'stay put');
    act(() => r.h.unplug());
    await screen.findByTestId('path-gone');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(posted()).toHaveLength(0);
    await user.click(screen.getByRole('radio', { name: 'Backend' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

describe('SIMULATED: the offline gate on the composer', () => {
  it('offline with no lease: the device path is shown blocked with the reason, Send is disabled, nothing is written', async () => {
    routes();
    const r = await connectedRig();
    const g = new OfflineGate(false);
    g.setLeases(null);
    registerGate(g);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount(r.session);
    await openDm(user);
    await screen.findByRole('radio', { name: 'USB' });
    await user.click(screen.getByRole('radio', { name: 'USB' }));
    await chooseContact(user);
    await user.type(screen.getByLabelText('Message'), 'blocked');
    expect(await screen.findByTestId('local-blocked')).toHaveTextContent(/locked/i);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(r.mock.sendWrites()).toHaveLength(0);
  });
});
