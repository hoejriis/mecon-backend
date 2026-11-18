import type { BleDeviceInfo, DisconnectReason, TransportSupport, Unsubscribe } from '../ble/transport';

/**
 * A serial port as a raw byte pipe. Role-agnostic: it moves bytes and reports
 * link loss, and knows nothing about Companion frames, CLI lines or interface
 * envelopes. Drivers sit on top of it (see detect.ts and companionSerial.ts).
 */
export interface SerialPortInfo extends BleDeviceInfo {
  /** USB ids reported by the browser, when it reports them. Model-level, not per device. */
  usbVendorId?: number;
  usbProductId?: number;
}

export interface ByteTransport {
  readonly kind: 'usb';
  readonly support: TransportSupport;
  /** The port the user chose, or null. */
  readonly chosen: SerialPortInfo | null;
  isOpen(): boolean;
  /** Port chooser. MUST be called synchronously from a user gesture. */
  requestDevice(): Promise<SerialPortInfo>;
  /** Opens the chosen port (and only that port). Never called by the transport itself after a loss. */
  connect(): Promise<void>;
  /** One call, one write, bounded in size. A rejection does not prove the device saw nothing. */
  writeBytes(bytes: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
  /** Each chunk is a private copy. Chunk boundaries mean nothing. */
  onBytes(cb: (chunk: Uint8Array) => void): Unsubscribe;
  onDisconnect(cb: (reason?: DisconnectReason) => void): Unsubscribe;
}
