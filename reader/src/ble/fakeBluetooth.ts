import { MockCompanion } from './mockCompanion';
import { RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from './protocol';

/**
 * A fake `navigator.bluetooth` (Web Bluetooth shape) backed by a MockCompanion.
 * Used by unit tests (jsdom) and bundled into the Playwright init script.
 * SIMULATED: not Android hardware verified.
 */

function err(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export interface FakeBluetoothHandle {
  mock: MockCompanion;
  /** Android backgrounds the page: visibility becomes hidden and the link drops. */
  simulateBackground(): void;
  simulateForeground(): void;
  /** Number of requestDevice calls that reached the (fake) browser. */
  requestDeviceCalls(): number;
}

export function installFakeBluetooth(target: object, mock: MockCompanion = new MockCompanion()): FakeBluetoothHandle {
  let requests = 0;
  const gestureActive = (): boolean => {
    const ua = (target as { userActivation?: { isActive: boolean } }).userActivation;
    return ua ? ua.isActive : true;
  };

  const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: unknown };
  device.id = 'synthetic-device-1';
  device.name = 'MeshCore-Synthetic';

  const rx = new EventTarget() as EventTarget & Record<string, unknown>;
  const tx = new EventTarget() as EventTarget & Record<string, unknown>;
  let notifying = false;
  let offNotify: (() => void) | null = null;

  const gatt = {
    connected: false,
    async connect() {
      if (mock.faults.connect === 'timeout') return new Promise(() => undefined);
      if (mock.faults.connect === 'fail') throw err('NetworkError', 'GATT Server connection failed');
      mock.linkUp();
      gatt.connected = true;
      return gatt;
    },
    disconnect() {
      if (gatt.connected) mock.dropLink('app_disconnect');
    },
    async getPrimaryService(uuid: string) {
      if (!gatt.connected) throw err('NetworkError', 'GATT Server is disconnected');
      if (uuid.toLowerCase() !== SERVICE_UUID) throw err('NotFoundError', 'Service not found');
      return {
        async getCharacteristic(c: string) {
          const id = c.toLowerCase();
          if (id === RX_CHAR_UUID) return rx;
          if (id === TX_CHAR_UUID) return tx;
          throw err('NotFoundError', 'Characteristic not found');
        },
      };
    },
  };
  device.gatt = gatt;

  mock.onLinkLost(() => {
    gatt.connected = false;
    notifying = false;
    offNotify?.();
    offNotify = null;
    device.dispatchEvent(new Event('gattserverdisconnected'));
  });

  rx.writeValueWithResponse = async (buf: BufferSource) => {
    if (!gatt.connected) throw err('NetworkError', 'GATT Server is disconnected');
    const bytes = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
    if (bytes.length > 512) throw err('NetworkError', 'value too long');
    mock.receive(bytes.slice());
  };

  tx.startNotifications = async () => {
    if (!gatt.connected) throw err('NetworkError', 'GATT Server is disconnected');
    if (notifying) return tx;
    notifying = true;
    offNotify = mock.onNotify((f) => {
      const copy = f.slice();
      Object.defineProperty(tx, 'value', { value: new DataView(copy.buffer), configurable: true });
      tx.dispatchEvent(new Event('characteristicvaluechanged'));
    });
    return tx;
  };

  const bluetooth = {
    async requestDevice(options: { filters?: Array<{ services?: string[] }> }) {
      requests++;
      if (!gestureActive()) throw err('SecurityError', 'Must be handling a user gesture to show a permission request.');
      if (mock.faults.requestDevice === 'denied') throw err('NotAllowedError', 'Bluetooth permission has been blocked.');
      if (mock.faults.requestDevice === 'cancel') throw err('NotFoundError', 'User cancelled the requestDevice() chooser.');
      const wanted = options?.filters?.flatMap((f) => f.services ?? []) ?? [];
      if (wanted.length && !wanted.map((s) => s.toLowerCase()).includes(SERVICE_UUID)) throw err('NotFoundError', 'No devices found.');
      return device;
    },
  };
  Object.defineProperty(target, 'bluetooth', { value: bluetooth, configurable: true });

  const doc = (target as { document?: Document }).document ?? (typeof document === 'undefined' ? undefined : document);
  const setVisibility = (v: 'hidden' | 'visible') => {
    if (!doc) return;
    Object.defineProperty(doc, 'visibilityState', { value: v, configurable: true });
    Object.defineProperty(doc, 'hidden', { value: v === 'hidden', configurable: true });
    doc.dispatchEvent(new Event('visibilitychange'));
  };

  return {
    mock,
    simulateBackground() {
      setVisibility('hidden');
      mock.simulateBackground();
    },
    simulateForeground() {
      setVisibility('visible');
    },
    requestDeviceCalls: () => requests,
  };
}
