import { RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID } from './protocol';

export { RX_CHAR_UUID, SERVICE_UUID, TX_CHAR_UUID };

export type BleErrorCode =
  | 'unsupported'
  | 'gesture_required'
  | 'permission_denied'
  | 'chooser_cancelled'
  | 'connect_timeout'
  | 'connect_failed'
  | 'not_connected'
  | 'write_failed'
  | 'disconnected'
  | 'response_timeout'
  | 'device_error'
  | 'attempt_reused'
  | 'text_too_long'
  | 'frame_too_large'
  | 'bad_argument'
  | 'link_desynced'
  | 'busy'
  /** USB: the chosen port is already open elsewhere (another tab, a serial monitor, a flasher). */
  | 'port_busy'
  /** USB: the port went away (cable pulled, board reset into its bootloader, permission revoked). */
  | 'port_lost'
  /** The detected device does not support this operation (capabilities gate features, not roles). */
  | 'unsupported_capability'
  /** The link's trust does not allow this class of operation (a BLE link of unknown PIN: reads only). */
  | 'link_not_trusted'
  /** The connected device is not the one the sending identity belongs to (its own public key does not match). */
  | 'wrong_device'
  /** The destination (contact key or channel slot) was not chosen by the matcher for this exact Backend target, or no longer matches the device. Nothing was written. */
  | 'unmapped_destination';

export class BleError extends Error {
  constructor(
    readonly code: BleErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BleError';
  }
}

export type TransportSupport = 'supported' | 'unsupported';

export interface BleDeviceInfo {
  /** Opaque browser-assigned id; not a MAC address. */
  id: string;
  name: string | null;
}

export type Unsubscribe = () => void;

/** Connect sub-steps a transport may report, for diagnostics only. */
export type BlePhase = 'gatt_connected' | 'service_found' | 'characteristics_found' | 'notifications_started';


export type TransportKind = 'ble' | 'usb';

/** Why a link ended, when the transport can tell. `port_lost` is the USB `disconnect` event. */
export type DisconnectReason = 'port_lost' | 'closed' | 'error';

/**
 * One link to one Companion, over BLE (GATT) or USB (Web Serial). Transport
 * only: it moves whole protocol frames and reports link loss; it knows nothing
 * about commands, sends or outcomes. The USB transport adds and strips the
 * serial wrapper itself, so the adapter sees the same frames on both.
 *
 * `requestDevice` and `connect` keep their BLE-era names: for USB, requestDevice
 * is the port chooser and connect opens the chosen port.
 */
export interface CompanionTransport {
  readonly kind: TransportKind;
  readonly support: TransportSupport;
  /**
   * Shows the browser's device chooser. MUST be called synchronously from a user
   * gesture (the first thing a click handler does). Rejects with a BleError:
   * gesture_required, permission_denied, chooser_cancelled, unsupported.
   */
  requestDevice(): Promise<BleDeviceInfo>;
  /**
   * Connects GATT to the device chosen by requestDevice, discovers the service
   * and characteristics and starts notifications. May be called again after a
   * disconnect to reconnect without a chooser. Rejects connect_failed.
   */
  connect(): Promise<void>;
  /**
   * Writes exactly one protocol frame (BLE: as exactly one GATT write; USB: wrapped
   * in one serial frame, handed to the port in one write). The protocol
   * defines one frame per write, so a frame is never split across writes.
   * Rejects not_connected or write_failed. A rejection does not prove the device
   * did not receive the frame.
   */
  write(frame: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
  /** One call per notification, in order; the array is a private copy. */
  onFrame(cb: (frame: Uint8Array) => void): Unsubscribe;
  /** Link loss, whether initiated by the device, the OS, the browser or disconnect(). */
  onDisconnect(cb: (reason?: DisconnectReason) => void): Unsubscribe;
  /** Optional: reports connect sub-steps as they complete (used by the probe page). */
  onPhase?(cb: (phase: BlePhase) => void): Unsubscribe;
}

/** The BLE-era name, kept so existing imports and tests do not change. */
export type BleTransport = CompanionTransport;
/** The role-agnostic name for the same seam. */
export type DeviceTransport = CompanionTransport;
