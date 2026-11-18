export const PENDING_KEY = 'mecon.reader.pending-login';

export interface PendingLogin {
  request_id: string;
  expires_at: string;
}

export function loadPending(): PendingLogin | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as PendingLogin).request_id === 'string' &&
      typeof (v as PendingLogin).expires_at === 'string' &&
      Number.isFinite(Date.parse((v as PendingLogin).expires_at))
    ) {
      return { request_id: (v as PendingLogin).request_id, expires_at: (v as PendingLogin).expires_at };
    }
  } catch {
    /* storage blocked or corrupt */
  }
  return null;
}

export function savePending(p: PendingLogin): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* works without storage; only resume is lost */
  }
}

export function clearPending(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}
