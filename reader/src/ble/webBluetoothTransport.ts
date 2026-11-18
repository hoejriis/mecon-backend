import { BleError, type BleDeviceInfo, type BleTransport, type TransportSupport, type Unsubscribe } from './transport';
import { MAX_FRAME_SIZE, RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from './protocol';

// Minimal structural types: TypeScript's DOM lib has no Web Bluetooth types.
export interface WbCharacteristic extends EventTarget {
  value?: DataView | null;
  startNotifications(): Promise<WbCharacteristic>;
  stopNotifications?(): Promise<WbCharacteristic>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
}
export interface WbService {
  getCharacteristic(uuid: string): Promise<WbCharacteristic>;
}
export interface WbGatt {
  connected: boolean;
  connect(): Promise<WbGatt>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WbService>;
}
export interface WbDevice extends EventTarget {
  id: string;
  name?: string | null;
  gatt?: WbGatt | null;
}
export interface WbBluetooth {
  requestDevice(options: unknown): Promise<WbDevice>;
}

export function getBluetooth(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): WbBluetooth | null {
  const b = (nav as { bluetooth?: WbBluetooth } | undefined)?.bluetooth;
  return b && typeof b.requestDevice === 'function' ? b : null;
}

export function detectSupport(nav?: unknown): TransportSupport {
  return getBluetooth(nav) ? 'supported' : 'unsupported';
}

interface Activation {
  isActive: boolean;
}

/**
 * Web Bluetooth implementation of BleTransport (Chrome on Android is the primary
 * target). Not hardware verified: see the simulation matrix.
 *
 * Writes: the protocol defines one frame per GATT write, so frames are never
 * chunked. A frame larger than MAX_FRAME_SIZE is refused. UNVERIFIED on real
 * hardware: that Chrome/Android accept a ~170-byte write-with-response at the
 * negotiated MTU (Web Bluetooth permits up to 512 bytes and the stack uses long
 * writes where needed).
 */
export class WebBluetoothTransport implements BleTransport {
  readonly support: TransportSupport;
  private readonly bt: WbBluetooth | null;
  private readonly nav: unknown;
  private device: WbDevice | null = null;
  private rx: WbCharacteristic | null = null;
  private tx: WbCharacteristic | null = null;
  private frameCbs = new Set<(f: Uint8Array) => void>();
  private discCbs = new Set<() => void>();

  constructor(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator) {
    this.nav = nav;
    this.bt = getBluetooth(nav);
    this.support = this.bt ? 'supported' : 'unsupported';
  }

  async requestDevice(): Promise<BleDeviceInfo> {
    if (!this.bt) throw new BleError('unsupported', 'navigator.bluetooth is not available');
    const act = (this.nav as { userActivation?: Activation } | undefined)?.userActivation;
    // Where the browser exposes it, refuse early rather than relying on the chooser's own error.
    if (act && !act.isActive) throw new BleError('gesture_required', 'requestDevice must be called from a user gesture');
    let dev: WbDevice;
    try {
      dev = await this.bt.requestDevice({ filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] });
    } catch (e) {
      throw mapRequestError(e);
    }
    this.detach();
    this.device = dev;
    dev.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    return { id: dev.id, name: dev.name ?? null };
  }

  async connect(): Promise<void> {
    const dev = this.device;
    if (!dev || !dev.gatt) throw new BleError('connect_failed', 'no device selected');
    try {
      const server = await dev.gatt.connect();
      const svc = await server.getPrimaryService(SERVICE_UUID);
      this.rx = await svc.getCharacteristic(RX_CHAR_UUID);
      const tx = await svc.getCharacteristic(TX_CHAR_UUID);
      this.tx?.removeEventListener('characteristicvaluechanged', this.onValue);
      this.tx = tx;
      tx.addEventListener('characteristicvaluechanged', this.onValue);
      await tx.startNotifications();
    } catch (e) {
      try {
        dev.gatt.disconnect();
      } catch {
        /* ignore */
      }
      throw new BleError('connect_failed', e instanceof Error ? e.message : 'connect failed');
    }
  }

  async write(frame: Uint8Array): Promise<void> {
    if (frame.length === 0 || frame.length > MAX_FRAME_SIZE) throw new BleError('frame_too_large');
    const rx = this.rx;
    if (!rx || !this.device?.gatt?.connected) throw new BleError('not_connected');
    const copy = frame.slice();
    try {
      if (rx.writeValueWithResponse) await rx.writeValueWithResponse(copy);
      else if (rx.writeValue) await rx.writeValue(copy);
      else throw new Error('no write method');
    } catch (e) {
      throw new BleError('write_failed', e instanceof Error ? e.message : 'write failed');
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* already gone */
    }
  }

  onFrame(cb: (frame: Uint8Array) => void): Unsubscribe {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }

  onDisconnect(cb: () => void): Unsubscribe {
    this.discCbs.add(cb);
    return () => this.discCbs.delete(cb);
  }

  private detach(): void {
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.tx?.removeEventListener('characteristicvaluechanged', this.onValue);
    this.device = null;
    this.rx = null;
    this.tx = null;
  }

  private onValue = (ev: Event): void => {
    const v = (ev.target as WbCharacteristic | null)?.value;
    if (!v) return;
    const copy = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    for (const cb of [...this.frameCbs]) cb(copy.slice());
  };

  private onGattDisconnected = (): void => {
    this.rx = null;
    for (const cb of [...this.discCbs]) cb();
  };
}

export function mapRequestError(e: unknown): BleError {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'NotFoundError') return new BleError('chooser_cancelled', msg); // user closed the chooser, or no device matched
  if (name === 'SecurityError' && /gesture/i.test(msg)) return new BleError('gesture_required', msg);
  if (name === 'NotAllowedError' || name === 'SecurityError') return new BleError('permission_denied', msg);
  if (name === 'NotSupportedError') return new BleError('unsupported', msg);
  return new BleError('connect_failed', msg);
}
