import { describe, expect, it, vi } from 'vitest';
import { BleAdapter } from './adapter';
import { installFakeBluetooth } from './fakeBluetooth';
import { MAX_FRAME_SIZE, encodeAppStart } from './protocol';
import { WebBluetoothTransport, detectSupport, mapRequestError } from './webBluetoothTransport';
import { SYNTHETIC_KEYS } from './fixtures/frames';

const S = 'SIMULATED — not Android hardware verified: WebBluetoothTransport';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nav(active = true) {
  const n: Record<string, unknown> = { userActivation: { isActive: active } };
  const handle = installFakeBluetooth(n);
  return { n, handle, mock: handle.mock };
}

describe(S, () => {
  it('feature-detects: no navigator.bluetooth means unsupported, and requestDevice refuses', async () => {
    const t = new WebBluetoothTransport({});
    expect(t.support).toBe('unsupported');
    expect(detectSupport({})).toBe('unsupported');
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'unsupported' });
    const adapter = new BleAdapter({ transport: t });
    expect(adapter.getSnapshot().bleConnection).toBe('unsupported');
  });

  it('refuses requestDevice without a user gesture before reaching the browser chooser', async () => {
    const { n, handle } = nav(false);
    const t = new WebBluetoothTransport(n);
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'gesture_required' });
    expect(handle.requestDeviceCalls()).toBe(0);
  });

  it('maps the browser own gesture error (SecurityError) to gesture_required when userActivation is not exposed', async () => {
    const n: Record<string, unknown> = {};
    const handle = installFakeBluetooth(n);
    // Fake browser refuses: simulate by making the activation check fail inside the fake only.
    Object.defineProperty(n, 'userActivation', { value: { isActive: false }, configurable: true });
    const t = new WebBluetoothTransport({ bluetooth: (n as { bluetooth: unknown }).bluetooth });
    await expect(t.requestDevice()).rejects.toMatchObject({ code: 'gesture_required' });
    expect(handle.requestDeviceCalls()).toBe(1);
  });

  it('maps permission denied and chooser cancel', async () => {
    const { n, mock } = nav();
    mock.faults.requestDevice = 'denied';
    await expect(new WebBluetoothTransport(n).requestDevice()).rejects.toMatchObject({ code: 'permission_denied' });
    mock.faults.requestDevice = 'cancel';
    await expect(new WebBluetoothTransport(n).requestDevice()).rejects.toMatchObject({ code: 'chooser_cancelled' });
    expect(mapRequestError(Object.assign(new Error('x'), { name: 'NotSupportedError' })).code).toBe('unsupported');
  });

  it('connects, receives notifications as copies, and writes each frame as exactly one GATT write', async () => {
    const { n, mock } = nav();
    const t = new WebBluetoothTransport(n);
    const frames: Uint8Array[] = [];
    t.onFrame((f) => frames.push(f));
    expect(await t.requestDevice()).toEqual({ id: 'synthetic-device-1', name: 'MeshCore-Synthetic' });
    await t.connect();
    await t.write(encodeAppStart());
    await wait(5);
    expect(mock.writes).toHaveLength(1);
    expect(frames.map((f) => f[0])).toEqual([5]); // SELF_INFO
    frames[0]![0] = 99;
    await t.write(new Uint8Array(MAX_FRAME_SIZE).fill(0x16));
    expect(mock.writes).toHaveLength(2);
    await expect(t.write(new Uint8Array(MAX_FRAME_SIZE + 1))).rejects.toMatchObject({ code: 'frame_too_large' });
    expect(mock.writes).toHaveLength(2);
  });

  it('reports link loss, then reconnects with no chooser', async () => {
    const { n, mock, handle } = nav();
    const t = new WebBluetoothTransport(n);
    const lost = vi.fn();
    t.onDisconnect(lost);
    await t.requestDevice();
    await t.connect();
    mock.dropLink('x');
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(t.write(encodeAppStart())).rejects.toMatchObject({ code: 'not_connected' });
    await t.connect();
    await t.write(encodeAppStart());
    expect(handle.requestDeviceCalls()).toBe(1);
  });

  it('connect failure surfaces as connect_failed', async () => {
    const { n, mock } = nav();
    const t = new WebBluetoothTransport(n);
    await t.requestDevice();
    mock.faults.connect = 'fail';
    await expect(t.connect()).rejects.toMatchObject({ code: 'connect_failed' });
  });

  it('the whole adapter works through the Web Bluetooth transport: hello, DM with ACK, background drop', async () => {
    const { n, handle, mock } = nav();
    const adapter = new BleAdapter({ transport: new WebBluetoothTransport(n), responseTimeoutMs: 100 });
    expect((await adapter.connect()).ok).toBe(true);
    await vi.waitFor(() => expect(adapter.getSnapshot().contactsState).toBe('loaded'));
    expect(adapter.getSnapshot().contacts).toHaveLength(2);
    const a = await adapter.sendDirect({ clientDraftId: 'd', clientAttemptId: 'a', contactKey: SYNTHETIC_KEYS.bob, text: 'hi' });
    await wait(10);
    expect(a.deviceAccepted).toBe(true);
    expect(adapter.getSnapshot().attempts[0]).toMatchObject({ dmAck: true, rfTransmitted: false });
    handle.simulateBackground();
    expect(document.visibilityState).toBe('hidden');
    expect(adapter.getSnapshot().bleConnection).toBe('disconnected');
    expect(mock.sendWrites()).toHaveLength(1);
    adapter.dispose();
  });
});

