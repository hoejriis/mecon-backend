/**
 * The MECON firmware's role-agnostic device interface, as far as its public
 * docs define it: JSON envelopes, carried over USB as one console line
 * `mecon> <json>` (Repeater, Room server) or as `0x7F` frames inside the
 * Companion serial wrapper (Companion). Only operations of class `read` that take no
 * arguments are built here: `hello`, `status.get`, `clock.get` (OPERATIONS.md, class column).
 *
 * SOURCES (hoejriis/mecon-firmware @ 5a729ef6127869d404fdffd7e5e08ddbb72a87b5; public repo):
 *  - docs/contract/DEVICE_INTERFACE.md  section 3 (envelope: v, id, op, args; status values),
 *      section 4 (hello, status.get are "read"), section 7 (framing: `0x7F | xid | index |
 *      count | up to 168 bytes`, count 1 to 25, one inbound message at a time, a frame for a
 *      new xid discards the incomplete one, a repeated frame is ignored; console line
 *      `mecon> <envelope>` ended by CR or LF, at most 1,600 bytes; the client takes lines that
 *      start with `mecon> {` and skips echo and everything else)
 *  - docs/contract/schema/hello.result.json   required: interface, device_id, node_key, role
 *      (enum companion | repeater | room), hardware, firmware, upstream, epoch, capabilities
 *  - docs/contract/fixtures/framing.json      one message and its exact frames (used as the
 *      independent test fixture for the frame codec)
 *  - docs/contract/fixtures/requests.json     the recorded hello request {"v":1,"id":..,"op":"hello"}
 *
 * UNVERIFIED: no board was read. That a Companion's USB serial accepts 0x7F frames before
 * `app start`; that every released build with the interface answers hello over USB; the exact
 * console echo around a `mecon> ` line on a real board; `status.get`'s result fields (not
 * decoded here; only its presence in the capability list is used). The Sensor role carries no
 * device interface and never answers hello (hello.result.json), so it is only ever identified
 * by its CLI.
 */
export const MECON_LINE_PREFIX = 'mecon> ';
export const CMD_MECON = 0x7f;
export const MECON_FRAME_BODY = 168;
export const MECON_MAX_FRAMES = 25;
export const MECON_MAX_LINE = 1600;
/** Read operations the Reader may send. Anything else is not built by this module. */
export const MECON_READ_OPS: readonly string[] = Object.freeze(['hello', 'status.get', 'clock.get']);

export interface Envelope {
  v?: number;
  id?: string;
  op?: string;
  args?: unknown;
  status?: string;
  result?: unknown;
  error?: string;
  [k: string]: unknown;
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export function buildRequest(id: string, op: 'hello' | 'status.get' | 'clock.get'): string {
  return JSON.stringify({ v: 1, id, op });
}

/** `mecon> {json}` plus CR. One write. */
export function encodeMeconLine(json: string): Uint8Array {
  const line = `${MECON_LINE_PREFIX}${json}`;
  if (line.length > MECON_MAX_LINE) throw new RangeError('interface line too long');
  return utf8.encode(`${line}\r`);
}

export function parseMeconLine(line: string): Envelope | null {
  const t = line.trim();
  if (!t.startsWith(`${MECON_LINE_PREFIX}{`)) return null;
  try {
    const v: unknown = JSON.parse(t.slice(MECON_LINE_PREFIX.length));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Envelope) : null;
  } catch {
    return null;
  }
}

/** Splits one message into 0x7F frames: `7f xid index count body`. */
export function encodeMeconFrames(xid: number, json: string): Uint8Array[] {
  const body = utf8.encode(json);
  const count = Math.max(1, Math.ceil(body.length / MECON_FRAME_BODY));
  if (count > MECON_MAX_FRAMES) throw new RangeError('message too long');
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = body.subarray(i * MECON_FRAME_BODY, (i + 1) * MECON_FRAME_BODY);
    const f = new Uint8Array(4 + part.length);
    f.set([CMD_MECON, xid & 0xff, i, count]);
    f.set(part, 4);
    out.push(f);
  }
  return out;
}

/**
 * Reassembles 0x7F frames, one message at a time (section 7): a frame for a new
 * xid drops the incomplete message, a repeated index is ignored, frames may
 * arrive in any order. Bounded: at most 25 frames of 168 bytes.
 */
export class MeconReassembler {
  private xid = -1;
  private count = 0;
  private parts = new Map<number, Uint8Array>();

  /** Returns the message text when `frame` completes one. */
  push(frame: Uint8Array): string | null {
    if (frame.length < 5 || frame[0] !== CMD_MECON) return null;
    const xid = frame[1]!;
    const index = frame[2]!;
    const count = frame[3]!;
    if (count < 1 || count > MECON_MAX_FRAMES || index >= count || frame.length - 4 > MECON_FRAME_BODY) return null;
    if (xid !== this.xid || count !== this.count) {
      this.xid = xid;
      this.count = count;
      this.parts = new Map();
    }
    if (!this.parts.has(index)) this.parts.set(index, frame.slice(4));
    if (this.parts.size < count) return null;
    const total = [...this.parts.values()].reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (let i = 0; i < count; i++) {
      const p = this.parts.get(i)!;
      buf.set(p, o);
      o += p.length;
    }
    this.xid = -1;
    this.parts = new Map();
    return utf8d.decode(buf);
  }
}

export type MeconRole = 'companion' | 'repeater' | 'room';

export interface HelloInfo {
  interfaceVersion: string;
  role: MeconRole | null;
  /** The role string as sent, when it is not one this Reader knows. */
  roleRaw: string;
  firmware: string | null;
  upstream: string | null;
  hardware: string | null;
  deviceIdPresent: boolean;
  nodeKeyPresent: boolean;
  capabilities: string[];
}

/** Reads a hello result. Null when the envelope is not a successful hello result. */
export function parseHello(env: Envelope): HelloInfo | null {
  if (env.status !== 'ok' || !env.result || typeof env.result !== 'object') return null;
  const r = env.result as Record<string, unknown>;
  if (typeof r.interface !== 'string' || !/^1\.\d+$/.test(r.interface) || typeof r.role !== 'string') return null;
  const s = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const role = r.role === 'companion' || r.role === 'repeater' || r.role === 'room' ? r.role : null;
  return {
    interfaceVersion: r.interface,
    role,
    roleRaw: r.role,
    firmware: s('firmware'),
    upstream: s('upstream'),
    hardware: s('hardware'),
    deviceIdPresent: typeof r.device_id === 'string' && r.device_id.length > 0,
    nodeKeyPresent: typeof r.node_key === 'string' && r.node_key.length > 0,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c): c is string => typeof c === 'string') : [],
  };
}
