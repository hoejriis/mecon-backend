import { BUILD_COMMIT } from '../../buildInfo';
import { CMD, decodeFrame, encodeAppStart, type DeviceInfo, type Frame, type SelfInfo } from '../protocol';
import { detectBleDevice, type DetectedDevice } from '../../device/detect';
import { sanitizeDetected, type SanitizedDetected } from '../../device/detectReport';
import { classifyProbeFrame } from '../../device/guard';
import { scrubText } from '../../device/scrub';
import { BleError, type BleDeviceInfo, type BlePhase, type BleTransport } from '../transport';

/**
 * Read-only BLE probe. It connects, identifies the device with the shared detection
 * (device/detect.ts: the MECON interface hello as 0x7F frames, then the Companion device
 * query), asks the Companion for its self info, and disconnects. It can never cause radio
 * transmission or change a setting: every write passes the shared read-only frame guard
 * (device/guard.ts), whose allowlist holds only the Companion app start and device query and
 * a 0x7F frame carrying one interface request of the read operations `hello`, `status.get`
 * and `clock.get`, with no arguments and no authority. Anything else is refused before it
 * reaches the transport. The BLE link's PIN state is not observable, so the link is reported
 * with trust `unknown`.
 */
export const PROBE_VERSION = 2;

/** The native Companion command codes the probe may write. The interface carrier 0x7F is allowed only through classifyProbeFrame. Do not extend without a review. */
export const ALLOWED_CMD_CODES: readonly number[] = Object.freeze([CMD.APP_START, CMD.DEVICE_QUERY]);

export type StepId = 'environment' | 'chooser' | 'connect' | 'service' | 'notifications' | 'deviceQuery' | 'selfInfo' | 'battery' | 'disconnect';
export type StepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'unsupported' | 'unknown';

export interface StepError {
  name: string;
  code: string | null;
  message: string;
}

export interface Step {
  id: StepId;
  label: string;
  status: StepStatus;
  /** Milliseconds this step took, or null when it did not run. */
  ms: number | null;
  error: StepError | null;
  note: string | null;
}

export const STEP_LABELS: Record<StepId, string> = {
  environment: 'Browser support (navigator.bluetooth)',
  chooser: 'Device chooser (user gesture)',
  connect: 'Connect to the Companion',
  service: 'Service discovery',
  notifications: 'Start notifications',
  deviceQuery: 'Hello: interface hello (0x7F) and device query',
  selfInfo: 'Self-info response',
  battery: 'Battery',
  disconnect: 'Disconnect',
};
const ORDER: StepId[] = ['environment', 'chooser', 'connect', 'service', 'notifications', 'deviceQuery', 'selfInfo', 'battery', 'disconnect'];

export function freshSteps(): Step[] {
  return ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: 'pending', ms: null, error: null, note: null }));
}

export interface Environment {
  userAgent: string;
  bluetoothPresent: boolean;
  /** 'true' | 'false' | 'not_available' (no availability()) | 'error:<name>' */
  availability: string;
}

export async function collectEnvironment(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): Promise<Environment> {
  const n = nav as { userAgent?: string; bluetooth?: { requestDevice?: unknown; getAvailability?: () => Promise<boolean> } } | undefined;
  const bt = n?.bluetooth;
  const present = !!bt && typeof bt.requestDevice === 'function';
  let availability = 'not_available';
  if (present && typeof bt?.getAvailability === 'function') {
    try {
      availability = String(await bt.getAvailability());
    } catch (e) {
      availability = `error:${(e as { name?: string } | null)?.name ?? 'Error'}`;
    }
  }
  return { userAgent: n?.userAgent ?? '', bluetoothPresent: present, availability };
}

/**
 * Wraps a transport so that write() refuses any frame the shared read-only frame guard does not
 * allow (classifyProbeFrame). The refusal happens before the inner transport is touched. `log`
 * receives the command codes, `labels` the guard's names (`frame:22`, `frame-iface:hello`).
 */
export function guardTransport(inner: BleTransport, log: number[] = [], labels: string[] = []): BleTransport {
  return {
    get kind() {
      return inner.kind;
    },
    get support() {
      return inner.support;
    },
    requestDevice: () => inner.requestDevice(),
    connect: () => inner.connect(),
    async write(frame: Uint8Array): Promise<void> {
      const c = classifyProbeFrame(frame);
      log.push(frame[0]!);
      labels.push(c.label);
      await inner.write(frame);
    },
    disconnect: () => inner.disconnect(),
    onFrame: (cb) => inner.onFrame(cb),
    onDisconnect: (cb) => inner.onDisconnect(cb),
    onPhase: inner.onPhase ? (cb) => inner.onPhase!(cb) : undefined,
  };
}

export interface RawProbe {
  startedAt: number;
  env: Environment;
  steps: Step[];
  device: BleDeviceInfo | null;
  deviceInfo: DeviceInfo | null;
  selfInfo: SelfInfo | null;
  /** Absent in older fixtures; the probe always sets them. */
  detected?: DetectedDevice | null;
  commandCodesSent: number[];
  commandsSent?: string[];
}

export interface RunOptions {
  transport: BleTransport;
  env: Environment;
  now?: () => number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  disconnectWaitMs?: number;
  onUpdate?: (raw: RawProbe) => void;
}

function toStepError(e: unknown): StepError {
  if (e instanceof BleError) return { name: e.name, code: e.code, message: e.message };
  const o = e as { name?: string; message?: string } | null;
  return { name: o?.name ?? 'Error', code: null, message: o?.message ?? String(e) };
}

/**
 * Runs the probe. MUST be called directly from a click handler: the first thing
 * it does, synchronously, is call transport.requestDevice() (user gesture rule).
 */
export function runProbe(opts: RunOptions): Promise<RawProbe> {
  const now = opts.now ?? (() => performance.now());
  const sent: number[] = [];
  const labels: string[] = [];
  const transport = guardTransport(opts.transport, sent, labels);
  const raw: RawProbe = { startedAt: now(), env: opts.env, steps: freshSteps(), device: null, deviceInfo: null, selfInfo: null, detected: null, commandCodesSent: sent, commandsSent: labels };
  const step = (id: StepId): Step => raw.steps.find((s) => s.id === id)!;
  const push = () => opts.onUpdate?.({ ...raw, steps: raw.steps.map((s) => ({ ...s })) });
  const set = (id: StepId, patch: Partial<Step>) => {
    Object.assign(step(id), patch);
    push();
  };

  // Battery is a static fact: the supported protocol subset has no battery command, so nothing is ever sent for it.
  step('battery').status = 'unsupported';
  step('battery').note = 'The supported protocol subset has no battery command; nothing is sent for it';

  // Environment step is decided before the gesture.
  if (!opts.env.bluetoothPresent) set('environment', { ms: 0, status: 'unsupported', note: 'navigator.bluetooth is missing in this browser' });
  else if (opts.env.availability === 'false') set('environment', { ms: 0, status: 'fail', note: 'Bluetooth reports itself unavailable (radio off or blocked)' });
  else set('environment', { ms: 0, status: 'pass', note: opts.env.availability === 'true' ? 'Bluetooth available' : `availability: ${opts.env.availability}` });

  // The chooser call must be the first async thing, with nothing awaited before it.
  const t0 = now();
  set('chooser', { status: 'running' });
  const chooser = transport.requestDevice();
  return finish(chooser, t0);

  async function finish(chooserP: Promise<BleDeviceInfo>, tChooser: number): Promise<RawProbe> {
    let linkUp = false;
    let lost = false;
    const waiters: Array<{ kind: Frame['kind']; res: (f: Frame) => void }> = [];
    const early: Frame[] = [];
    const offFrame = transport.onFrame((b) => {
      const f = decodeFrame(b);
      const i = waiters.findIndex((w) => w.kind === f.kind || f.kind === 'error');
      if (i >= 0) waiters.splice(i, 1)[0]!.res(f);
      else early.push(f);
    });
    const offDisc = transport.onDisconnect(() => {
      lost = true;
      for (const w of waiters.splice(0)) w.res({ kind: 'malformed', code: 0, reason: 'link lost' });
    });
    const seen: BlePhase[] = [];
    let phaseAt = now();
    const phaseTimes = new Map<BlePhase, number>();
    const offPhase = transport.onPhase?.((p) => {
      const t = now();
      seen.push(p);
      phaseTimes.set(p, t - phaseAt);
      phaseAt = t;
    });
    const unknownFrom = (from: StepId, why: string) => {
      for (const id of ORDER.slice(ORDER.indexOf(from))) {
        const s = step(id);
        if (s.status === 'pending' && id !== 'battery' && id !== 'disconnect') {
          s.status = 'unknown';
          s.note = why;
        }
      }
      push();
    };
    const ask = (kind: Frame['kind'], cmd: Uint8Array, timeoutMs: number): Promise<Frame> =>
      new Promise<Frame>((resolve, reject) => {
        const t = setTimeout(() => {
          const i = waiters.findIndex((w) => w.res === wrapped);
          if (i >= 0) waiters.splice(i, 1);
          reject(new BleError('response_timeout', `no ${kind} reply within ${timeoutMs} ms`));
        }, timeoutMs);
        const wrapped = (f: Frame) => {
          clearTimeout(t);
          resolve(f);
        };
        const i = early.findIndex((f) => f.kind === kind || f.kind === 'error');
        if (i >= 0) return wrapped(early.splice(i, 1)[0]!);
        waiters.push({ kind, res: wrapped });
        transport.write(cmd).catch((e) => {
          clearTimeout(t);
          const j = waiters.findIndex((w) => w.res === wrapped);
          if (j >= 0) waiters.splice(j, 1);
          reject(e);
        });
      });

    try {
      // 1. chooser
      try {
        raw.device = await chooserP;
        set('chooser', { status: 'pass', ms: Math.round(now() - tChooser), note: 'A device was chosen' });
      } catch (e) {
        const err = toStepError(e);
        set('chooser', {
          status: err.code === 'unsupported' ? 'unsupported' : 'fail',
          ms: Math.round(now() - tChooser),
          error: err,
          note: err.code === 'chooser_cancelled' ? 'Chooser closed, or no device matched. See "If the chooser is empty".' : null,
        });
        unknownFrom('connect', 'not run: no device chosen');
        return raw;
      }

      // 2. connect (+ service + notifications when the transport reports phases)
      set('connect', { status: 'running' });
      const tConnect = now();
      phaseAt = tConnect;
      try {
        await withTimeout(transport.connect(), opts.connectTimeoutMs ?? 20000);
        linkUp = true;
        const total = Math.round(now() - tConnect);
        const hasPhases = seen.length > 0;
        set('connect', { status: 'pass', ms: hasPhases ? Math.round(phaseTimes.get('gatt_connected') ?? total) : total, note: hasPhases ? null : 'Connect, service discovery and notifications are one call in this transport' });
        if (hasPhases) {
          set('service', { status: seen.includes('characteristics_found') ? 'pass' : 'unknown', ms: Math.round((phaseTimes.get('service_found') ?? 0) + (phaseTimes.get('characteristics_found') ?? 0)) });
          set('notifications', { status: seen.includes('notifications_started') ? 'pass' : 'unknown', ms: Math.round(phaseTimes.get('notifications_started') ?? 0) });
        } else {
          set('service', { status: 'unknown', note: 'Not reported separately; covered by Connect passing' });
          set('notifications', { status: 'unknown', note: 'Not reported separately; covered by Connect passing' });
        }
      } catch (e) {
        const err = toStepError(e);
        const failing: StepId = !seen.includes('gatt_connected') ? 'connect' : !seen.includes('characteristics_found') ? 'service' : 'notifications';
        for (const id of ['connect', 'service', 'notifications'] as StepId[]) {
          if (ORDER.indexOf(id) < ORDER.indexOf(failing)) set(id, { status: 'pass' });
        }
        set(failing, { status: 'fail', ms: Math.round(now() - tConnect), error: err });
        unknownFrom('deviceQuery', 'not run: connect failed');
        return raw;
      }

      // 3. identify with the shared detection (interface hello as 0x7F frames, then the Companion
      // device query), then self info. Read-only requests only; the guard enforces it.
      set('deviceQuery', { status: 'running' });
      const tIdentify = now();
      let d: DetectedDevice;
      try {
        d = await detectBleDevice(transport, { stepTimeoutMs: opts.responseTimeoutMs ?? 8000 });
      } catch (e) {
        set('deviceQuery', { status: 'fail', ms: Math.round(now() - tIdentify), error: toStepError(e) });
        unknownFrom('selfInfo', 'not run: identification failed');
        return raw;
      }
      early.length = 0; // frames seen so far belong to detection, not to the self-info request below
      raw.detected = d;
      raw.deviceInfo = d.deviceInfo;
      if (d.companionBinary && d.deviceInfo) set('deviceQuery', { status: 'pass', ms: Math.round(now() - tIdentify), note: d.summary });
      else {
        const err = d.companionBinary
          ? new BleError('device_error', `device refused the command: ${d.companionError ?? 'device query'}`)
          : new BleError(lost || d.linkLost ? 'disconnected' : 'response_timeout', lost || d.linkLost ? 'link lost' : `no deviceInfo reply within ${opts.responseTimeoutMs ?? 8000} ms`);
        set('deviceQuery', { status: 'fail', ms: Math.round(now() - tIdentify), error: toStepError(err), note: d.summary });
      }
      if (!d.companionBinary || !d.deviceInfo) unknownFrom('selfInfo', 'not run: device query failed');
      else {
        set('selfInfo', { status: 'running' });
        const t = now();
        try {
          const f = await ask('selfInfo', encodeAppStart(), opts.responseTimeoutMs ?? 8000);
          if (f.kind === 'error') throw new BleError('device_error', `device refused the command: ${f.name}`);
          if (f.kind !== 'selfInfo') throw new BleError(lost ? 'disconnected' : 'device_error', `unexpected reply: ${f.kind}`);
          raw.selfInfo = f.info;
          set('selfInfo', { status: 'pass', ms: Math.round(now() - t) });
        } catch (e) {
          set('selfInfo', { status: 'fail', ms: Math.round(now() - t), error: toStepError(e) });
        }
      }
    } finally {
      // 4. disconnect, always, when a link was made
      const t = now();
      if (linkUp || raw.device) {
        set('disconnect', { status: 'running' });
        const dropped = new Promise<boolean>((res) => {
          if (lost) return res(true);
          const off = transport.onDisconnect(() => {
            off();
            res(true);
          });
          setTimeout(() => res(false), opts.disconnectWaitMs ?? 3000);
        });
        try {
          await transport.disconnect();
          const sawEvent = await dropped;
          set('disconnect', { status: sawEvent ? 'pass' : 'unknown', ms: Math.round(now() - t), note: sawEvent ? null : 'disconnect() returned but no disconnect event was seen' });
        } catch (e) {
          set('disconnect', { status: 'fail', ms: Math.round(now() - t), error: toStepError(e) });
        }
      } else {
        set('disconnect', { status: 'unknown', note: 'not run: never connected' });
      }
      offFrame();
      offDisc();
      offPhase?.();
    }
    return raw;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BleError('connect_timeout', `no result within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Sanitized report
// ---------------------------------------------------------------------------
export interface SanitizedStep {
  id: StepId;
  status: StepStatus;
  ms: number | null;
  error: { name: string; code: string | null; message: string } | null;
  note: string | null;
}

export interface ProbeReport {
  probe: { name: 'mecon-reader-ble-probe'; version: number; buildCommit: string | null };
  readOnly: true;
  generatedAt: string;
  userAgent: string;
  navigatorBluetoothPresent: boolean;
  availability: string;
  steps: SanitizedStep[];
  commandCodesSent: number[];
  /** Guard labels of every write, in order, for example `frame-iface:hello`, `frame:22`, `frame:1`. */
  commandsSent: string[];
  /** Trust of the BLE link: always `unknown`, a browser cannot read the PIN state (device/trust.ts). */
  linkTrust: 'unknown';
  /** What the shared detection identified over the link: firmware, role and capabilities. Null when the link never came up. */
  detected: SanitizedDetected | null;
  device: { chosen: boolean; idPresent: boolean; nameLength: number };
  hello: null | {
    firmwareVersion: number;
    maxContacts: number | null;
    maxChannels: number | null;
    firmwareBuild: string | null;
    model: string | null;
    version: string | null;
    clientRepeat: boolean | null;
    pathHashMode: number | null;
  };
  selfInfo: null | {
    advType: number;
    txPower: number;
    maxTxPower: number;
    multiAcks: number;
    advLocPolicy: number;
    telemetryMode: number;
    manualAddContacts: boolean;
    radio: { freqMHz: number; bwKHz: number; sf: number; cr: number };
    publicKeyPresent: boolean;
    publicKeyHexLength: number;
    nodeNamePresent: boolean;
    nodeNameLength: number;
    locationPresent: boolean;
  };
}

export { scrubText };

export function sanitizeReport(raw: RawProbe, opts: { now?: () => Date; commit?: string | null } = {}): ProbeReport {
  const secrets = [raw.device?.id ?? '', raw.device?.name ?? '', raw.selfInfo?.name ?? '', raw.selfInfo?.publicKey ?? ''];
  const t = (s: string | null): string | null => (s === null ? null : scrubText(s, secrets));
  const d = raw.deviceInfo;
  const s = raw.selfInfo;
  return {
    probe: { name: 'mecon-reader-ble-probe', version: PROBE_VERSION, buildCommit: opts.commit === undefined ? BUILD_COMMIT : opts.commit },
    readOnly: true,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    userAgent: raw.env.userAgent,
    navigatorBluetoothPresent: raw.env.bluetoothPresent,
    availability: raw.env.availability,
    steps: raw.steps.map((x) => ({
      id: x.id,
      status: x.status,
      ms: x.ms,
      error: x.error ? { name: scrubText(x.error.name, secrets), code: x.error.code, message: scrubText(x.error.message, secrets) } : null,
      note: t(x.note),
    })),
    commandCodesSent: [...raw.commandCodesSent],
    commandsSent: [...(raw.commandsSent ?? [])],
    linkTrust: 'unknown',
    detected: raw.detected ? sanitizeDetected(raw.detected) : null,
    device: { chosen: raw.device !== null, idPresent: !!raw.device?.id, nameLength: raw.device?.name?.length ?? 0 },
    hello: d && {
      firmwareVersion: d.firmwareVersion,
      maxContacts: d.maxContacts,
      maxChannels: d.maxChannels,
      firmwareBuild: t(d.firmwareBuild),
      model: t(d.model),
      version: t(d.version),
      clientRepeat: d.clientRepeat,
      pathHashMode: d.pathHashMode,
    },
    selfInfo: s && {
      advType: s.advType,
      txPower: s.txPower,
      maxTxPower: s.maxTxPower,
      multiAcks: s.multiAcks,
      advLocPolicy: s.advLocPolicy,
      telemetryMode: s.telemetryMode,
      manualAddContacts: s.manualAddContacts,
      radio: { freqMHz: s.radioFreqMHz, bwKHz: s.radioBwKHz, sf: s.radioSf, cr: s.radioCr },
      publicKeyPresent: s.publicKey.length > 0,
      publicKeyHexLength: s.publicKey.length,
      nodeNamePresent: s.name.length > 0,
      nodeNameLength: s.name.length,
      locationPresent: s.advLat !== 0 || s.advLon !== 0,
    },
  };
}
