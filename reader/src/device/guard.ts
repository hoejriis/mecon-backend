import { BleError, type CompanionTransport, type DisconnectReason, type Unsubscribe } from '../ble/transport';
import { CMD, MAX_FRAME_SIZE } from '../ble/protocol';
import { SERIAL_HEADER_SIZE, SERIAL_MARKER_TO_DEVICE } from '../ble/serialFraming';
import { CLI_READ_ONLY_LINES } from './cliText';
import { CMD_MECON, MECON_LINE_PREFIX, MECON_READ_OPS } from './meconIface';
import type { ByteTransport } from './serialBytes';

/** Companion binary commands the probe may send: app start and device query. Nothing else. */
export const PROBE_COMPANION_CODES: readonly number[] = Object.freeze([CMD.APP_START, CMD.DEVICE_QUERY]);

export interface Classified {
  /** A short label for reports: `cli:ver`, `iface:hello`, `frame:22`, `frame-iface:hello`. */
  label: string;
}

function jsonRead(text: string): string {
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    throw new BleError('bad_argument', 'probe refused: interface request is not JSON');
  }
  const e = env as Record<string, unknown> | null;
  const keys = e && typeof e === 'object' ? Object.keys(e) : [];
  const ok =
    !!e &&
    e.v === 1 &&
    typeof e.id === 'string' &&
    typeof e.op === 'string' &&
    MECON_READ_OPS.includes(e.op) &&
    keys.every((k) => k === 'v' || k === 'id' || k === 'op') && // no args, no auth: a read with nothing attached
    keys.length === 3;
  if (!ok) throw new BleError('bad_argument', `probe refused interface op ${String((e as { op?: unknown } | null)?.op)}: not on the read-only allowlist`);
  return String(e.op);
}

/**
 * Decides whether one Companion frame (no serial wrapper: this is what a BLE write carries, and
 * what sits inside a serial frame) is something the read-only probe may send. Allowed: the
 * Companion app start (1) and device query (22), and CMD_MECON (0x7F) carrying one read-only
 * interface request (MECON_READ_OPS) in a single frame. Throws BleError('bad_argument') otherwise.
 */
export function classifyProbeFrame(p: Uint8Array): Classified {
  if (p.length === 0) throw new BleError('bad_argument', 'probe refused a write: empty');
  const code = p[0]!;
  if (PROBE_COMPANION_CODES.includes(code)) return { label: `frame:${code}` };
  if (code === CMD_MECON) {
    if (p.length < 5 || p[2] !== 0 || p[3] !== 1) throw new BleError('bad_argument', 'probe refused a write: interface request must be one frame');
    return { label: `frame-iface:${jsonRead(new TextDecoder().decode(p.subarray(4)))}` };
  }
  throw new BleError('bad_argument', `probe refused a write: command code ${code}`);
}

/**
 * Wraps a frame transport (BLE) so that every write must pass classifyProbeFrame before it
 * reaches the link. Everything else passes through unchanged.
 */
export function guardFrames(inner: CompanionTransport, log: string[] = []): CompanionTransport {
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
      log.push(c.label);
      await inner.write(frame);
    },
    disconnect: () => inner.disconnect(),
    onFrame: (cb) => inner.onFrame(cb),
    onDisconnect: (cb) => inner.onDisconnect(cb),
    onPhase: inner.onPhase ? (cb) => inner.onPhase!(cb) : undefined,
  };
}

/**
 * Decides whether one write is something the read-only probe may send, and
 * names it. Throws BleError('bad_argument') for everything else. A write is one
 * unit: a single text line ending in one CR, or a single serial frame whose
 * declared length matches its bytes exactly. Allowlists:
 *   text lines   exact CLI_READ_ONLY_LINES, or `mecon> ` + one read-only request (MECON_READ_OPS)
 *   frames       Companion app start (1) and device query (22); CMD_MECON (0x7F) carrying
 *                one read-only request (MECON_READ_OPS) in one frame
 */
export function classifyProbeWrite(bytes: Uint8Array): Classified {
  const refuse = (why: string): never => {
    throw new BleError('bad_argument', `probe refused a write: ${why}`);
  };
  if (bytes.length === 0) return refuse('empty');
  if (bytes[0] === SERIAL_MARKER_TO_DEVICE) {
    if (bytes.length < SERIAL_HEADER_SIZE + 1) return refuse('short frame');
    const len = bytes[1]! | (bytes[2]! << 8);
    if (len > MAX_FRAME_SIZE || bytes.length !== SERIAL_HEADER_SIZE + len) return refuse('frame length mismatch');
    return classifyProbeFrame(bytes.subarray(SERIAL_HEADER_SIZE));
  }
  // Text: printable ASCII, exactly one terminating CR.
  if (bytes[bytes.length - 1] !== 0x0d) return refuse('text line without a single terminating CR');
  const body = bytes.subarray(0, bytes.length - 1);
  for (const b of body) if (b < 0x20 || b > 0x7e) return refuse('control or non-ASCII byte in a text line');
  const line = new TextDecoder().decode(body);
  if (line.startsWith(MECON_LINE_PREFIX)) return { label: `iface:${jsonRead(line.slice(MECON_LINE_PREFIX.length))}` };
  if (!CLI_READ_ONLY_LINES.includes(line)) return refuse('CLI line not on the read-only allowlist');
  return { label: `cli:${line}` };
}

/**
 * Wraps a byte transport so that every write must pass classifyProbeWrite
 * before it reaches the port. Reads, state and events pass through unchanged.
 */
export function guardBytes(inner: ByteTransport, log: string[] = []): ByteTransport {
  return {
    get kind() {
      return inner.kind;
    },
    get support() {
      return inner.support;
    },
    get chosen() {
      return inner.chosen;
    },
    isOpen: () => inner.isOpen(),
    requestDevice: () => inner.requestDevice(),
    connect: () => inner.connect(),
    async writeBytes(bytes: Uint8Array): Promise<void> {
      const c = classifyProbeWrite(bytes);
      log.push(c.label);
      await inner.writeBytes(bytes);
    },
    disconnect: () => inner.disconnect(),
    onBytes: (cb: (c: Uint8Array) => void): Unsubscribe => inner.onBytes(cb),
    onDisconnect: (cb: (r?: DisconnectReason) => void): Unsubscribe => inner.onDisconnect(cb),
  };
}
