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
  | 'busy';

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


/**
 * One GATT link to one Companion. Transport only: it moves frames and reports
 * link loss; it knows nothing about commands, sends or outcomes.
 */
export interface BleTransport {
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
   * Writes exactly one protocol frame as exactly one GATT write. The protocol
   * defines one frame per write, so a frame is never split across writes.
   * Rejects not_connected or write_failed. A rejection does not prove the device
   * did not receive the frame.
   */
  write(frame: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
  /** One call per notification, in order; the array is a private copy. */
  onFrame(cb: (frame: Uint8Array) => void): Unsubscribe;
  /** Link loss, whether initiated by the device, the OS, the browser or disconnect(). */
  onDisconnect(cb: () => void): Unsubscribe;
  /** Optional: reports connect sub-steps as they complete (used by the probe page). */
  onPhase?(cb: (phase: BlePhase) => void): Unsubscribe;
}
