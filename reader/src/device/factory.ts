import { WebBluetoothTransport } from '../ble/webBluetoothTransport';
import type { LocalPath } from '../messaging/attemptStatus';
import { DeviceSession, type SessionOptions } from './session';
import { WebSerialTransport } from './webSerialTransport';

/**
 * Builds the device session for a path. This module, the transports and the session are one lazy
 * chunk: the main bundle never carries Bluetooth or serial code, and the chunk is fetched only
 * when the user asks to connect a device (DeviceContext).
 */
export function createDeviceSession(path: LocalPath, opts: SessionOptions = {}): DeviceSession {
  return new DeviceSession(path === 'usb' ? new WebSerialTransport() : new WebBluetoothTransport(), opts);
}
