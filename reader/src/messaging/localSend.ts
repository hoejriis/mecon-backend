/**
 * One local (Bluetooth or USB) send, from the user's tap to the device's facts.
 *
 * Shared by the online composer (MessagingContext) and the offline screen, which have no common
 * parent. The rules, all inherited from the adapter and the device session:
 *  - the guard runs twice and both are real: `preflightLocal` (so the user is told why, and the
 *    draft is kept) and again inside `DeviceSession.sendDirect/sendChannel` (so no caller can skip
 *    it). Online: the server decides, the lease is not required. Offline: the lease must permit
 *    this operation, identity, device and channel. A refusal writes nothing.
 *  - an attempt is written at most once. An uncertain outcome becomes `ambiguous` (unknown) and is
 *    never resent, never rerouted to the Backend. A new attempt is a new user action.
 *  - facts are the device's own, separately: accepted, RF transmitted (only on evidence), recipient ACK.
 */
import type { Identity, Target } from '../api/types';
import { OfflineSendBlocked, offlineSendGuard } from '../offline/gate';
import { isLocalPath, type LocalAttempt, type LocalFacts, type LocalPath, type LocalTarget } from './attemptStatus';
import { CHANNEL_LOCAL_UNAVAILABLE, deviceView, leaseOp, ownsIdentity, sendCapability, type AttemptFacts, type LocalDeviceHandle, type LocalSendAuth } from './localPath';

export type Preflight = { ok: true; auth: LocalSendAuth } | { ok: false; reason: string };

export function authFor(identity: Identity, target: Target): LocalSendAuth {
  return {
    op: leaseOp(target.kind),
    identityId: identity.id,
    deviceId: identity.device_id ?? '',
    ...(target.kind === 'channel' ? { channelId: target.id } : {}),
    identityKeyPrefix: identity.public_key_prefix,
  };
}

/** Everything that can be decided without writing: device, capability, identity, destination, guard. */
export function preflightLocal(handle: LocalDeviceHandle | null, identity: Identity | null, target: Target, to: LocalTarget): Preflight {
  if (target.kind === 'channel') return { ok: false, reason: CHANNEL_LOCAL_UNAVAILABLE };
  if (!identity) return { ok: false, reason: 'No sending identity is selected.' };
  if (!handle) return { ok: false, reason: 'No device is connected.' };
  const view = deviceView(handle);
  if (!view.connected) return { ok: false, reason: 'The device is not connected.' };
  if (!view.capabilities.includes(sendCapability(target.kind))) {
    return { ok: false, reason: `This device cannot send ${target.kind === 'contact' ? 'direct' : 'channel'} messages.` };
  }
  if (!ownsIdentity(view, identity)) return { ok: false, reason: 'The connected device is not the one this identity belongs to.' };
  if (target.kind === 'contact' && !to.contactKey) return { ok: false, reason: 'Choose which device contact to send to.' };
  const auth = authFor(identity, target);
  const d = offlineSendGuard(auth);
  if (!d.allowed) return { ok: false, reason: d.reason };
  return { ok: true, auth };
}

const toFacts = (f: AttemptFacts): LocalFacts => ({
  writeIssued: f.writeIssued,
  notSent: f.notSent,
  deviceAccepted: f.deviceAccepted,
  rfTransmitted: f.rfTransmitted,
  dmAck: f.dmAck,
  ackTimedOut: f.ackTimedOut,
  unknown: f.unknown,
  deviceError: f.deviceError,
  reason: f.reason,
});

/** The attempt's fields that follow from the device's facts. */
export function patchFromFacts(f: AttemptFacts): Partial<LocalAttempt> {
  const local = toFacts(f);
  if (f.notSent) return { phase: 'rejected', local, error: { status: 0, code: 'local_not_sent', message: f.reason === 'not_connected' ? 'The device was not connected.' : (f.reason ?? 'The device was not reached.'), requestId: null, keyConflict: false } };
  if (f.deviceError) return { phase: 'rejected', local, error: { status: 0, code: 'device_error', message: `The device refused it (${f.deviceError.name}).`, requestId: null, keyConflict: false } };
  if (f.unknown) return { phase: 'ambiguous', local, error: null };
  if (f.deviceAccepted) return { phase: 'local', local, error: null };
  return { phase: 'posting', local, error: null };
}

const isFinal = (f: AttemptFacts): boolean => f.notSent || !!f.deviceError || f.unknown || (f.deviceAccepted && (f.kind === 'channel' || f.dmAck || f.ackTimedOut));

/**
 * The device layer's own error (BleError). Recognised by shape, not by class: importing the class
 * would pull the Bluetooth protocol module into the main bundle, which stays device-free.
 */
const deviceError = (e: unknown): (Error & { code: string }) | null =>
  e instanceof Error && e.name === 'BleError' && typeof (e as { code?: unknown }).code === 'string' ? (e as Error & { code: string }) : null;

/** A throw means nothing was written (the guard, the identity, a capability or a bad argument). */
function refusal(e: unknown): Partial<LocalAttempt> {
  const de = deviceError(e);
  const message =
    e instanceof OfflineSendBlocked ? e.decision.reason : de ? (de.message && de.message !== de.code ? de.message : `The device layer refused it (${de.code}).`) : 'The send could not be made.';
  const code = e instanceof OfflineSendBlocked ? 'offline_blocked' : de ? de.code : 'unknown';
  return { phase: 'rejected', error: { status: 0, code, message, requestId: null, keyConflict: false } };
}

/**
 * Writes the attempt to the device once and follows its facts until they are final. `a` must be a
 * fresh local attempt (phase `posting`). Resolves after the first outcome; the recipient ACK or
 * its timeout arrive later through `onUpdate`. Never retries and never falls back to anything.
 */
export async function runLocalSend(handle: LocalDeviceHandle, a: LocalAttempt, identity: Identity, onUpdate: (patch: Partial<LocalAttempt>) => void): Promise<void> {
  const path: LocalPath | undefined = isLocalPath(a.path) ? a.path : undefined;
  if (!path || handle.path !== path) return onUpdate({ phase: 'rejected', error: { status: 0, code: 'bad_argument', message: 'The device does not match the chosen path.', requestId: null, keyConflict: false } });
  const { target } = a.request;
  const auth = authFor(identity, target);
  const ids = { clientDraftId: a.draftId, clientAttemptId: a.clientAttemptId };
  const follow = (): AttemptFacts | undefined => handle.getSnapshot().companion?.attempts.find((x) => x.clientAttemptId === a.clientAttemptId);
  let off: (() => void) | null = null;
  off = handle.subscribe(() => {
    const f = follow();
    if (!f) return;
    onUpdate(patchFromFacts(f));
    if (isFinal(f)) off?.();
  });
  try {
    const to = a.localTarget ?? {};
    // No UI feeds a channel slot: a channel target never reaches the device from here.
    if (target.kind !== 'contact') return onUpdate({ phase: 'rejected', error: { status: 0, code: 'channel_unavailable', message: CHANNEL_LOCAL_UNAVAILABLE, requestId: null, keyConflict: false } });
    const facts = await handle.sendDirect({ ...ids, contactKey: to.contactKey ?? '', text: a.request.content.text, auth });
    onUpdate(patchFromFacts(facts));
    // The adapter keeps updating its own copy (the ACK, its timeout); follow it until it is final.
    const latest = follow() ?? facts;
    onUpdate(patchFromFacts(latest));
    if (isFinal(latest)) off();
  } catch (e) {
    off();
    onUpdate(refusal(e));
  }
}
