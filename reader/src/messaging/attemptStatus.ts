import type { SendAttempt, SendRequest } from '../api/types';

/**
 * Where a send stands from the Reader's point of view.
 * - posting: POST in flight
 * - ambiguous: the POST got no usable answer; the attempt may or may not
 *   exist or have been transmitted (local `unknown`)
 * - rejected: the Backend refused the request (4xx); nothing was accepted
 * - accepted: the Backend returned an attempt; `attempt.status` rules
 */
export type AttemptPhase = 'posting' | 'ambiguous' | 'rejected' | 'accepted';

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
}

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
}

export const AMBIGUOUS_LABEL = 'Outcome unknown — not resent';

export function describeAttempt(a: LocalAttempt, targetKind: 'contact' | 'channel'): StatusView {
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
