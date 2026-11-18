import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { OfflineCache } from './cache';
import { registerGate, type OfflineMode } from './gate';
import { openIdbStore } from './idbStore';
import type { LeaseStatus } from './lease';
import { OfflineSession } from './session';
import { UnlockError, browserWebAuthn, listUnlockUsers, passkeyMaybeSupported, type UnlockMethod } from './unlock';

export interface OfflineValue {
  /** IndexedDB could be opened. When false, offline access is unavailable and the UI says so. */
  available: boolean;
  /** Unlock records on this device (opaque ids and methods). */
  profiles: Array<{ userId: string; method: UnlockMethod }>;
  unlockedUserId: string | null;
  method: UnlockMethod | null;
  mode: OfflineMode;
  lease: LeaseStatus | null;
  cache: OfflineCache | null;
  quarantined: boolean;
  warnings: string[];
  passkeyPossible: boolean;
  /** Set up for the signed-in user. Returns a user-facing note (a fallback explanation) or an error message. */
  setup(userId: string, o: { preferPasskey: boolean; pin?: string }): Promise<{ ok: boolean; message: string | null; needsPin?: boolean }>;
  unlockPin(userId: string, pin: string): Promise<{ ok: boolean; message: string | null }>;
  unlockPasskey(userId: string): Promise<{ ok: boolean; message: string | null }>;
  lock(): void;
  /** For the BLE and USB send paths. */
  session: OfflineSession | null;
}

/** Without a provider (a test shell, say) offline access is simply unavailable. */
const INERT: OfflineValue = {
  available: false,
  profiles: [],
  unlockedUserId: null,
  method: null,
  mode: { kind: 'shell', message: 'Offline access is not available.' },
  lease: null,
  cache: null,
  quarantined: false,
  warnings: [],
  passkeyPossible: false,
  session: null,
  setup: async () => ({ ok: false, message: 'Offline access is not available.' }),
  unlockPin: async () => ({ ok: false, message: 'Offline access is not available.' }),
  unlockPasskey: async () => ({ ok: false, message: 'Offline access is not available.' }),
  lock: () => undefined,
};

const Ctx = createContext<OfflineValue>(INERT);

export function useOffline(): OfflineValue {
  return useContext(Ctx);
}

const errorText = (e: unknown): string =>
  e instanceof UnlockError ? e.message : 'The offline cache could not be opened on this device.';

const LEASE_REFRESH_MS = 15 * 60_000;
const LEASE_TICK_MS = 30_000;

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { status, session: auth, api } = useAuth();
  const [, bump] = useState(0);
  const [session, setSession] = useState<OfflineSession | null>(null);
  const [available, setAvailable] = useState(false);
  const [profiles, setProfiles] = useState<OfflineValue['profiles']>([]);
  const ref = useRef<OfflineSession | null>(null);

  useEffect(() => {
    let closed = false;
    let close: (() => void) | undefined;
    (async () => {
      try {
        if (typeof indexedDB === 'undefined') return;
        const store = await openIdbStore();
        if (closed) return store.close();
        close = store.close;
        const s = new OfflineSession({ store, webauthn: browserWebAuthn(), onChange: () => bump((n) => n + 1) });
        ref.current = s;
        registerGate(s.gate);
        setProfiles(await listUnlockUsers(store));
        setSession(s);
        setAvailable(true);
      } catch {
        setAvailable(false); // private mode or blocked storage: offline access is simply not offered
      }
    })();
    return () => {
      closed = true;
      ref.current?.lock();
      registerGate(null);
      close?.();
    };
  }, []);

  const userId = auth?.user.id ?? null;
  const online = status === 'signedIn';

  // The Backend session decides who may stay unlocked. Online means signed in AND the browser reports a connection.
  useEffect(() => {
    if (!session) return;
    session.followSession(status === 'signedIn' ? userId : null);
  }, [session, status, userId]);

  useEffect(() => {
    if (!session) return;
    const sync = () => {
      session.gate.setOnline(navigator.onLine && online);
      bump((n) => n + 1);
    };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, [session, online]);

  // Activity postpones the idle lock.
  useEffect(() => {
    if (!session) return;
    const t = () => session.touch();
    const evs = ['pointerdown', 'keydown'] as const;
    evs.forEach((e) => window.addEventListener(e, t, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, t));
  }, [session]);

  const unlockedId = session?.unlockedUserId ?? null;
  const messagingOn = auth?.capabilities.messaging === 'available';

  // While unlocked and online with messaging: keep the verification keys and the lease fresh.
  useEffect(() => {
    if (!session || !unlockedId || !online || !messagingOn) return;
    let stop = false;
    const run = () => session.leases?.refresh(api).then(() => !stop && bump((n) => n + 1)).catch(() => undefined);
    void run();
    const h = setInterval(run, LEASE_REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [session, unlockedId, online, messagingOn, api]);

  // Re-evaluate the lease as time passes, so expiry takes effect without a reload.
  useEffect(() => {
    if (!session || !unlockedId) return;
    const h = setInterval(() => void session.leases?.tick().then(() => bump((n) => n + 1)), LEASE_TICK_MS);
    return () => clearInterval(h);
  }, [session, unlockedId]);

  const refreshProfiles = useCallback(async () => {
    if (ref.current) setProfiles(await listUnlockUsers(ref.current.store));
  }, []);

  const value: OfflineValue = (() => {
    const s = session;
    const wrap = async (f: () => Promise<{ ok: boolean }>): Promise<{ ok: boolean; message: string | null }> => {
      try {
        const r = await f();
        await refreshProfiles();
        return { ok: r.ok, message: r.ok ? null : 'The offline cache cannot be read by this version of the Reader. Nothing was deleted.' };
      } catch (e) {
        return { ok: false, message: errorText(e) };
      }
    };
    return {
      available,
      profiles,
      unlockedUserId: s?.unlockedUserId ?? null,
      method: s?.method ?? null,
      mode: s ? s.gate.mode() : { kind: 'shell', message: 'Offline access is not available in this browser.' },
      lease: s?.leases?.status ?? null,
      cache: s?.cache ?? null,
      quarantined: s?.quarantined ?? false,
      warnings: s ? [...s.warnings] : [],
      passkeyPossible: passkeyMaybeSupported(),
      session: s,
      async setup(uid, o) {
        if (!s) return { ok: false, message: 'Offline access is not available in this browser.' };
        try {
          const r = await s.setup(uid, o);
          await refreshProfiles();
          if (r.status === 'needs-pin') return { ok: false, message: r.note, needsPin: true };
          return { ok: r.opened?.ok ?? false, message: r.note };
        } catch (e) {
          return { ok: false, message: errorText(e) };
        }
      },
      unlockPin: (uid, pin) => (s ? wrap(() => s.unlockPin(uid, pin)) : Promise.resolve({ ok: false, message: 'Offline access is not available.' })),
      unlockPasskey: (uid) => (s ? wrap(() => s.unlockPasskey(uid)) : Promise.resolve({ ok: false, message: 'Offline access is not available.' })),
      lock: () => s?.lock(),
    };
  })();

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
