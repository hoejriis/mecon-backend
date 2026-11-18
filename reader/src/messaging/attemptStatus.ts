import type { SendAttempt, SendRequest } from '../api/types';

/** Where a send went. `backend` is the Reader API; `ble` and `usb` are a locally attached device. */
export type SendPath = 'backend' | 'ble' | 'usb';
export type LocalPath = 'ble' | 'usb';
export const PATH_LABEL: Record<SendPath, string> = { backend: 'Backend', ble: 'Bluetooth', usb: 'USB' };
export const isLocalPath = (p: SendPath | undefined): p is LocalPath => p === 'ble' || p === 'usb';

/** What a local send is addressed to on the device: a contact's public key (hex), or a channel slot. */
export interface LocalTarget {
  contactKey?: string;
  channelIndex?: number;
}

/**
 * The device's own observations for a local attempt, copied from the adapter's facts. Each is
 * separate evidence and none implies another; `false` means "not observed".
 */
export interface LocalFacts {
  writeIssued: boolean;
  notSent: boolean;
  deviceAccepted: boolean;
  rfTransmitted: boolean;
  dmAck: boolean;
  ackTimedOut: boolean;
  unknown: boolean;
  deviceError: { code: number | null; name: string } | null;
  reason: string | null;
}

/**
 * Where a send stands from the Reader's point of view.
 * - posting: POST in flight
 * - ambiguous: the POST got no usable answer; the attempt may or may not
 *   exist or have been transmitted (local `unknown`)
 * - rejected: the Backend refused the request (4xx); nothing was accepted
 * - accepted: the Backend returned an attempt; `attempt.status` rules
 * - local: a local device accepted the write (local attempts only; `local` holds its facts)
 */
export type AttemptPhase = 'posting' | 'ambiguous' | 'rejected' | 'accepted' | 'local';

export interface RejectInfo {
  status: number;
  code: string;
  message: string;
  requestId: string | null;
  /** 409: the Idempotency-Key was reused with a different body. A Reader bug. */
  keyConflict: boolean;
}

export interface LocalAttempt {
  clientAttemptId: string;
  draftId: string;
  request: SendRequest;
  phase: AttemptPhase;
  attempt: SendAttempt | null;
  error: RejectInfo | null;
  /** Set once the user sent this draft again as a new attempt. */
  supersededBy: string | null;
  createdAt: number;
  /** Which path this attempt used. Absent on records cached before local sends existed: the Backend. Never changes. */
  path?: SendPath;
  /** Local attempts only: what the device was asked to reach. */
  localTarget?: LocalTarget;
  /** Local attempts only: the device's facts. Phases: posting = write in flight, ambiguous = unknown, rejected = not sent, local = accepted by the device. */
  local?: LocalFacts | null;
}

export const pathOf = (a: Pick<LocalAttempt, 'path'>): SendPath => a.path ?? 'backend';

export type Tone = 'pending' | 'ok' | 'warn' | 'bad' | 'unknown';

export interface StatusView {
  label: string;
  detail: string | null;
  tone: Tone;
  /** The user may start a new attempt for the same draft (after confirming). */
  canSendAgain: boolean;
  /** An uncertain outcome: the earlier attempt may already have been transmitted. */
  mayHaveTransmitted: boolean;
  /** The user may re-POST the same attempt to learn its fate. */
  canRecheck: boolean;
  /** Needs no further polling. */
  terminal: boolean;
  /** Local attempts: one line of the device's separate facts. */
  facts?: string;
}

export const AMBIGUOUS_LABEL = 'Outcome unknown — not resent';

const yn = (v: boolean) => (v ? 'yes' : 'not observed');

/** The device's facts as one line. RF transmission is "not observed" unless the device gave evidence. */
function factsLine(f: LocalFacts, kind: 'contact' | 'channel'): string {
  const parts = [`Device accepted: ${yn(f.deviceAccepted)}`, `Radio transmitted: ${yn(f.rfTransmitted)}`];
  if (kind === 'contact') parts.push(`Recipient ACK: ${yn(f.dmAck)}`);
  return parts.join(' · ');
}

const NOT_WRITTEN = 'Nothing was written to the device.';

/** Reasons a local attempt was not sent, in words. */
function localReason(code: string | null): string {
  switch (code) {
    case 'not_connected':
      return 'The device was not connected.';
    default:
      return code ?? 'The device was not reached.';
  }
}

/** A local (Bluetooth or USB) attempt. Never rerouted; never resent without a new user action. */
function describeLocal(a: LocalAttempt, kind: 'contact' | 'channel'): StatusView {
  const base = { canSendAgain: false, mayHaveTransmitted: false, canRecheck: false, terminal: false };
  const via = PATH_LABEL[pathOf(a)];
  const f = a.local ?? null;
  const facts = f ? factsLine(f, kind) : undefined;
  if (a.phase === 'posting') return { ...base, label: `Sending to the device over ${via}…`, detail: null, tone: 'pending', facts };
  if (a.phase === 'ambiguous') {
    return {
      ...base,
      label: AMBIGUOUS_LABEL,
      detail: `The write to the device may or may not have reached it. It was not resent, and not sent through the Backend.`,
      tone: 'unknown',
      canSendAgain: true,
      mayHaveTransmitted: true,
      terminal: true,
      facts,
    };
  }
  if (a.phase === 'rejected') {
    const e = a.error;
    const refused = f?.deviceError;
    return {
      ...base,
      label: refused ? 'Refused by the device' : 'Not sent',
      detail: refused ? `The device refused it (${refused.name}). Nothing was sent.` : `${e?.message ?? localReason(f?.reason ?? null)} ${NOT_WRITTEN}`,
      tone: 'bad',
      canSendAgain: true,
      terminal: true,
      facts,
    };
  }
  // local: the device accepted the write.
  if (!f) return { ...base, label: 'Accepted by the device', detail: null, tone: 'ok' };
  if (kind === 'channel') {
    return { ...base, label: 'Accepted by the device', detail: 'Channels give no delivery confirmation. Radio transmission is not observed.', tone: 'ok', terminal: true, facts };
  }
  if (f.dmAck) {
    return {
      ...base,
      label: 'Acknowledged by the recipient device',
      detail: 'The recipient device acknowledged it. This does not mean it was read.',
      tone: 'ok',
      terminal: true,
      facts,
    };
  }
  if (f.ackTimedOut) {
    return {
      ...base,
      label: 'Accepted by the device — no acknowledgement yet',
      detail: 'The wait for the recipient’s acknowledgement passed. That is not proof it was not delivered.',
      tone: 'warn',
      canSendAgain: true,
      mayHaveTransmitted: true,
      terminal: true,
      facts,
    };
  }
  return { ...base, label: 'Accepted by the device', detail: 'Waiting for the recipient device to acknowledge. Radio transmission is not observed.', tone: 'ok', facts };
}

export function describeAttempt(a: LocalAttempt, targetKind: 'contact' | 'channel'): StatusView {
  if (pathOf(a) !== 'backend') return describeLocal(a, targetKind);
  const base = { canSendAgain: false, mayHaveTransmitted: false, canRecheck: false, terminal: false };
  if (a.phase === 'posting') {
    return { ...base, label: 'Sending…', detail: null, tone: 'pending' };
  }
  if (a.phase === 'ambiguous') {
    return {
      ...base,
      label: AMBIGUOUS_LABEL,
      detail: 'The Reader got no answer. The message may or may not have been sent.',
      tone: 'unknown',
      canSendAgain: true,
      mayHaveTransmitted: true,
      canRecheck: true,
      terminal: true,
    };
  }
  if (a.phase === 'rejected') {
    const e = a.error;
    return {
      ...base,
      label: e?.keyConflict ? 'Not sent — internal error' : 'Not sent',
      detail: e ? e.message : null,
      tone: 'bad',
      canSendAgain: !e?.keyConflict && e?.status !== 401,
      terminal: true,
    };
  }
  const s = a.attempt!;
  const ev = s.status_evidence;
  const detail = ev.detail ?? null;
  const unsupported = ev.source === 'unsupported';
  switch (s.status) {
    case 'queued':
      return { ...base, label: 'Queued', detail, tone: 'pending' };
    case 'duty_held':
      return { ...base, label: 'Held for the duty-cycle limit', detail, tone: 'warn' };
    case 'transmitted':
      return {
        ...base,
        label: 'Transmitted',
        detail:
          targetKind === 'channel'
            ? 'Channels give no delivery confirmation.'
            : (detail ?? 'Waiting for the recipient device to acknowledge.'),
        tone: 'ok',
        terminal: targetKind === 'channel',
      };
    case 'acked':
      // The contract never emits acked for a channel (no per-recipient ack).
      // If one arrives anyway, claim only what channels can claim: transmitted.
      if (targetKind === 'channel') {
        return {
          ...base,
          label: 'Transmitted',
          detail: 'Channels give no delivery confirmation.',
          tone: 'ok',
          terminal: true,
        };
      }
      // A native acknowledgement from the recipient device. Never a read receipt.
      return {
        ...base,
        label: 'Delivered to device (acknowledged)',
        detail: detail ?? 'The recipient device acknowledged it. This does not mean it was read.',
        tone: 'ok',
        terminal: true,
      };
    case 'failed':
      return {
        ...base,
        label: 'Failed',
        detail,
        tone: 'bad',
        canSendAgain: true,
        mayHaveTransmitted: !unsupported,
        terminal: true,
      };
    case 'timed_out':
    case 'unknown':
      if (unsupported) {
        // The contract says an origin that cannot report device status never
        // yields these. If one arrives anyway, claim nothing beyond it.
        return {
          ...base,
          label: 'Status not reported',
          detail: 'This origin cannot report device-level status.',
          tone: 'unknown',
          terminal: true,
        };
      }
      return s.status === 'unknown'
        ? {
            ...base,
            label: AMBIGUOUS_LABEL,
            detail: detail ?? 'The device did not report an outcome.',
            tone: 'unknown',
            canSendAgain: true,
            mayHaveTransmitted: true,
            terminal: true,
          }
        : {
            ...base,
            label: 'Timed out — may still have been sent',
            detail,
            tone: 'warn',
            canSendAgain: true,
            mayHaveTransmitted: true,
            terminal: true,
          };
  }
}

/**
 * An attempt whose outcome a reload would leave the user unable to follow:
 * still in flight, or ended without a known outcome (ambiguous, unknown or
 * timed out). A superseded attempt was already replaced by a new user action.
 * Such attempts keep their server-side identity; the Reader never resends them.
 */
export function isUncertainAttempt(a: LocalAttempt): boolean {
  if (a.supersededBy) return false;
  if (a.phase === 'posting' || a.phase === 'ambiguous') return true;
  if (pathOf(a) !== 'backend') return a.phase === 'local' && !describeAttempt(a, a.request.target.kind).terminal;
  if (a.phase === 'rejected') return false;
  const s = a.attempt;
  if (!s) return true;
  if (s.status === 'unknown' || s.status === 'timed_out') return s.status_evidence.source !== 'unsupported';
  return !describeAttempt(a, a.request.target.kind).terminal;
}
