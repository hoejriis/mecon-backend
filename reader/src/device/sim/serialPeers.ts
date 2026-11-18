import { MockCompanion } from '../../ble/mockCompanion';
import { helloEnvelope } from './hello';
import { answerList, type SimChannel } from './lists';
import { MECON_LINE_PREFIX, CMD_MECON, MeconReassembler, encodeMeconFrames, type Envelope } from '../meconIface';

/**
 * SIMULATED serial peers. Everything here is synthetic: no real board, no
 * cable, no RF. Results obtained with them are "SIMULATED, not hardware
 * verified". A peer is a device on the other end of a serial line: it receives
 * bytes and emits bytes, and can lose the link.
 */
export interface SerialPeer {
  linked: boolean;
  linkUp(): void;
  dropLink(reason?: string): void;
  receiveBytes(bytes: Uint8Array): void;
  onOutput(cb: (bytes: Uint8Array) => void): () => void;
  onLinkLost(cb: (reason: string) => void): () => void;
}

/** Faults on the device-to-host byte line, shared by every peer. */
export interface LineFaults {
  /** Deliver output in chunks of at most this many bytes (1 = byte at a time). */
  splitBytes: number | null;
  /** Join everything emitted in one tick into one chunk. */
  coalesce: boolean;
  /** Bytes inserted before every frame (boot noise, line garbage). */
  garbageBeforeFrame: number[];
  /** Insert a '>' with an oversize length (0xFFFF) before every frame. */
  oversizeLengthNoise: boolean;
}
export const NO_LINE_FAULTS = (): LineFaults => ({ splitBytes: null, coalesce: false, garbageBeforeFrame: [], oversizeLengthNoise: false });

export { helloEnvelope };

abstract class BasePeer implements SerialPeer {
  linked = false;
  faults: LineFaults = NO_LINE_FAULTS();
  private outCbs = new Set<(b: Uint8Array) => void>();
  private lossCbs = new Set<(r: string) => void>();
  private pending: Uint8Array[] = [];
  private flushing = false;

  abstract receiveBytes(bytes: Uint8Array): void;

  onOutput(cb: (b: Uint8Array) => void): () => void {
    this.outCbs.add(cb);
    return () => this.outCbs.delete(cb);
  }
  onLinkLost(cb: (r: string) => void): () => void {
    this.lossCbs.add(cb);
    return () => this.lossCbs.delete(cb);
  }
  linkUp(): void {
    this.linked = true;
  }
  dropLink(reason = 'unplug'): void {
    if (!this.linked) return;
    this.linked = false;
    this.pending = [];
    for (const cb of [...this.lossCbs]) cb(reason);
  }

  /** Queue bytes for delivery, applying the line faults. */
  protected emitBytes(b: Uint8Array): void {
    if (!this.linked) return;
    this.pending.push(b.slice());
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      if (!this.linked) return;
      let chunks = this.pending.splice(0);
      if (this.faults.coalesce && chunks.length > 1) {
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        chunks = [all];
      }
      const n = this.faults.splitBytes;
      if (n) chunks = chunks.flatMap((c) => Array.from({ length: Math.ceil(c.length / n) }, (_, i) => c.slice(i * n, (i + 1) * n)));
      for (const c of chunks) for (const cb of [...this.outCbs]) cb(c.slice());
    });
  }
}

/** Parses app-to-device serial frames ('<' + u16 LE length + payload), independent of the codec under test. */
class HostFrameParser {
  private st = 0;
  private len = 0;
  private lo = 0;
  private buf: number[] = [];
  /** Bytes that were not part of a frame. */
  stray = 0;
  feed(b: Uint8Array, onFrame: (p: Uint8Array) => void): void {
    for (const c of b) {
      if (this.st === 0) {
        if (c === 0x3c) this.st = 1;
        else this.stray++;
      } else if (this.st === 1) {
        this.lo = c;
        this.st = 2;
      } else if (this.st === 2) {
        this.len = this.lo | (c << 8);
        this.buf = [];
        this.st = this.len > 0 ? 3 : 0;
      } else {
        this.buf.push(c);
        if (this.buf.length >= this.len) {
          onFrame(Uint8Array.from(this.buf));
          this.st = 0;
        }
      }
    }
  }
}

const wrapOut = (payload: Uint8Array): Uint8Array => {
  const o = new Uint8Array(3 + payload.length);
  o[0] = 0x3e;
  o[1] = payload.length & 0xff;
  o[2] = payload.length >> 8;
  o.set(payload, 3);
  return o;
};

export interface CompanionPeerOptions {
  /** Answer the MECON device interface in 0x7F frames. false = stock firmware (answers 0x7F with an error frame). */
  mecon?: boolean;
  capabilities?: string[];
  firmware?: string;
  hardware?: string;
}

/** The existing MockCompanion behind the serial wrapper, plus the interface's 0x7F carriage. */
export class CompanionSerialPeer extends BasePeer {
  readonly parser = new HostFrameParser();
  private readonly reasm = new MeconReassembler();
  /** Every 0x7F request envelope the device received. */
  readonly ifaceRequests: Envelope[] = [];

  constructor(
    readonly mock: MockCompanion = new MockCompanion(),
    private readonly opts: CompanionPeerOptions = { mecon: true },
  ) {
    super();
    mock.onNotify((f) => this.emitFrame(f));
    mock.onLinkLost((r) => {
      if (this.linked) this.dropLink(r);
    });
  }

  linkUp(): void {
    super.linkUp();
    this.mock.linkUp();
  }
  dropLink(reason = 'unplug'): void {
    super.dropLink(reason);
    this.mock.dropLink(reason);
  }

  private emitFrame(payload: Uint8Array): void {
    const f = this.faults;
    if (f.garbageBeforeFrame.length) this.emitBytes(Uint8Array.from(f.garbageBeforeFrame));
    if (f.oversizeLengthNoise) this.emitBytes(Uint8Array.of(0x3e, 0xff, 0xff));
    this.emitBytes(wrapOut(payload));
  }

  receiveBytes(bytes: Uint8Array): void {
    this.parser.feed(bytes, (p) => this.onFrame(p));
  }

  private onFrame(p: Uint8Array): void {
    if (p[0] !== CMD_MECON) return this.mock.receive(p);
    if (!this.opts.mecon) return this.emitFrame(Uint8Array.of(1, 1)); // RESP_CODE_ERR, ERR_CODE_UNSUPPORTED_CMD
    const text = this.reasm.push(p);
    if (text === null) return;
    const env = JSON.parse(text) as Envelope;
    this.ifaceRequests.push(env);
    const lists = this.mock.lists();
    const reply: Envelope =
      env.op === 'hello'
        ? helloEnvelope(String(env.id), 'companion', { ...this.opts, capabilities: this.mock.helloCapabilities(this.opts.capabilities) })
        : (lists ? answerList(env, lists) : null) ?? { v: 1, id: env.id, status: 'unknown-op' };
    for (const fr of encodeMeconFrames(p[1]!, JSON.stringify(reply))) this.emitFrame(fr);
  }
}

export interface RepeaterOptions {
  /** Answer `mecon> ` interface lines. false = stock console (answers them as an unknown command). */
  mecon?: boolean;
  role?: 'repeater' | 'room' | 'sensor';
  /** What `get role` answers; null = the command is unknown. */
  roleReply?: string | null;
  boardName?: string;
  ver?: string;
  capabilities?: string[];
  /** Answer the hello with this role string instead (to test unknown roles). */
  helloRole?: string;
  /**
   * Answer `channel.list` with the one slot a Repeater or Room server has (the management channel,
   * OPERATIONS.md: "R S: one slot") and list it in hello. `contact.list` is Companion only: a Repeater
   * answers it `unknown-op` whatever this says.
   */
  managementChannel?: SimChannel;
  /** Drop the first N complete lines unanswered, like a board still booting after the port open reset it. */
  ignoreFirstLines?: number;
}

/** SIMULATED Repeater / Room server console: upstream's line editor plus the `mecon> ` interface. */
export class MockRepeater extends BasePeer {
  private line = '';
  /** Every complete line the console received. */
  readonly lines: string[] = [];
  /** Lines that would have changed something on a real device (anything but the read-only set). The probe must never cause one. */
  readonly executed: string[] = [];
  readonly ifaceRequests: Envelope[] = [];
  private readonly o: Required<Omit<RepeaterOptions, 'helloRole' | 'ignoreFirstLines' | 'managementChannel'>> & { helloRole?: string; managementChannel?: SimChannel };
  private ignoreLeft: number;

  constructor(opts: RepeaterOptions = {}) {
    super();
    this.o = {
      mecon: opts.mecon ?? true,
      role: opts.role ?? 'repeater',
      roleReply: opts.roleReply === undefined ? `> ${opts.role === 'room' ? 'room_server' : (opts.role ?? 'repeater')}` : opts.roleReply,
      boardName: opts.boardName ?? 'Synthetic Board',
      ver: opts.ver ?? (opts.mecon === false ? 'v1.18.0 (Build: 1 Jan 2026)' : 'v1.18.0-mecon.0.0.0-synthetic (Build: 1 Jan 2026)'),
      capabilities: opts.capabilities ?? ['hello', 'status.get', 'clock.get', 'config.get'],
      helloRole: opts.helloRole,
      managementChannel: opts.managementChannel,
    };
    this.ignoreLeft = opts.ignoreFirstLines ?? 0;
  }

  receiveBytes(bytes: Uint8Array): void {
    for (const b of bytes) {
      const c = String.fromCharCode(b);
      if (c === '\n') continue;
      if (c === '\r') {
        this.emitBytes(new TextEncoder().encode('\r\n'));
        const l = this.line;
        this.line = '';
        if (this.ignoreLeft > 0) {
          this.ignoreLeft -= 1; // still booting: the line is lost
          continue;
        }
        this.run(l);
        continue;
      }
      this.line += c;
      // Only the seven characters of the interface prefix are echoed; the rest of an interface line is not.
      const iface = (MECON_LINE_PREFIX + '{').startsWith(this.line.slice(0, 8)) || this.line.startsWith(MECON_LINE_PREFIX);
      if (!(iface && this.line.length > MECON_LINE_PREFIX.length)) this.emitBytes(Uint8Array.of(b));
    }
  }

  private say(s: string): void {
    this.emitBytes(new TextEncoder().encode(`${s}\r\n`));
  }

  private run(line: string): void {
    this.lines.push(line);
    if (line.startsWith(MECON_LINE_PREFIX)) {
      if (this.o.mecon && line.startsWith(`${MECON_LINE_PREFIX}{`)) return this.iface(line.slice(MECON_LINE_PREFIX.length));
      return this.say('  -> Unknown command');
    }
    switch (line) {
      case 'ver':
        return this.say(`  -> ${this.o.ver}`);
      case 'board':
        return this.say(`  -> ${this.o.boardName}`);
      case 'get role':
        return this.o.roleReply === null ? this.say('  -> Unknown command') : this.say(`  -> ${this.o.roleReply}`);
      case 'get mecon.version':
        return this.say(this.o.mecon ? `  -> > ${this.o.ver.split(' ')[0]}` : '  -> Unknown command');
      default:
        this.executed.push(line);
        return this.say('  -> Unknown command');
    }
  }

  private iface(json: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(json) as Envelope;
    } catch {
      return this.say(`${MECON_LINE_PREFIX}${JSON.stringify({ v: 1, id: '', status: 'invalid' })}`);
    }
    this.ifaceRequests.push(env);
    let reply: Envelope;
    if (env.op === 'hello') reply = helloEnvelope(String(env.id), this.o.helloRole ?? (this.o.role === 'room' ? 'room' : this.o.role), { capabilities: this.o.managementChannel ? [...this.o.capabilities, 'channel.list'] : this.o.capabilities, hardware: this.o.boardName });
    else if (env.op === 'channel.list' && this.o.managementChannel) reply = answerList(env, { channels: [this.o.managementChannel], contacts: [] })!;
    else if (env.op === 'status.get') reply = { v: 1, id: env.id, status: 'ok', result: { uptime_s: 12 } };
    else if (env.op === 'clock.get') reply = { v: 1, id: env.id, status: 'ok', result: { epoch: null } };
    else {
      this.executed.push(`iface:${String(env.op)}`);
      reply = { v: 1, id: env.id, status: 'unknown-op' };
    }
    this.say(`${MECON_LINE_PREFIX}${JSON.stringify(reply)}`);
  }
}

/** A port with something on it that answers nothing, optionally printing boot noise on open. */
export class MockSilentDevice extends BasePeer {
  readonly received: Uint8Array[] = [];
  constructor(private readonly noise = '') {
    super();
  }
  linkUp(): void {
    super.linkUp();
    if (this.noise) this.emitBytes(new TextEncoder().encode(this.noise));
  }
  receiveBytes(bytes: Uint8Array): void {
    this.received.push(bytes.slice());
  }
}
