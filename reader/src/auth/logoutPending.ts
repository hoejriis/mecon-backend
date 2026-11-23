/**
 * A server-side logout that could not complete (503 or no answer). The Reader
 * signed out locally; until the Backend confirms the logout (204 or 401) it
 * retries it and never adopts the session that cookie still names.
 */
export const LOGOUT_PENDING_KEY = 'mecon.reader.logout-pending';

export function isLogoutPending(): boolean {
  try {
    return window.localStorage.getItem(LOGOUT_PENDING_KEY) !== null;
  } catch {
    return false; // storage blocked: the in-memory flag still covers this page's life
  }
}

export function markLogoutPending(): void {
  try {
    window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
  } catch {
    /* storage blocked: only the retry after a reload is lost */
  }
}

export function clearLogoutPending(): void {
  try {
    window.localStorage.removeItem(LOGOUT_PENDING_KEY);
  } catch {
    /* ignore */
  }
}
