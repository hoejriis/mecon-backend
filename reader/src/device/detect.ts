import { decodeFrame, encodeDeviceQuery, type DeviceInfo } from '../ble/protocol';
import { SerialDeframer, encodeSerialFrame } from '../ble/serialFraming';
import { BleError, type CompanionTransport } from '../ble/transport';
import { LineSplitter, cliReplyText, encodeCliLine, parseMeconVersion, parseRoleReply } from './cliText';
import { guardBytes, guardFrames } from './guard';
import { MeconReassembler, buildRequest, encodeMeconFrames, encodeMeconLine, parseHello, parseMeconLine, type Envelope, type HelloInfo } from './meconIface';
import type { ByteTransport } from './serialBytes';
import { linkTrustOf, type LinkTrust } from './trust';

/**
 * Device identification after the port is open. Role-agnostic and truthful:
 * everything below is decided from what the device ANSWERED, never from a
 * board name, a USB id or a version string alone. Every write detection makes
 * goes through the read-only probe guard (guard.ts), so detection itself can
 * never send anything but reads.
 *
 * Order, each step bounded by a timeout and read-only:
 *  1. `mecon> {hello}` as a console line (Repeater, Room server). Text bytes are
 *     ignored by a Companion's serial loop (it skips everything but '<' while idle).
 *  2. If a console answered but not the interface: the stock CLI fallback `ver`,
 *     `get role`, `board` (not-MECON or older firmware).
 *  3. If the console said nothing: hello as 0x7F frames in the serial wrapper (Companion).
 *  4. If a Companion answered or step 3 stayed silent: the Companion binary device query,
 *     which proves the binary driver (messaging) works on this port.
 * Anything that answers none of these is reported `unknown`.
 *
 * Over BLE (`detectBleDevice`) the same identification runs without the console steps, since
 * BLE carries no console (only Companions have BLE, and the interface rides in 0x7F frames as
 * on USB): the interface hello as 0x7F frames, then the Companion device query. Nothing is
 * inferred from the BLE device name, which is never read here. The BLE link's PIN state is not
 * observable from a browser, so its trust is `unknown` (see trust.ts), and a device may refuse
 * even hello on such a link (`interfaceRefused`).
 */
export type Capability =
  | 'identity.read'
  | 'status.read'
  | 'clock.read'
  | 'config.read'
  | 'telemetry.stream'
  | 'contacts.read'
  | 'messages.receive'
  | 'message.send.direct'
  | 'message.send.channel';

export type DeviceRole = 'companion' | 'repeater' | 'room' | 'sensor' | 'unknown';

export interface DetectedDevice {
  /** The link the detection ran over. */
  transport: 'usb' | 'ble';
  /** How far the link is trusted (trust.ts). USB: trusted. BLE: unknown, the PIN is not observable. */
  trust: LinkTrust;
  firmware: 'mecon' | 'unknown';
  firmwareVersion: string | null;
  role: DeviceRole;
  roleSource: 'hello' | 'get role' | 'companion frames' | null;
  /** Informational only (never used to decide the role). */
  hardware: string | null;
  interfaceVersion: string | null;
  carriage: 'console-line' | 'companion-frames' | null;
  /** The device answered the stock text console (fallback path). */
  consoleCli: boolean;
  /** The device answered Companion binary frames (messaging driver available). */
  companionBinary: boolean;
  /** The device interface answered hello with `refused`: it is there, and does not trust this link. Not an identification. */
  interfaceRefused: boolean;
  /** What the Companion device query answered (binary driver), when it did. */
  deviceInfo: DeviceInfo | null;
  /** The error name when the device answered the Companion device query with an error frame. */
  companionError: string | null;
  /** Operations and streams the device listed in hello. */
  interfaceOps: string[];
  deviceIdPresent: boolean;
  nodeKeyPresent: boolean;
  capabilities: Capability[];
  evidence: string[];
  commandsSent: string[];
  linkLost: boolean;
  summary: string;
}

export interface DetectOptions {
  /** Per-step wait. Default 1500 ms. */
  stepTimeoutMs?: number;
  /**
   * The console-line hello is repeated every `consoleRetryMs` (default 2000) until
   * `consoleWindowMs` (default 30000) has passed. Opening a port resets many boards and
   * they answer only 13-26 s later; binary frames must not be sent before then, as they
   * can garble a Repeater console's next line (public firmware owner, Issue #30).
   */
  consoleRetryMs?: number;
  consoleWindowMs?: number;
  onStep?: (label: string) => void;
}

type Ev = { kind: 'line'; line: string } | { kind: 'frame'; frame: Uint8Array };

function capsFromHello(h: HelloInfo): Capability[] {
  const ops = new Set(h.capabilities);
  const out: Capability[] = ['identity.read'];
  if (ops.has('status.get')) out.push('status.read');
  if (ops.has('clock.get')) out.push('clock.read');
  if (ops.has('config.get')) out.push('config.read');
  if ([...ops].some((o) => o.startsWith('stream.')) || ops.has('sub.start')) out.push('telemetry.stream');
  return out;
}

/** Capabilities of the Companion binary driver. Present only when the device answered binary frames. */
export const COMPANION_BINARY_CAPS: readonly Capability[] = Object.freeze(['contacts.read', 'messages.receive', 'message.send.direct', 'message.send.channel']);

export function newDetected(transport: 'usb' | 'ble', sent: string[]): DetectedDevice {
  return {
    transport,
    trust: linkTrustOf(transport),
    firmware: 'unknown',
    firmwareVersion: null,
    role: 'unknown',
    roleSource: null,
    hardware: null,
    interfaceVersion: null,
    carriage: null,
    consoleCli: false,
    companionBinary: false,
    interfaceRefused: false,
    deviceInfo: null,
    companionError: null,
    interfaceOps: [],
    deviceIdPresent: false,
    nodeKeyPresent: false,
    capabilities: [],
    evidence: [],
    commandsSent: sent,
    linkLost: false,
    summary: '',
  };
}

/** Reads a hello answer into the result. Only a successful hello identifies MECON firmware and its role. */
export function applyHello(d: DetectedDevice, env: Envelope, carriage: 'console-line' | 'companion-frames'): boolean {
  if (env.status === 'refused') {
    d.interfaceRefused = true;
    d.evidence.push(`hello over ${carriage} was refused by the device (${String(env.error ?? 'no reason')})`);
    return false;
  }
  const h = parseHello(env);
  if (!h) {
    d.evidence.push(`hello over ${carriage} answered status ${String(env.status)} without a usable result`);
    return false;
  }
  d.firmware = 'mecon';
  d.carriage = carriage;
  d.interfaceVersion = h.interfaceVersion;
  d.firmwareVersion = h.firmware;
  d.hardware = h.hardware;
  d.interfaceOps = h.capabilities;
  d.deviceIdPresent = h.deviceIdPresent;
  d.nodeKeyPresent = h.nodeKeyPresent;
  d.capabilities = capsFromHello(h);
  if (h.role) {
    d.role = h.role;
    d.roleSource = 'hello';
  } else d.evidence.push(`hello reported a role this Reader does not know: ${h.roleRaw.slice(0, 20)}`);
  d.evidence.push(`hello answered over ${carriage}: interface ${h.interfaceVersion}`);
  return true;
}

type QueryAnswer = { info: DeviceInfo | null; error?: string };
/** A device-query answer: device info, or an error frame (the device speaks Companion frames but refused). */
function queryAnswer(frame: Uint8Array): QueryAnswer | null {
  const f = decodeFrame(frame);
  if (f.kind === 'deviceInfo') return { info: f.info };
  return f.kind === 'error' ? { info: null, error: f.name } : null;
}

/** The device answered Companion binary frames: the messaging driver is available. */
function applyBinary(d: DetectedDevice, a: QueryAnswer): void {
  d.companionBinary = true;
  d.deviceInfo = a.info;
  d.companionError = a.error ?? null;
  d.evidence.push('answered the Companion device query with Companion frames');
  for (const c of COMPANION_BINARY_CAPS) if (!d.capabilities.includes(c)) d.capabilities.push(c);
  if (!d.capabilities.includes('identity.read')) d.capabilities.push('identity.read');
  if (d.role === 'unknown') {
    d.role = 'companion';
    d.roleSource = 'companion frames';
  }
}

export async function detectDevice(raw: ByteTransport, opts: DetectOptions = {}): Promise<DetectedDevice> {
  const timeout = opts.stepTimeoutMs ?? 1500;
  const sent: string[] = [];
  const bytes = guardBytes(raw, sent);
  const events: Ev[] = [];
  const waiters: Array<() => void> = [];
  const splitter = new LineSplitter();
  const deframer = new SerialDeframer();
  const reasm = new MeconReassembler();
  let lost = false;
  const poke = () => waiters.splice(0).forEach((w) => w());
  const offBytes = bytes.onBytes((c) => {
    for (const line of splitter.feed(c)) events.push({ kind: 'line', line });
    for (const frame of deframer.feed(c)) events.push({ kind: 'frame', frame });
    poke();
  });
  const offDisc = bytes.onDisconnect(() => {
    lost = true;
    poke();
  });

  const d = newDetected('usb', sent);
  let seq = 0;

  /** Writes one unit, then waits for the first later event that `pick` accepts. */
  async function ask<T>(label: string, unit: Uint8Array | Uint8Array[], pick: (e: Ev) => T | null, waitMs: number = timeout): Promise<T | null> {
    if (lost) return null;
    opts.onStep?.(label);
    const mark = events.length;
    try {
      for (const u of Array.isArray(unit) ? unit : [unit]) await bytes.writeBytes(u);
    } catch (e) {
      if (e instanceof BleError && e.code === 'bad_argument') throw e; // a guard refusal is a bug, never swallowed
      d.evidence.push(`${label}: write failed (${e instanceof BleError ? e.code : 'error'})`);
      return null;
    }
    const deadline = Date.now() + waitMs;
    let i = mark;
    for (;;) {
      for (; i < events.length; i++) {
        const r = pick(events[i]!);
        if (r !== null) return r;
      }
      if (lost) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  const lineHelloIds = new Set<string>();
  const ifaceLineHello = async (waitMs: number): Promise<{ env: Envelope | null; consoleSeen: boolean } | null> => {
    const id = `rd-${++seq}`;
    lineHelloIds.add(id);
    return ask(
      'interface hello (console line)',
      encodeMeconLine(buildRequest(id, 'hello')),
      (e) => {
        if (e.kind !== 'line') return null;
        const env = parseMeconLine(e.line);
        // A late answer to an earlier attempt counts; our own echoed request has no status.
        if (env && typeof env.id === 'string' && lineHelloIds.has(env.id) && typeof env.status === 'string') return { env, consoleSeen: true };
        return cliReplyText(e.line) !== null ? { env: null, consoleSeen: true } : null;
      },
      waitMs,
    );
  };
  const consoleRetryMs = opts.consoleRetryMs ?? 2000;
  const consoleWindowMs = opts.consoleWindowMs ?? 30000;
  /** Repeats the console-line hello until something answers or the window ends. */
  const ifaceLineHelloWithRetry = async () => {
    const until = Date.now() + consoleWindowMs;
    for (;;) {
      const left = until - Date.now();
      const r = await ifaceLineHello(Math.max(1, Math.min(consoleRetryMs, left)));
      if (r || lost || Date.now() >= until) return r;
    }
  };
  const ifaceFrameHello = async (): Promise<Envelope | null> => {
    const id = `rd-${++seq}`;
    const frames = encodeMeconFrames(1, buildRequest(id, 'hello')).map((f) => encodeSerialFrame(f));
    return ask('interface hello (Companion 0x7F frames)', frames, (e) => {
      if (e.kind !== 'frame') return null;
      const text = reasm.push(e.frame);
      if (text === null) return null;
      try {
        const env = JSON.parse(text) as Envelope;
        return env && env.id === id ? env : null;
      } catch {
        return null;
      }
    });
  };
  const cli = (line: string) => ask(`console ${line}`, encodeCliLine(line), (e) => (e.kind === 'line' ? cliReplyText(e.line) : null));

  const takeHello = (env: Envelope, carriage: 'console-line' | 'companion-frames'): boolean => applyHello(d, env, carriage);

  const binaryProbe = async (): Promise<boolean> => {
    const ok = await ask('Companion device query (binary frames)', [encodeSerialFrame(encodeDeviceQuery())], (e) => (e.kind === 'frame' ? queryAnswer(e.frame) : null));
    if (ok) applyBinary(d, ok);
    return !!ok;
  };

  try {
    const first = await ifaceLineHelloWithRetry();
    if (first?.env && takeHello(first.env, 'console-line')) {
      /* interface over the console: Repeater or Room server */
    } else if (first?.consoleSeen) {
      d.consoleCli = true;
      d.evidence.push('a text console answered, but not the device interface');
      const ver = await cli('ver');
      if (ver !== null) {
        d.evidence.push('console answered ver');
        const mv = parseMeconVersion(ver);
        if (mv) {
          d.firmware = 'mecon';
          d.firmwareVersion = mv;
          d.evidence.push('ver reports a MECON build, but its device interface did not answer');
        }
        const role = await cli('get role');
        const r = role === null ? null : parseRoleReply(role);
        if (r) {
          d.role = r;
          d.roleSource = 'get role';
        } else d.evidence.push('get role gave no recognised role');
        const board = await cli('board');
        if (board) d.hardware = board.replace(/^>\s*/, '').slice(0, 60);
        d.capabilities = ['identity.read'];
      }
    } else if (!lost) {
      const env = await ifaceFrameHello();
      if (env) takeHello(env, 'companion-frames');
      await binaryProbe();
    }
  } finally {
    offBytes();
    offDisc();
  }
  d.linkLost = lost;
  if (lost) d.evidence.push('the link was lost during detection');
  d.summary = summarize(d);
  return d;
}

export interface BleDetectOptions extends Pick<DetectOptions, 'stepTimeoutMs' | 'onStep'> {
  /** Trust of the link, when the platform can tell. Default: unknown, because Web Bluetooth cannot read the PIN state. */
  trust?: LinkTrust;
}

/**
 * The same identification over a connected Companion frame link (BLE), without the console
 * steps: BLE carries no console. Every write goes through the read-only frame guard. The
 * transport must already be connected (`requestDevice` and `connect` done by the caller). The
 * BLE device name is never read: role, firmware and capabilities come only from answers.
 */
export async function detectBleDevice(raw: CompanionTransport, opts: BleDetectOptions = {}): Promise<DetectedDevice> {
  const timeout = opts.stepTimeoutMs ?? 3000;
  const sent: string[] = [];
  const link = guardFrames(raw, sent);
  const frames: Uint8Array[] = [];
  const waiters: Array<() => void> = [];
  const reasm = new MeconReassembler();
  let lost = false;
  const poke = () => waiters.splice(0).forEach((w) => w());
  const offFrame = link.onFrame((f) => {
    frames.push(f);
    poke();
  });
  const offDisc = link.onDisconnect(() => {
    lost = true;
    poke();
  });
  const d = newDetected('ble', sent);
  d.trust = opts.trust ?? 'unknown';

  async function ask<T>(label: string, unit: Uint8Array[], pick: (f: Uint8Array) => T | null): Promise<T | null> {
    if (lost) return null;
    opts.onStep?.(label);
    const mark = frames.length;
    try {
      for (const u of unit) await link.write(u);
    } catch (e) {
      if (e instanceof BleError && e.code === 'bad_argument') throw e; // a guard refusal is a bug, never swallowed
      d.evidence.push(`${label}: write failed (${e instanceof BleError ? e.code : 'error'})`);
      return null;
    }
    const deadline = Date.now() + timeout;
    let i = mark;
    for (;;) {
      for (; i < frames.length; i++) {
        const r = pick(frames[i]!);
        if (r !== null) return r;
      }
      if (lost) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  try {
    const id = 'rd-ble-1';
    const env = await ask('interface hello (Companion 0x7F frames over BLE)', encodeMeconFrames(1, buildRequest(id, 'hello')), (f): { env: Envelope } | { stock: true } | null => {
      const text = reasm.push(f);
      if (text === null) return decodeFrame(f).kind === 'error' ? { stock: true } : null; // a Companion error frame: it does not know 0x7F
      try {
        const e = JSON.parse(text) as Envelope;
        return e && e.id === id ? { env: e } : null;
      } catch {
        return null;
      }
    });
    if (env && 'env' in env) applyHello(d, env.env, 'companion-frames');
    else if (env) d.evidence.push('hello over Companion frames was answered with a Companion error frame: no device interface');
    else if (!lost) d.evidence.push('hello over Companion frames got no interface answer');
    const q = await ask('Companion device query (binary frames over BLE)', [encodeDeviceQuery()], queryAnswer);
    if (q) applyBinary(d, q);
  } finally {
    offFrame();
    offDisc();
  }
  d.linkLost = lost;
  if (lost) d.evidence.push('the link was lost during detection');
  d.summary = summarize(d);
  return d;
}

export function summarize(d: DetectedDevice): string {
  const caps = d.capabilities.length ? d.capabilities.join(', ') : 'none';
  if (d.firmware === 'mecon' && d.interfaceVersion) return `MECON firmware ${d.firmwareVersion ?? '(version not reported)'}, role ${d.role}, interface ${d.interfaceVersion}, capabilities: ${caps}`;
  if (d.firmware === 'mecon') return `MECON firmware ${d.firmwareVersion ?? ''} (device interface did not answer), role ${d.role}, capabilities: ${caps}`;
  if (d.interfaceRefused) return `MECON device interface refused hello (link not trusted): firmware and role not established; role ${d.role}, capabilities: ${caps}`;
  if (d.companionBinary || d.consoleCli) return `Not MECON firmware or older: unknown firmware, role ${d.role}, capabilities: ${caps}`;
  return 'Unknown device: nothing answered the read-only identification requests';
}
