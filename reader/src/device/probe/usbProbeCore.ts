import { BUILD_COMMIT } from '../../buildInfo';
import { BleError } from '../../ble/transport';
import { scrubText } from '../scrub';
import { sanitizeDetected, type SanitizedDetected } from '../detectReport';
import { detectDevice, type DetectedDevice } from '../detect';
import { getSerial } from '../webSerialTransport';
import type { ByteTransport, SerialPortInfo } from '../serialBytes';

/**
 * Read-only USB probe for ANY role. It opens the port the user chose,
 * identifies the device with detectDevice (whose every write passes the
 * read-only guard, see guard.ts) and closes the port. It can never cause radio
 * transmission or change a setting: the guard allows only the device interface's
 * `hello`, `status.get` and `clock.get`, the stock CLI's `ver`, `board`,
 * `get role`, `get mecon.version`, and the Companion app start and device
 * query. Detection itself sends hello, then (by what answers) the console
 * fallback or the Companion device query.
 */
export const USB_PROBE_VERSION = 1;

export type UsbStepId = 'environment' | 'chooser' | 'open' | 'identify' | 'disconnect';
export type UsbStepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'unsupported' | 'unknown';
export interface UsbStep {
  id: UsbStepId;
  label: string;
  status: UsbStepStatus;
  ms: number | null;
  error: { name: string; code: string | null; message: string } | null;
  note: string | null;
}
const LABELS: Record<UsbStepId, string> = {
  environment: 'Browser support (navigator.serial, secure context)',
  chooser: 'Port chooser (user gesture)',
  open: 'Open the port',
  identify: 'Identify the device (read-only requests)',
  disconnect: 'Close the port',
};
const ORDER: UsbStepId[] = ['environment', 'chooser', 'open', 'identify', 'disconnect'];
export const freshUsbSteps = (): UsbStep[] => ORDER.map((id) => ({ id, label: LABELS[id], status: 'pending', ms: null, error: null, note: null }));

export interface UsbEnvironment {
  userAgent: string;
  serialPresent: boolean;
  secureContext: boolean;
}
export function collectUsbEnvironment(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): UsbEnvironment {
  const n = nav as { userAgent?: string } | undefined;
  return {
    userAgent: n?.userAgent ?? '',
    serialPresent: getSerial(nav) !== null,
    secureContext: typeof isSecureContext === 'undefined' ? true : isSecureContext,
  };
}

export interface RawUsbProbe {
  startedAt: number;
  env: UsbEnvironment;
  steps: UsbStep[];
  port: SerialPortInfo | null;
  detected: DetectedDevice | null;
}

export interface UsbRunOptions {
  transport: ByteTransport;
  env: UsbEnvironment;
  now?: () => number;
  stepTimeoutMs?: number;
  /** Console-line hello retry window; default 30 s (boards reset on open). */
  consoleWindowMs?: number;
  disconnectWaitMs?: number;
  onUpdate?: (raw: RawUsbProbe) => void;
}

function toStepError(e: unknown) {
  if (e instanceof BleError) return { name: e.name, code: e.code as string, message: e.message };
  const o = e as { name?: string; message?: string } | null;
  return { name: o?.name ?? 'Error', code: null, message: o?.message ?? String(e) };
}

/** MUST be called directly from a click handler: the first thing it does, synchronously, is requestDevice(). */
export function runUsbProbe(opts: UsbRunOptions): Promise<RawUsbProbe> {
  const now = opts.now ?? (() => performance.now());
  const raw: RawUsbProbe = { startedAt: now(), env: opts.env, steps: freshUsbSteps(), port: null, detected: null };
  const step = (id: UsbStepId) => raw.steps.find((s) => s.id === id)!;
  const push = () => opts.onUpdate?.({ ...raw, steps: raw.steps.map((s) => ({ ...s })) });
  const set = (id: UsbStepId, patch: Partial<UsbStep>) => {
    Object.assign(step(id), patch);
    push();
  };
  const t = opts.transport;

  if (!opts.env.serialPresent) set('environment', { ms: 0, status: 'unsupported', note: opts.env.secureContext ? 'navigator.serial is missing in this browser (Web Serial needs desktop Chrome, Edge or Opera)' : 'Web Serial needs a secure context (https or localhost)' });
  else set('environment', { ms: 0, status: 'pass' });

  const t0 = now();
  set('chooser', { status: 'running' });
  const chooser = t.requestDevice(); // first async thing; nothing awaited before it
  return finish();

  async function finish(): Promise<RawUsbProbe> {
    let opened = false;
    try {
      try {
        raw.port = await chooser;
        set('chooser', { status: 'pass', ms: Math.round(now() - t0), note: 'A port was chosen' });
      } catch (e) {
        const err = toStepError(e);
        set('chooser', { status: err.code === 'unsupported' ? 'unsupported' : 'fail', ms: Math.round(now() - t0), error: err, note: err.code === 'chooser_cancelled' ? 'Chooser closed, or no port listed. See "If the chooser is empty".' : null });
        for (const id of ['open', 'identify'] as const) set(id, { status: 'unknown', note: 'not run: no port chosen' });
        set('disconnect', { status: 'unknown', note: 'not run: never opened' });
        return raw;
      }
      const t1 = now();
      set('open', { status: 'running' });
      try {
        await t.connect();
        opened = true;
        set('open', { status: 'pass', ms: Math.round(now() - t1) });
      } catch (e) {
        const err = toStepError(e);
        set('open', { status: 'fail', ms: Math.round(now() - t1), error: err, note: err.code === 'port_busy' ? 'The port is already open elsewhere. Close other tabs and serial programs.' : null });
        set('identify', { status: 'unknown', note: 'not run: the port did not open' });
        set('disconnect', { status: 'unknown', note: 'not run: never opened' });
        return raw;
      }
      const t2 = now();
      set('identify', { status: 'running' });
      try {
        const d = await detectDevice(t, { stepTimeoutMs: opts.stepTimeoutMs ?? 2000, consoleWindowMs: opts.consoleWindowMs ?? 30000 });
        raw.detected = d;
        const known = d.role !== 'unknown' || d.firmware === 'mecon';
        set('identify', { status: d.linkLost ? 'fail' : known ? 'pass' : 'unknown', ms: Math.round(now() - t2), note: d.linkLost ? 'The link was lost during identification' : known ? null : 'Nothing answered the read-only requests: the device speaks neither protocol, is not ready, or is not a MeshCore device' });
      } catch (e) {
        set('identify', { status: 'fail', ms: Math.round(now() - t2), error: toStepError(e) });
      }
    } finally {
      const t3 = now();
      if (opened) {
        set('disconnect', { status: 'running' });
        const dropped = new Promise<boolean>((res) => {
          const off = t.onDisconnect(() => {
            off();
            res(true);
          });
          setTimeout(() => res(false), opts.disconnectWaitMs ?? 3000);
        });
        try {
          await t.disconnect();
          const sawEvent = await dropped;
          set('disconnect', { status: sawEvent ? 'pass' : 'unknown', ms: Math.round(now() - t3), note: sawEvent ? null : 'close() returned but no close was reported' });
        } catch (e) {
          set('disconnect', { status: 'fail', ms: Math.round(now() - t3), error: toStepError(e) });
        }
      }
    }
    return raw;
  }
}

export interface UsbProbeReport {
  probe: { name: 'mecon-reader-usb-probe'; version: number; buildCommit: string | null };
  readOnly: true;
  generatedAt: string;
  userAgent: string;
  navigatorSerialPresent: boolean;
  secureContext: boolean;
  steps: Array<{ id: UsbStepId; status: UsbStepStatus; ms: number | null; error: UsbStep['error']; note: string | null }>;
  /** Labels of every unit written to the port, in order (for example `iface:hello`, `cli:ver`, `frame:22`). */
  commandsSent: string[];
  /** USB ids as the browser reports them (model level, hex), or null. */
  usb: { vendorId: string | null; productId: string | null } | null;
  detected: SanitizedDetected | null;
}

const hex4 = (n: number | undefined) => (n === undefined ? null : n.toString(16).padStart(4, '0'));

export function sanitizeUsbReport(raw: RawUsbProbe, opts: { now?: () => Date; commit?: string | null } = {}): UsbProbeReport {
  const t = (s: string | null): string | null => (s === null ? null : scrubText(s, []));
  const d = raw.detected;
  return {
    probe: { name: 'mecon-reader-usb-probe', version: USB_PROBE_VERSION, buildCommit: opts.commit === undefined ? BUILD_COMMIT : opts.commit },
    readOnly: true,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    userAgent: raw.env.userAgent,
    navigatorSerialPresent: raw.env.serialPresent,
    secureContext: raw.env.secureContext,
    steps: raw.steps.map((x) => ({ id: x.id, status: x.status, ms: x.ms, error: x.error ? { name: scrubText(x.error.name, []), code: x.error.code, message: scrubText(x.error.message, []) } : null, note: t(x.note) })),
    commandsSent: d ? [...d.commandsSent] : [],
    usb: raw.port && (raw.port.usbVendorId !== undefined || raw.port.usbProductId !== undefined) ? { vendorId: hex4(raw.port.usbVendorId), productId: hex4(raw.port.usbProductId) } : null,
    detected: d && sanitizeDetected(d),
  };
}
