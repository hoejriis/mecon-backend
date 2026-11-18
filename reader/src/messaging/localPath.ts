/**
 * Send paths: which of Backend, Bluetooth and USB a message can go through right now.
 *
 * Pure decisions, no I/O. Only type imports from the device layer, so the main bundle carries
 * no Bluetooth or serial code (the device layer is a lazy chunk, device/factory.ts).
 *
 * A path is offered only when it can actually carry this send:
 *  - Backend: the session's `send` capability is available and the Reader is online.
 *  - Bluetooth / USB: a DeviceSession is connected and ready, its detected capabilities include
 *    the send operation for the target kind, and the device is the sending identity's own
 *    (its public key starts with the identity's `public_key_prefix`).
 * Whether the offline rules permit a local send is a separate, later decision (the guard); a path
 * the guard blocks is still offered, with the reason, so the user is told why.
 *
 * Nothing here ever changes a path after a send. The caller passes the user's explicit choice.
 */
import type { Identity, Target } from '../api/types';
import type { AttemptFacts } from '../ble/adapter';
import type { Capability } from '../device/detect';
import type { DeviceSession, LocalSendAuth, SessionResult, SessionSnapshot } from '../device/session';
import { PATH_LABEL, type LocalPath, type SendPath } from './attemptStatus';

export { PATH_LABEL };
export type { LocalPath, SendPath };

/** The slice of a DeviceSession the messaging layer uses. A DeviceSession satisfies it. */
export type LocalDeviceHandle = Pick<DeviceSession, 'path' | 'subscribe' | 'getSnapshot' | 'can' | 'sendDirect' | 'sendChannel' | 'connect' | 'reconnect' | 'disconnect'>;
export type { AttemptFacts, LocalSendAuth, SessionResult, SessionSnapshot };

/** Why a channel target has no local path. Shown as is. */
export const CHANNEL_LOCAL_UNAVAILABLE = "Sending to a channel through a device needs the device's channel list (coming soon)";

export const sendCapability = (kind: Target['kind']): Capability => (kind === 'contact' ? 'message.send.direct' : 'message.send.channel');

/** What the path decision needs to know about one device. */
export interface DeviceView {
  path: LocalPath;
  /** The link is up and the device finished identifying itself. */
  connected: boolean;
  /** Capabilities the device can use right now (detected, and its messaging driver is up). */
  capabilities: readonly Capability[];
  /** The device's own public key (hex), from its self-info; null until known. */
  ownKey: string | null;
}

const SEND_CAPS: readonly Capability[] = ['message.send.direct', 'message.send.channel'];

export function deviceView(h: LocalDeviceHandle): DeviceView {
  const s = h.getSnapshot();
  const connected = s.link === 'connected' && s.phase === 'ready';
  return {
    path: h.path,
    connected,
    capabilities: connected ? [...(s.detected?.capabilities ?? []).filter((c) => !SEND_CAPS.includes(c)), ...SEND_CAPS.filter((c) => h.can(c))] : [],
    ownKey: s.companion?.selfInfo?.publicKey ?? null,
  };
}

/** Whether this device is the one the identity belongs to: its own key starts with the identity's prefix. */
export function ownsIdentity(d: Pick<DeviceView, 'ownKey'>, identity: Pick<Identity, 'public_key_prefix'> | null): boolean {
  if (!identity || !d.ownKey || identity.public_key_prefix === '') return false;
  return d.ownKey.toLowerCase().startsWith(identity.public_key_prefix.toLowerCase());
}

export interface PathInput {
  sendState: 'available' | 'unavailable' | 'forbidden';
  online: boolean;
  devices: readonly DeviceView[];
  target: Target;
  identity: Identity | null;
}

/** The paths that can carry this send, in display order (Backend first). */
export function availablePaths(i: PathInput): SendPath[] {
  const out: SendPath[] = [];
  if (i.sendState === 'available' && i.online) out.push('backend');
  // A local channel send needs the device's channel slot, which the Reader cannot yet learn: not offered.
  if (i.target.kind === 'channel') return out;
  const need = sendCapability(i.target.kind);
  for (const path of ['ble', 'usb'] as const) {
    const d = i.devices.find((x) => x.path === path);
    if (d && d.connected && d.capabilities.includes(need) && ownsIdentity(d, i.identity)) out.push(path);
  }
  return out;
}

/** Online: Backend if offered, else the first local path. Offline: the first local path. Never a silent switch afterwards. */
export function defaultPath(avail: readonly SendPath[], online: boolean): SendPath | null {
  if (online && avail.includes('backend')) return 'backend';
  return avail.find((p) => p !== 'backend') ?? avail[0] ?? null;
}

/** The lease operation for a target kind. */
export const leaseOp = (kind: Target['kind']): 'send.direct' | 'send.channel' => (kind === 'contact' ? 'send.direct' : 'send.channel');
