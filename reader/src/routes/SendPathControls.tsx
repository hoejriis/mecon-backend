import { useState } from 'react';
import type { Identity, Target } from '../api/types';
import { useDevices } from '../device/DeviceContext';
import type { BackendDest, MapOutcome } from '../device/destinations';
import { PATH_LABEL, pathOf, type LocalAttempt, type LocalTarget, type SendPath } from '../messaging/attemptStatus';
import { destFor, type Directory } from '../messaging/directory';
import { availablePaths, defaultPath, deviceView, localUnavailable, type LocalDeviceHandle } from '../messaging/localPath';
import { preflightLocal } from '../messaging/localSend';
import type { SendRoute } from '../messaging/MessagingContext';

export interface SendPathState {
  /** Paths that can carry this send. Only these are shown. */
  avail: SendPath[];
  /** The user's choice, or the default (Backend when online, else local). Null when the chosen path is gone. */
  path: SendPath | null;
  /** The user picked a path that is no longer available; nothing replaces it for them. */
  pickedGone: SendPath | null;
  setPath(p: SendPath): void;
  to: LocalTarget;
  /** Chooses among device contacts that already match the Backend contact's key prefix. Never names a contact by itself. */
  setContactKey(k: string): void;
  handle: LocalDeviceHandle | null;
  /** The Backend side of this send, for the device mapping (also passed to the send itself). */
  dest: BackendDest;
  /** What the device mapping says about the chosen local path's device; null when the path is the Backend or none. */
  mapping: MapOutcome | null;
  /** Connected, own devices that cannot carry this send because the target is not (uniquely) on them, with the reason. */
  unavailable: Array<{ path: 'ble' | 'usb'; reason: string }>;
  /** The route to hand to send(); null while no usable path is chosen. */
  route: SendRoute | null;
  /** Why a local send cannot start now (the guard's or the device's truthful reason), or null. */
  blocked: string | null;
}

/**
 * The send path of ONE send. The default is Backend when online and offered, else the first local
 * path; after that only the user changes it. A path that disappears is not replaced: the chooser
 * says so and the send stays disabled until the user chooses again.
 */
export function useSendPath(i: {
  identity: Identity | null;
  target: Target;
  online: boolean;
  sendState: 'available' | 'unavailable' | 'forbidden';
  /** What the Reader holds about Backend contacts, channels and conversations (live online, cached offline). */
  directory: Directory;
  initial?: { path: SendPath; to?: LocalTarget };
}): SendPathState {
  const devices = useDevices();
  const [picked, setPicked] = useState<SendPath | null>(i.initial?.path ?? null);
  const [contactKey, setContactKey] = useState(i.initial?.to?.contactKey ?? '');
  const dest = destFor(i.directory, i.target, i.identity);
  const views = Object.values(devices.handles).map((h) => deviceView(h, dest, contactKey || undefined));
  const input = { sendState: i.sendState, online: i.online, devices: views, target: i.target, identity: i.identity };
  const avail = availablePaths(input);
  const wanted = picked ?? defaultPath(avail, i.online);
  const path = wanted && avail.includes(wanted) ? wanted : null;
  const handle = path && path !== 'backend' ? (devices.handles[path] ?? null) : null;
  const to: LocalTarget = { contactKey: contactKey || undefined };
  let route: SendRoute | null = null;
  let blocked: string | null = null;
  if (path === 'backend') route = { path: 'backend' };
  else if (path) {
    route = { path, to };
    const pre = preflightLocal(handle, i.identity, i.target, to, dest);
    if (!pre.ok) blocked = pre.reason;
  }
  return {
    avail,
    path,
    pickedGone: picked && !path ? picked : null,
    setPath: setPicked,
    to,
    setContactKey,
    handle,
    dest,
    mapping: path && path !== 'backend' ? (views.find((v) => v.path === path)?.destination ?? null) : null,
    unavailable: localUnavailable(input),
    route,
    blocked,
  };
}

/** The visible, per-send path choice, the device connectors and the destination on the device. */
export function SendPathControls({ s, target, idPrefix }: { s: SendPathState; target: Target; idPrefix: string }) {
  const devices = useDevices();
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const local = s.path && s.path !== 'backend';
  const m = s.mapping;
  return (
    <div className="send-path" data-testid="send-path">
      {s.avail.length > 1 || (s.avail.length > 0 && s.pickedGone) ? (
        <fieldset className="path-choice">
          <legend>Send through</legend>
          {s.avail.map((p) => (
            <label key={p} className="path-option">
              <input type="radio" name={`${idPrefix}-path`} value={p} checked={s.path === p} onChange={() => s.setPath(p)} />
              {PATH_LABEL[p]}
            </label>
          ))}
        </fieldset>
      ) : s.avail.length === 1 ? (
        <p className="state-meta">
          Sent through the {PATH_LABEL[s.avail[0]!]}. Each tap of Send is one attempt.
        </p>
      ) : (
        <p className="state-meta" role="status">
          No send path is available. Connect your device, or wait until the Backend can send.
        </p>
      )}
      {s.pickedGone && (
        <p className="state-meta" role="status" data-testid="path-gone">
          {PATH_LABEL[s.pickedGone]} is no longer available. Choose a path to send; nothing is sent another way for you.
        </p>
      )}
      {local && m?.ok && (
        <p className="state-meta" data-testid="device-destination">
          {m.destination.kind === 'direct'
            ? `Device contact: ${m.destination.name} (${m.destination.contactKey.slice(0, 6)}), found by the contact's key prefix.`
            : `Device channel: ${m.destination.name}, found on your device.`}
        </p>
      )}
      {local && target.kind === 'contact' && m && !m.ok && m.code === 'ambiguous' && (
        <label className="composer-field">
          Device contact
          <select value={s.to.contactKey ?? ''} onChange={(e) => s.setContactKey(e.target.value)}>
            <option value="">{m.reason}</option>
            {m.candidates.map((c) => (
              <option key={c.publicKey} value={c.publicKey}>
                {c.name} ({c.publicKey.slice(0, 12)})
              </option>
            ))}
          </select>
        </label>
      )}
      {s.unavailable.map((u) => (
        <p key={u.path} className="state-meta" data-testid={`local-unavailable-${u.path}`}>
          Not offered through {PATH_LABEL[u.path]}: {u.reason}
        </p>
      ))}
      {local && s.blocked && (
        <p className="state-meta" role="alert" data-testid="local-blocked">
          Not allowed: {s.blocked}
        </p>
      )}
      <div className="device-row">
        {(['ble', 'usb'] as const).map((p) => {
          const h = devices.handles[p];
          const snap = h?.getSnapshot();
          const up = snap?.link === 'connected' && snap.phase === 'ready';
          if (!devices.hasApi(p) && !h) return null;
          return (
            <span key={p} className="device-chip" data-testid={`device-${p}`}>
              {up ? `${PATH_LABEL[p]} device connected` : `${PATH_LABEL[p]} device not connected`}{' '}
              {up ? (
                <button type="button" className="btn btn-small btn-secondary" onClick={() => void devices.disconnect(p)}>
                  Disconnect {PATH_LABEL[p]}
                </button>
              ) : (
                <button type="button" className="btn btn-small btn-secondary" onClick={() => void devices.connect(p).then(setConnectMsg)}>
                  Connect {PATH_LABEL[p]} device
                </button>
              )}
            </span>
          );
        })}
      </div>
      {connectMsg && (
        <p className="state-meta" role="status">
          {connectMsg}
        </p>
      )}
    </div>
  );
}

/** Whether the attempt used a local path (for labels). */
export const viaLabel = (a: Pick<LocalAttempt, 'path'>): string => PATH_LABEL[pathOf(a)];
