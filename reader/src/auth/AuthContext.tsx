import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, createApiClient, type ApiClient } from '../api/client';
import type { Device, Session } from '../api/types';
import { clearPending, loadPending, savePending, type PendingLogin } from './pendingLogin';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';
export type LoginPhase = 'idle' | 'sending' | 'waiting' | 'expired' | 'error';
export type DevicesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; items: Device[] }
  | { status: 'error'; message: string };

const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Session-load retry while the Backend is unreachable: 5 s, doubling, capped at 60 s. */
export const SESSION_RETRY_FIRST_MS = 5000;
export const SESSION_RETRY_MAX_MS = 60_000;
export const sessionRetryDelay = (failures: number): number =>
  Math.min(SESSION_RETRY_FIRST_MS * 2 ** Math.max(failures - 1, 0), SESSION_RETRY_MAX_MS);
const UNREACHABLE_COPY = 'Could not reach the Backend. Check your connection and reload.';

export interface AuthValue {
  status: AuthStatus;
  session: Session | null;
  devices: DevicesState;
  /** The session-aware client; M2 calls are gated by session.capabilities. */
  api: ApiClient;
  /** Refetch GET /session (capabilities may have changed). */
  refreshSession(): Promise<Session | null>;
  loginPhase: LoginPhase;
  loginMessage: string | null;
  signOutError: string | null;
  submitEmail(email: string): Promise<void>;
  restartLogin(): void;
  signOut(): Promise<void>;
  loadDevices(): Promise<void>;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [devices, setDevices] = useState<DevicesState>({ status: 'idle' });
  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle');
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const pollNowRef = useRef(false);

  // Any 401 clears the session and every cache derived from it.
  const dropSession = useCallback(() => {
    setSession(null);
    setDevices({ status: 'idle' });
    setStatus('signedOut');
  }, []);
  const api = useMemo(() => createApiClient({ onUnauthorized: dropSession }), [dropSession]);

  const finishSignedIn = useCallback((s: Session) => {
    setSession(s);
    setStatus('signedIn');
    setLoginPhase('idle');
    setLoginMessage(null);
  }, []);

  // App start: resume a stored pending login, else look for a session. While the
  // Backend is unreachable (network error, or an answer that is not a session or a 401, as when
  // the Backend is briefly without the Reader API) the read-only GET /session is retried with a
  // bounded backoff, so the page recovers by itself. Only this read is retried; no write is.
  useEffect(() => {
    const ctl = new AbortController();
    const { signal } = ctl;
    (async () => {
      let failures = 0;
      for (;;) {
        try {
          const s = await api.getSession();
          if (signal.aborted) return;
          clearPending();
          finishSignedIn(s);
          return;
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof ApiError && e.status === 401) break;
          failures += 1;
          setStatus('signedOut');
          setLoginPhase('error');
          setLoginMessage(UNREACHABLE_COPY);
          await sleep(sessionRetryDelay(failures), signal);
          if (signal.aborted) return;
        }
      }
      setStatus('signedOut');
      // The copy of an earlier failed attempt goes; a login the user started meanwhile stays.
      setLoginMessage((m) => (m === UNREACHABLE_COPY ? null : m));
      setLoginPhase((p) => (p === 'error' ? 'idle' : p));
      const stored = loadPending();
      if (stored) {
        setPending(stored);
        pollNowRef.current = true;
        setLoginPhase('waiting');
      }
    })();
    return () => ctl.abort();
  }, [api, finishSignedIn]);

  // Poll the pending login until it is approved, delivered, expired or times out.
  useEffect(() => {
    if (!pending) return;
    const ctl = new AbortController();
    const { signal } = ctl;
    const startNow = pollNowRef.current;
    pollNowRef.current = false;
    const expireLocally = (msg: string) => {
      clearPending();
      setPending(null);
      setLoginPhase('expired');
      setLoginMessage(msg);
    };
    const EXPIRED_COPY = 'This link expired or was already used. Request a new one.';
    (async () => {
      let delay = startNow ? 0 : DEFAULT_POLL_MS;
      let failures = 0;
      while (!signal.aborted) {
        if (delay > 0) await sleep(delay, signal);
        if (signal.aborted) return;
        if (Date.parse(pending.expires_at) <= Date.now()) return expireLocally(EXPIRED_COPY);
        try {
          const res = await api.pollLogin(pending.request_id);
          if (signal.aborted) return;
          failures = 0;
          if (res.state === 'approved') {
            const s = await api.getSession();
            if (signal.aborted) return;
            clearPending();
            setPending(null);
            return finishSignedIn(s);
          }
          if (res.state === 'delivered' || res.state === 'expired') {
            return expireLocally(EXPIRED_COPY);
          }
          delay = Math.max(res.poll_after_ms ?? DEFAULT_POLL_MS, MIN_POLL_MS);
        } catch {
          if (signal.aborted) return;
          failures += 1;
          delay = Math.min(DEFAULT_POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
        }
      }
    })();
    return () => ctl.abort();
  }, [pending, api, finishSignedIn]);

  const submitEmail = useCallback(
    async (email: string) => {
      setLoginPhase('sending');
      setLoginMessage(null);
      try {
        const started = await api.startLogin(email.trim());
        const p = { request_id: started.request_id, expires_at: started.expires_at };
        savePending(p);
        setPending(p);
        setLoginPhase('waiting');
      } catch (e) {
        setLoginPhase('error');
        setLoginMessage(
          e instanceof ApiError && e.status === 422
            ? 'Enter a valid email address.'
            : e instanceof ApiError && e.status === 429
              ? 'Too many attempts. Wait a moment and try again.'
              : 'Could not send the request. Try again.',
        );
      }
    },
    [api],
  );

  const restartLogin = useCallback(() => {
    clearPending();
    setPending(null);
    setLoginPhase('idle');
    setLoginMessage(null);
  }, []);

  const signOut = useCallback(async () => {
    setSignOutError(null);
    try {
      await api.logout();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setSignOutError('Could not sign out. Try again.');
        return;
      }
    }
    api.reset();
    clearPending();
    setPending(null);
    setLoginPhase('idle');
    dropSession();
  }, [api, dropSession]);

  const loadDevices = useCallback(async () => {
    setDevices({ status: 'loading' });
    try {
      const list = await api.listDevices();
      setDevices({ status: 'ready', items: list.items });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // dropSession already ran
      setDevices({ status: 'error', message: 'Could not load nodes.' });
    }
  }, [api]);

  const refreshSession = useCallback(async () => {
    try {
      const s = await api.getSession();
      setSession(s);
      return s;
    } catch {
      return null; // a 401 already ran dropSession
    }
  }, [api]);

  const value: AuthValue = {
    status,
    session,
    devices,
    api,
    refreshSession,
    loginPhase,
    loginMessage,
    signOutError,
    submitEmail,
    restartLogin,
    signOut,
    loadDevices,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
