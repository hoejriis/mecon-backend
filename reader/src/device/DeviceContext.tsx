import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocalPath } from '../messaging/attemptStatus';
import type { LocalDeviceHandle } from '../messaging/localPath';

/**
 * The locally attached devices the Reader can send through, one session per path (Bluetooth, USB).
 * Sessions are created only when the user connects: the device layer is a lazy chunk, so a
 * browser that never connects a device never downloads it. Nothing here connects by itself.
 */
export interface DevicesValue {
  /** Sessions created so far. A session exists once the user asked to connect that path. */
  handles: Partial<Record<LocalPath, LocalDeviceHandle>>;
  /** Whether this browser exposes the API at all (a hint for the UI; the session reports the truth). */
  hasApi(path: LocalPath): boolean;
  /**
   * Opens the browser's chooser and connects. Call it directly from a click handler. Resolves
   * with a user-facing error message, or null when the device is connected and identified.
   */
  connect(path: LocalPath): Promise<string | null>;
  disconnect(path: LocalPath): Promise<void>;
}

const NONE: DevicesValue = { handles: {}, hasApi: () => false, connect: async () => 'Device access is not available.', disconnect: async () => undefined };
const Ctx = createContext<DevicesValue>(NONE);
/** For tests, which supply their own sessions. */
export const DeviceContext = Ctx;

const ERRORS: Record<string, string> = {
  unsupported: 'This browser cannot do that.',
  gesture_required: 'The browser needs a fresh tap to open the device chooser. Try again.',
  permission_denied: 'The browser did not give access to the device.',
  chooser_cancelled: 'No device was chosen.',
  write_timeout: 'Pairing was not completed in time. Enter the PIN shown on the device when the system asks, then connect again.',
  response_timeout: 'The device did not answer. Move closer or reconnect, then try again.',
  port_busy: 'The device is in use by another program or tab.',
};

/** Re-renders the caller whenever any session's state changes. */
export function useDevices(): DevicesValue {
  const v = useContext(Ctx);
  const [, bump] = useState(0);
  const key = Object.keys(v.handles).sort().join(',');
  useEffect(() => {
    const offs = Object.values(v.handles).map((h) => h.subscribe(() => bump((n) => n + 1)));
    return () => offs.forEach((o) => o());
  }, [key, v.handles]);
  return v;
}

/** The real provider, unless an outer one already supplies devices (a test's own sessions). */
export function DeviceProvider({ children }: { children: ReactNode }) {
  const outer = useContext(Ctx);
  return outer !== NONE ? <>{children}</> : <BrowserDevices>{children}</BrowserDevices>;
}

function BrowserDevices({ children }: { children: ReactNode }) {
  const [handles, setHandles] = useState<DevicesValue['handles']>({});
  const ref = useRef<DevicesValue['handles']>({});

  useEffect(
    () => () => {
      for (const h of Object.values(ref.current)) {
        void h.disconnect();
        (h as { dispose?: () => void }).dispose?.();
      }
    },
    [],
  );

  const connect = useCallback(async (path: LocalPath): Promise<string | null> => {
    let h = ref.current[path];
    if (!h) {
      const { createDeviceSession } = await import('./factory');
      h = createDeviceSession(path);
      ref.current = { ...ref.current, [path]: h };
      setHandles(ref.current);
    }
    const snap = h.getSnapshot();
    const r = snap.link === 'connected' ? { ok: true as const, error: null } : await h.connect();
    if (r.ok) return null;
    return ERRORS[r.error ?? ''] ?? `Could not connect (${r.error ?? 'unknown error'}).`;
  }, []);

  const value = useMemo<DevicesValue>(
    () => ({
      handles,
      hasApi: (p) => (typeof navigator === 'undefined' ? false : p === 'usb' ? 'serial' in navigator : 'bluetooth' in navigator),
      connect,
      disconnect: async (p) => {
        await ref.current[p]?.disconnect();
      },
    }),
    [handles, connect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
