import { AmbiguousSendError, ApiError, CapabilityError, type ApiClient } from '../api/client';
import type { SendAttempt, SendRequest } from '../api/types';
import type { RejectInfo } from './attemptStatus';

export type SendOutcome =
  | { phase: 'accepted'; attempt: SendAttempt }
  | { phase: 'ambiguous' }
  | { phase: 'rejected'; error: RejectInfo };

export interface PostOptions {
  /**
   * Delays before each automatic re-POST of the SAME request after an
   * ambiguous failure. The re-POST is idempotent (same Idempotency-Key, same
   * body); it can never create a second attempt. After the last one the
   * outcome stays ambiguous. Empty = no automatic re-POST.
   */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called with `ambiguous` between automatic re-POSTs so the UI shows it. */
  onAmbiguous?: () => void;
}

export const DEFAULT_RETRY_DELAYS_MS = [1500, 4000] as const;

function toReject(e: unknown): RejectInfo {
  if (e instanceof ApiError) {
    return {
      status: e.status,
      code: e.code,
      message:
        e.status === 409
          ? 'The Backend saw this send key with different content. This is a bug in the Reader; nothing was resent.'
          : e.status === 422
            ? e.message || 'The Backend rejected this message.'
            : e.status === 429
              ? 'Too many sends. Wait a moment, then send again.'
              : e.status === 403 && e.code === 'sending_disabled'
                ? 'Sending is switched off on this Backend. Nothing was sent.'
                : e.status === 403
                ? 'You are not permitted to send this message.'
                : e.message,
      requestId: e.requestId,
      keyConflict: e.status === 409,
    };
  }
  if (e instanceof CapabilityError) {
    return { status: 0, code: 'capability', message: 'Sending is not available.', requestId: null, keyConflict: false };
  }
  return { status: 0, code: 'unknown', message: 'The send could not be made.', requestId: null, keyConflict: false };
}

/**
 * POST one attempt exactly as given. Never changes the request: the attempt
 * id (and so the Idempotency-Key) and body are fixed by the caller, which
 * mints a new id only on an explicit user action. A 409 is surfaced and never
 * retried; other definite refusals are final.
 */
export async function postAttempt(
  api: Pick<ApiClient, 'createSendAttempt'>,
  request: SendRequest,
  opts: PostOptions = {},
): Promise<SendOutcome> {
  const delays = opts.retryDelaysMs ?? [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      const { attempt } = await api.createSendAttempt(request);
      return { phase: 'accepted', attempt };
    } catch (e) {
      if (!(e instanceof AmbiguousSendError)) return { phase: 'rejected', error: toReject(e) };
      if (i >= delays.length) return { phase: 'ambiguous' };
      opts.onAmbiguous?.();
      await sleep(delays[i]!);
    }
  }
}

/** A fresh attempt id; only ever called for an explicit user action. */
export function newAttemptId(): string {
  return crypto.randomUUID();
}

export function newDraftId(): string {
  return crypto.randomUUID();
}
