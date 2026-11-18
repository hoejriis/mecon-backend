import { decodeFrame, encodeDeviceQuery } from '../ble/protocol';
import { SerialDeframer, encodeSerialFrame } from '../ble/serialFraming';
import { BleError } from '../ble/transport';
import { LineSplitter, cliReplyText, encodeCliLine, parseMeconVersion, parseRoleReply } from './cliText';
import { guardBytes } from './guard';
import { MeconReassembler, buildRequest, encodeMeconFrames, encodeMeconLine, parseHello, parseMeconLine, type Envelope, type HelloInfo } from './meconIface';
import type { ByteTransport } from './serialBytes';

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

  const d: DetectedDevice = {
    firmware: 'unknown',
    firmwareVersion: null,
    role: 'unknown',
    roleSource: null,
    hardware: null,
    interfaceVersion: null,
    carriage: null,
    consoleCli: false,
    companionBinary: false,
    interfaceOps: [],
    deviceIdPresent: false,
    nodeKeyPresent: false,
    capabilities: [],
    evidence: [],
    commandsSent: sent,
    linkLost: false,
    summary: '',
  };
  let seq = 0;

  /** Writes one unit, then waits for the first later event that `pick` accepts. */
  async function ask<T>(label: string, unit: Uint8Array | Uint8Array[], pick: (e: Ev) => T | null): Promise<T | null> {
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
    const deadline = Date.now() + timeout;
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

  const ifaceLineHello = async (): Promise<{ env: Envelope | null; consoleSeen: boolean } | null> => {
    const id = `rd-${++seq}`;
    return ask('interface hello (console line)', encodeMeconLine(buildRequest(id, 'hello')), (e) => {
      if (e.kind !== 'line') return null;
      const env = parseMeconLine(e.line);
      if (env && env.id === id && typeof env.status === 'string') return { env, consoleSeen: true }; // our own echoed request has no status
      return cliReplyText(e.line) !== null ? { env: null, consoleSeen: true } : null;
    });
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

  const takeHello = (env: Envelope, carriage: 'console-line' | 'companion-frames'): boolean => {
    if (env.status === 'refused') {
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
  };

  const binaryProbe = async (): Promise<boolean> => {
    const ok = await ask('Companion device query (binary frames)', [encodeSerialFrame(encodeDeviceQuery())], (e) => {
      if (e.kind !== 'frame') return null;
      const f = decodeFrame(e.frame);
      return f.kind === 'deviceInfo' || f.kind === 'error' ? true : null;
    });
    if (ok) {
      d.companionBinary = true;
      d.evidence.push('answered the Companion device query with Companion frames');
      for (const c of COMPANION_BINARY_CAPS) if (!d.capabilities.includes(c)) d.capabilities.push(c);
      if (!d.capabilities.includes('identity.read')) d.capabilities.push('identity.read');
      if (d.role === 'unknown') {
        d.role = 'companion';
        d.roleSource = 'companion frames';
      }
    }
    return !!ok;
  };

  try {
    const first = await ifaceLineHello();
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

export function summarize(d: DetectedDevice): string {
  const caps = d.capabilities.length ? d.capabilities.join(', ') : 'none';
  if (d.firmware === 'mecon' && d.interfaceVersion) return `MECON firmware ${d.firmwareVersion ?? '(version not reported)'}, role ${d.role}, interface ${d.interfaceVersion}, capabilities: ${caps}`;
  if (d.firmware === 'mecon') return `MECON firmware ${d.firmwareVersion ?? ''} (device interface did not answer), role ${d.role}, capabilities: ${caps}`;
  if (d.companionBinary || d.consoleCli) return `Not MECON firmware or older: unknown firmware, role ${d.role}, capabilities: ${caps}`;
  return 'Unknown device: nothing answered the read-only identification requests';
}
