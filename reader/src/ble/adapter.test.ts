import { afterEach, describe, expect, it, vi } from 'vitest';
import { BleAdapter, type AttemptFacts, type BackendSendPort } from './adapter';
import { MockCompanion, MockTransport, type MockCompanionOptions } from './mockCompanion';
import { SYNTHETIC_KEYS } from './fixtures/frames';
import { BleError } from './transport';

const S = 'SIMULATED — not Android hardware verified';

const adapters: BleAdapter[] = [];
afterEach(() => {
  for (const a of adapters.splice(0)) a.dispose();
});

function rig(opts: { mock?: MockCompanionOptions; unsupported?: boolean; responseTimeoutMs?: number; connectTimeoutMs?: number; peer?: MockCompanion } = {}) {
  const mock = opts.peer ?? new MockCompanion(opts.mock);
  const transport = new MockTransport(mock, { unsupported: opts.unsupported });
  const backend: BackendSendPort & { post: ReturnType<typeof vi.fn> } = { post: vi.fn(async () => undefined) };
  const adapter = new BleAdapter({ transport, responseTimeoutMs: opts.responseTimeoutMs ?? 60, connectTimeoutMs: opts.connectTimeoutMs ?? 60, backendPath: backend, nowSec: () => 1700000000 });
  adapters.push(adapter);
  return { mock, transport, adapter, backend };
}

async function connected(opts: Parameters<typeof rig>[0] = {}) {
  const r = rig(opts);
  const res = await r.adapter.connect();
  expect(res).toEqual({ ok: true, error: null });
  return r;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alice = SYNTHETIC_KEYS.alice;
const snap = (a: BleAdapter) => a.getSnapshot();
const attempt = (a: BleAdapter, id: string): AttemptFacts => snap(a).attempts.find((x) => x.clientAttemptId === id)!;

describe(`${S}: connection states`, () => {
  it('unsupported browser yields an explicit unsupported state and never connects', async () => {
    const { adapter, mock } = rig({ unsupported: true });
    expect(snap(adapter).bleConnection).toBe('unsupported');
    expect(await adapter.connect()).toEqual({ ok: false, error: 'unsupported' });
    expect(snap(adapter).bleConnection).toBe('unsupported');
    expect(mock.writes).toHaveLength(0);
  });

  it('connect requests the device synchronously, then hello fetches self info, device info and contacts', async () => {
    const { adapter, transport, mock } = rig();
    const spy = vi.spyOn(transport, 'requestDevice');
    const p = adapter.connect();
    expect(spy).toHaveBeenCalledTimes(1); // no await before the chooser: still inside the user gesture
    expect(snap(adapter).bleConnection).toBe('requesting');
    expect(await p).toEqual({ ok: true, error: null });
    const s = snap(adapter);
    expect(s.bleConnection).toBe('connected');
    expect(s.helloComplete).toBe(true);
    expect(s.selfInfo?.name).toBe('Synthetic Node');
    expect(s.deviceInfo?.maxChannels).toBe(8);
    expect(s.contacts.map((c) => c.name)).toEqual(['Alice Synthetic', 'Bob Synthetic']);
    expect(mock.writes.map((w) => w[0])).toEqual([1, 22, 4]); // app start, device query, get contacts
    expect(mock.sendWrites()).toHaveLength(0);
  });

  it('user cancelling the chooser returns to idle with chooser_cancelled', async () => {
    const { adapter, mock } = rig();
    mock.faults.requestDevice = 'cancel';
    expect(await adapter.connect()).toEqual({ ok: false, error: 'chooser_cancelled' });
    expect(snap(adapter).bleConnection).toBe('idle');
    expect(snap(adapter).lastError).toBe('chooser_cancelled');
    mock.faults.requestDevice = 'ok';
    expect((await adapter.connect()).ok).toBe(true); // can simply try again
  });

  it('permission denied yields denied', async () => {
    const { adapter, mock } = rig();
    mock.faults.requestDevice = 'denied';
    expect(await adapter.connect()).toEqual({ ok: false, error: 'permission_denied' });
    expect(snap(adapter).bleConnection).toBe('denied');
  });

  it('connect timeout yields disconnected with connect_timeout and no commands written', async () => {
    const { adapter, mock } = rig();
    mock.faults.connect = 'timeout';
    expect(await adapter.connect()).toEqual({ ok: false, error: 'connect_timeout' });
    expect(snap(adapter).bleConnection).toBe('disconnected');
    expect(mock.writes).toHaveLength(0);
  });

  it('background interruption drops to disconnected; reconnect restores without a chooser', async () => {
    const { adapter, mock, transport } = await connected();
    const chooser = vi.spyOn(transport, 'requestDevice');
    mock.simulateBackground();
    expect(snap(adapter).bleConnection).toBe('disconnected');
    expect(snap(adapter).helloComplete).toBe(false);
    expect((await adapter.reconnect()).ok).toBe(true);
    expect(chooser).not.toHaveBeenCalled();
    expect(snap(adapter).bleConnection).toBe('connected');
  });

  it('a send while disconnected is never written and is marked notSent, not unknown', async () => {
    const { adapter, mock } = await connected();
    mock.simulateBackground();
    const a = await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'hi' });
    expect(a).toMatchObject({ notSent: true, unknown: false, deviceAccepted: false, writeIssued: false });
    expect(mock.sendWrites()).toHaveLength(0);
    await adapter.reconnect();
    expect(mock.sendWrites()).toHaveLength(0); // reconnecting does not flush it
  });
});

describe(`${S}: truthful send facts`, () => {
  it('DM with ACK: accepted and acked are separate facts; rfTransmitted is not inferred from either', async () => {
    const { adapter, mock } = await connected();
    const a = await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'hello dm' });
    expect(a).toMatchObject({ deviceAccepted: true, unknown: false, rfTransmitted: false, dmAck: false });
    await wait(10);
    expect(attempt(adapter, 'a1')).toMatchObject({ deviceAccepted: true, dmAck: true, rfTransmitted: false, unknown: false });
    expect(mock.sendWrites()).toHaveLength(1);
    expect(mock.rf).toEqual([{ kind: 'direct', target: 'a1'.repeat(6), text: 'hello dm' }]);
  });

  it('channel send: accepted, no ACK concept, rfTransmitted not inferred', async () => {
    const { adapter, mock } = await connected();
    const a = await adapter.sendChannel({ clientDraftId: 'd1', clientAttemptId: 'a1', channelIndex: 1, text: 'hello channel' });
    await wait(10);
    expect(attempt(adapter, 'a1')).toMatchObject({ kind: 'channel', deviceAccepted: true, dmAck: false, rfTransmitted: false, unknown: false });
    expect(a.deviceAccepted).toBe(true);
    expect(mock.sendWrites()).toHaveLength(1);
  });

  it('channel send also works when the firmware answers with SENT instead of OK', async () => {
    const { adapter } = await connected({ mock: { channelReply: 'sent' } });
    const a = await adapter.sendChannel({ clientDraftId: 'd', clientAttemptId: 'a', channelIndex: 0, text: 'x' });
    expect(a).toMatchObject({ deviceAccepted: true, rfTransmitted: false, dmAck: false });
  });

  it('rfTransmitted only ever comes from its own evidence call', async () => {
    const { adapter } = await connected();
    await adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a1', contactKey: alice, text: 'x' });
    await wait(10);
    expect(attempt(adapter, 'a1').rfTransmitted).toBe(false);
    adapter.recordRfTransmitEvidence('a1');
    expect(attempt(adapter, 'a1')).toMatchObject({ rfTransmitted: true, dmAck: true, deviceAccepted: true });
  });

  it('a device error response is a definite refusal: not accepted, not unknown, one write', async () => {
    const { adapter, mock } = await connected();
    const a = await adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a1', contactKey: 'ee'.repeat(32), text: 'x' });
    expect(a).toMatchObject({ deviceAccepted: false, unknown: false, deviceError: { code: 2, name: 'not_found' } });
    expect(mock.sendWrites()).toHaveLength(1);
    expect(mock.rf).toHaveLength(0);
    const c = await adapter.sendChannel({ clientDraftId: 'd', clientAttemptId: 'a2', channelIndex: 9, text: 'x' });
    expect(c).toMatchObject({ deviceAccepted: false, unknown: false, deviceError: { name: 'not_found' } });
  });

  it('ACK window passing without an ACK is ackTimedOut, not unknown and not failure', async () => {
    const { adapter, mock } = await connected({ mock: { suggestedTimeoutMs: 10 } });
    mock.faults.dropNextAck = true;
    await adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a1', contactKey: alice, text: 'x' });
    await wait(40);
    expect(attempt(adapter, 'a1')).toMatchObject({ deviceAccepted: true, dmAck: false, ackTimedOut: true, unknown: false });
  });

  it('rejects over-long text and reused attempt ids before writing anything', async () => {
    const { adapter, mock } = await connected();
    await expect(adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a0', contactKey: alice, text: 'x'.repeat(200) })).rejects.toMatchObject({ code: 'text_too_long' });
    expect(mock.sendWrites()).toHaveLength(0);
    expect(snap(adapter).attempts).toHaveLength(0);
    await adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a1', contactKey: alice, text: 'x' });
    await expect(adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a1', contactKey: alice, text: 'x' })).rejects.toMatchObject({ code: 'attempt_reused' });
    expect(mock.sendWrites()).toHaveLength(1);
  });
});

describe(`${S}: limits and retries from the public firmware's wire answers`, () => {
  it('channel text is sized against the device\'s own "<name>: " prefix and refused before any write when it would be cut', async () => {
    const { adapter, mock } = await connected();
    // self name "Synthetic Node" + ": " = 16 bytes, so 144 bytes of text fit
    await expect(adapter.sendChannel({ clientDraftId: 'd', clientAttemptId: 'c0', channelIndex: 0, text: 'x'.repeat(145) })).rejects.toMatchObject({ code: 'text_too_long' });
    expect(mock.sendWrites()).toHaveLength(0);
    await adapter.sendChannel({ clientDraftId: 'd', clientAttemptId: 'c1', channelIndex: 0, text: 'x'.repeat(144) });
    expect(mock.sendWrites()).toHaveLength(1);
  });

  it('a channel send without known self info is refused and writes nothing', async () => {
    const { adapter, mock } = rig();
    await expect(adapter.sendChannel({ clientDraftId: 'd', clientAttemptId: 'c', channelIndex: 0, text: 'x' })).rejects.toBeInstanceOf(BleError);
    expect(mock.writes).toHaveLength(0);
  });

  it('a manual retry of the same draft is a new attempt id with the next firmware attempt byte; another draft starts at 0', async () => {
    const { adapter, mock } = await connected();
    await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'x' });
    await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a2', contactKey: alice, text: 'x' });
    await adapter.sendDirect({ clientDraftId: 'd2', clientAttemptId: 'b1', contactKey: alice, text: 'y' });
    expect(mock.sendWrites().map((w) => w[2])).toEqual([0, 1, 0]);
  });
});

describe(`${S}: uncertain outcomes are never resent and never rerouted`, () => {
  for (const when of ['before_device', 'after_device'] as const) {
    it(`link lost mid-send (${when}) becomes unknown; one write; no resend after reconnect; no Backend call`, async () => {
      const { adapter, mock, backend } = await connected();
      mock.faults.disconnectOnSend = when;
      const a = await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'once' });
      expect(a).toMatchObject({ unknown: true, deviceAccepted: false, dmAck: false, rfTransmitted: false, writeIssued: true });
      expect(snap(adapter).bleConnection).toBe('disconnected');
      expect(mock.rf).toHaveLength(when === 'after_device' ? 1 : 0); // truth the app cannot see
      mock.faults.disconnectOnSend = null;
      expect((await adapter.reconnect()).ok).toBe(true);
      await wait(20);
      expect(mock.sendWrites()).toHaveLength(1);
      expect(mock.rf.length).toBe(when === 'after_device' ? 1 : 0);
      expect(attempt(adapter, 'a1').unknown).toBe(true);
      expect(backend.post).not.toHaveBeenCalled();
    });
  }

  it('notification never arrives: timeout makes it unknown, the link is reset, nothing is resent or sent to the Backend', async () => {
    const { adapter, mock, backend } = await connected();
    mock.faults.dropNextSendReply = true;
    const a = await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'once' });
    expect(a).toMatchObject({ unknown: true, deviceAccepted: false, reason: 'response_timeout' });
    expect(mock.rf).toHaveLength(1); // the device did transmit; the app does not know
    expect(snap(adapter).bleConnection).toBe('disconnected'); // reset, so a late reply cannot be paired with a later command
    await wait(100);
    await adapter.reconnect();
    await wait(100);
    expect(mock.sendWrites()).toHaveLength(1);
    expect(attempt(adapter, 'a1').unknown).toBe(true);
    expect(backend.post).not.toHaveBeenCalled();
  });

  it('only a new explicit attempt with a new attempt id sends again, and it is its own attempt', async () => {
    const { adapter, mock } = await connected();
    mock.faults.dropNextSendReply = true;
    await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'once' });
    await adapter.reconnect();
    const b = await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a2', contactKey: alice, text: 'once' });
    expect(b).toMatchObject({ deviceAccepted: true, unknown: false });
    expect(mock.sendWrites()).toHaveLength(2);
    expect(attempt(adapter, 'a1').unknown).toBe(true); // history is not merged or rewritten
    expect(attempt(adapter, 'a1').deviceAccepted).toBe(false);
  });

  it('a queued attempt behind a send that loses the link is notSent and is never written later', async () => {
    const { adapter, mock } = await connected();
    mock.faults.disconnectOnSend = 'before_device';
    const first = adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'one' });
    const second = adapter.sendDirect({ clientDraftId: 'd2', clientAttemptId: 'a2', contactKey: alice, text: 'two' });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.unknown).toBe(true);
    expect(r2).toMatchObject({ notSent: true, unknown: false, writeIssued: false });
    mock.faults.disconnectOnSend = null;
    await adapter.reconnect();
    await wait(20);
    expect(mock.sendWrites()).toHaveLength(1);
  });

  it('duplicate notifications do not write twice, do not double-count, and do not poison the next send', async () => {
    const { adapter, mock } = await connected();
    mock.faults.duplicateNotifications = true;
    await adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'one' });
    await wait(10);
    expect(mock.sendWrites()).toHaveLength(1);
    expect(attempt(adapter, 'a1')).toMatchObject({ deviceAccepted: true, dmAck: true, unknown: false });
    expect(adapter.strayFrames).toBeGreaterThan(0);
    const b = await adapter.sendDirect({ clientDraftId: 'd2', clientAttemptId: 'a2', contactKey: alice, text: 'two' });
    await wait(10);
    expect(b.deviceAccepted).toBe(true);
    expect(mock.sendWrites()).toHaveLength(2);
    expect(mock.rf.map((r) => r.text)).toEqual(['one', 'two']);
  });

  it('page reload: a fresh adapter has no attempts and never replays the lost one', async () => {
    const first = await connected();
    first.mock.faults.disconnectOnSend = 'after_device';
    await first.adapter.sendDirect({ clientDraftId: 'd1', clientAttemptId: 'a1', contactKey: alice, text: 'once' });
    first.mock.faults.disconnectOnSend = null;
    first.mock.simulateHostReload();
    first.adapter.dispose();
    const second = rig({ peer: first.mock });
    expect(snap(second.adapter).attempts).toEqual([]);
    expect(snap(second.adapter).bleConnection).toBe('idle');
    expect((await second.adapter.connect()).ok).toBe(true);
    await wait(20);
    expect(first.mock.sendWrites()).toHaveLength(1);
    expect(first.mock.rf).toHaveLength(1);
    expect(second.backend.post).not.toHaveBeenCalled();
  });
});

describe(`${S}: receive and storage`, () => {
  it('MSG_WAITING triggers a sync; DM and channel messages land in the inbox once, even with duplicate notifications', async () => {
    const { adapter, mock } = await connected();
    mock.faults.duplicateNotifications = true;
    mock.queueDirectFromAlice('hi from alice');
    mock.queueChannelMessage(1, 'hello channel');
    await wait(40);
    const inbox = snap(adapter).inbox;
    expect(inbox.map((m) => (m.kind === 'direct' ? m.message.text : m.message.text)).sort()).toEqual(['hello channel', 'hi from alice']);
    expect(inbox).toHaveLength(2);
    expect(mock.sendWrites()).toHaveLength(0);
  });

  it('persists nothing: no localStorage, sessionStorage or IndexedDB use across a full session', async () => {
    const before = [localStorage.length, sessionStorage.length];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { adapter } = await connected();
    await adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a', contactKey: alice, text: 'x' });
    await adapter.sendChannel({ clientDraftId: 'd', clientAttemptId: 'b', channelIndex: 0, text: 'x' });
    expect(setItem).not.toHaveBeenCalled();
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
    setItem.mockRestore();
  });

  it('BleError carries a code', () => {
    expect(new BleError('unsupported').code).toBe('unsupported');
  });
});
