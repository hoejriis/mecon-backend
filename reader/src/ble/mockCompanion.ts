import { BleError, type BleDeviceInfo, type BleTransport, type TransportSupport, type Unsubscribe } from './transport';
import { CMD, ERR, PUSH, RESP, bytesOfHex, hexOf, KEY_PREFIX_SIZE } from './protocol';
import { fixtureBytes } from './fixtures/frames';
import { CMD_MECON, MeconReassembler, encodeMeconFrames, type Envelope } from '../device/meconIface';
import { helloEnvelope } from '../device/sim/hello';
import { DEFAULT_CONTACTS, answerList, defaultTables, type ListTables, type SimChannel, type SimContact } from '../device/sim/lists';

/**
 * SIMULATED Companion (GATT peer) for the supported command subset. Everything
 * here is synthetic: no real device, no Bluetooth, no RF. Results obtained with
 * it are "SIMULATED, not Android hardware verified".
 */

export interface MockFaults {
  /** requestDevice outcome: ok | denied (NotAllowedError) | cancel (chooser closed). */
  requestDevice: 'ok' | 'denied' | 'cancel';
  /** gatt.connect outcome: ok | timeout (never settles) | fail (NetworkError). */
  connect: 'ok' | 'timeout' | 'fail';
  /**
   * When a send command (direct or channel) is written, drop the link. `before_device`: the
   * device never processed it. `after_device`: the device processed it (and "transmitted")
   * but the link dropped before any reply. The Reader cannot tell the two apart.
   */
  disconnectOnSend: null | 'before_device' | 'after_device';
  /** Process the next send but never notify its reply (SENT / OK): outcome unknown to the app. */
  dropNextSendReply: boolean;
  /** Process the next send normally but never notify the recipient ACK. */
  dropNextAck: boolean;
  /** Deliver every notification twice. */
  duplicateNotifications: boolean;
  /** The device has forgotten its contacts since the app read them: a direct send answers NOT_FOUND. */
  forgetContacts: boolean;
}

export const NO_FAULTS = (): MockFaults => ({
  requestDevice: 'ok',
  connect: 'ok',
  disconnectOnSend: null,
  dropNextSendReply: false,
  dropNextAck: false,
  duplicateNotifications: false,
  forgetContacts: false,
});

export interface RfRecord {
  kind: 'direct' | 'channel';
  target: string;
  text: string;
}

export interface MockCompanionOptions {
  /** Reply to a channel send with RESP_CODE_SENT instead of RESP_CODE_OK. */
  channelReply?: 'ok' | 'sent';
  /** Delay in ms before the recipient ACK push. Default 0 (next macrotask). */
  ackDelayMs?: number;
  /** Suggested ACK timeout the device reports in RESP_CODE_SENT. Default 4000. */
  suggestedTimeoutMs?: number;
  /**
   * Answer the MECON device interface carried as 0x7F frames (CMD_MECON). Default false: a stock
   * Companion, which answers an unknown command with RESP_CODE_ERR / ERR_CODE_UNSUPPORTED_CMD.
   */
  mecon?: boolean;
  /** Role string the simulated hello reports (default 'companion'). The BLE device name never feeds it. */
  helloRole?: string;
  capabilities?: string[];
  firmware?: string;
  hardware?: string;
  /** Answer hello `refused` / `untrusted-transport`, as a link the firmware does not trust would (AUTHORITY.md section 3.5). */
  helloRefused?: boolean;
  /** The BLE device name the chooser shows (default 'MeshCore-Synthetic'). Detection must never use it. */
  deviceName?: string;
  /** A device that answers nothing at all, to anything: the "unknown device" case. */
  silent?: boolean;
  /**
   * The native contact table (what the Companion driver reads with GET_CONTACTS, and what
   * `contact.list` answers). Default: the two fixture contacts.
   */
  contacts?: SimContact[];
  /**
   * Answer `channel.list` and `contact.list` over the interface (a MECON Companion; needs `mecon`) and
   * list them in the hello capabilities. Give the channel table, or `true` for the default one. Absent:
   * the device does not list them and answers `unknown-op`, like a build without them.
   */
  channels?: SimChannel[] | true;
  /** Used slots per `channel.list` page (the firmware pages by 8). */
  channelPageSize?: number;
}

/** A native contact frame (RESP_CODE_CONTACT) built from the fixture's Alice frame with another key and name. */
function contactFrame(c: SimContact): Uint8Array {
  const f = fixtureBytes('respContactAlice').slice();
  f.set(bytesOfHex(c.key), 1);
  f.fill(0, 100, 132);
  f.set(new TextEncoder().encode(c.name).subarray(0, 31), 100);
  return f;
}

const le32 = (n: number): Uint8Array => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);

export class MockCompanion {
  faults: MockFaults = NO_FAULTS();
  /** Every frame the app wrote, as the device saw it (copies). */
  readonly writes: Uint8Array[] = [];
  /** What the simulated radio "transmitted" (device-side truth, invisible to the app). */
  readonly rf: RfRecord[] = [];
  linked = false;
  private nextTag = 0x1000;
  private notifyCbs = new Set<(f: Uint8Array) => void>();
  private lossCbs = new Set<(reason: string) => void>();
  private queue: Uint8Array[] = [];
  private readonly ifaceReasm = new MeconReassembler();
  /** Every 0x7F request envelope the device received (parsed). */
  readonly ifaceRequests: Envelope[] = [];

  /** The tables the interface lists answer from, or null when this device does not offer them. */
  lists(): ListTables | null {
    if (!this.opts.channels) return null;
    // One copy per device, so a test may change the device's tables after it connected.
    this.tables ??= {
      channels: (this.opts.channels === true ? defaultTables().channels : this.opts.channels).map((c) => ({ ...c })),
      contacts: (this.opts.contacts ?? defaultTables().contacts).map((c) => ({ ...c })),
      channelPageSize: this.opts.channelPageSize,
    };
    return this.tables;
  }
  private tables: ListTables | undefined;

  /** Capabilities for hello: the configured ones plus the list operations this device answers. */
  helloCapabilities(base?: string[]): string[] | undefined {
    if (!this.lists()) return base;
    const caps = base ?? ['hello', 'status.get', 'clock.get', 'config.get', 'sub.start', 'stream.health'];
    return [...caps, ...['channel.list', 'contact.list'].filter((o) => !caps.includes(o))];
  }

  private nativeContacts(): SimContact[] {
    return this.opts.contacts ?? DEFAULT_CONTACTS;
  }

  get deviceName(): string {
    return this.opts.deviceName ?? 'MeshCore-Synthetic';
  }

  constructor(private readonly opts: MockCompanionOptions = {}) {}

  /** Writes of send commands only (CMD_SEND_TXT_MSG / CMD_SEND_CHANNEL_TXT_MSG). */
  sendWrites(): Uint8Array[] {
    return this.writes.filter((w) => w[0] === CMD.SEND_TXT_MSG || w[0] === CMD.SEND_CHANNEL_TXT_MSG);
  }

  onNotify(cb: (f: Uint8Array) => void): Unsubscribe {
    this.notifyCbs.add(cb);
    return () => this.notifyCbs.delete(cb);
  }
  onLinkLost(cb: (reason: string) => void): Unsubscribe {
    this.lossCbs.add(cb);
    return () => this.lossCbs.delete(cb);
  }

  linkUp(): void {
    this.linked = true;
  }

  /** The link drops (device, OS, browser or app side). */
  dropLink(reason = 'link_lost'): void {
    if (!this.linked) return;
    this.linked = false;
    for (const cb of [...this.lossCbs]) cb(reason);
  }

  /** Android backgrounds the page or the OS drops the connection. */
  simulateBackground(): void {
    this.dropLink('background');
  }

  /** The host page went away (reload): no event reaches anyone, the device just loses the link. */
  simulateHostReload(): void {
    this.linked = false;
    this.notifyCbs.clear();
    this.lossCbs.clear();
  }

  /** An incoming direct message queued on the device, with a MSG_WAITING push. */
  queueDirectFromAlice(text: string, timestamp = 1700000300): void {
    const body = new TextEncoder().encode(text);
    const head = Uint8Array.of(RESP.CONTACT_MSG_RECV_V3, 0x28, 0, 0, ...bytesOfHex('a1'.repeat(KEY_PREFIX_SIZE)), 0xff, 0);
    this.queue.push(Uint8Array.of(...head, ...le32(timestamp), ...body));
    this.emit(Uint8Array.of(PUSH.MSG_WAITING));
  }

  queueChannelMessage(channelIndex: number, text: string, timestamp = 1700000400): void {
    const body = new TextEncoder().encode(text);
    this.queue.push(Uint8Array.of(RESP.CHANNEL_MSG_RECV_V3, 0, 0, 0, channelIndex, 0xff, 0, ...le32(timestamp), ...body));
    this.emit(Uint8Array.of(PUSH.MSG_WAITING));
  }

  private emit(frame: Uint8Array): void {
    if (!this.linked) return;
    const copies = this.faults.duplicateNotifications ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const c = frame.slice();
      queueMicrotask(() => {
        if (!this.linked) return;
        for (const cb of [...this.notifyCbs]) cb(c.slice());
      });
    }
  }

  /** The device receives one GATT write. */
  receive(frame: Uint8Array): void {
    const f = frame.slice();
    this.writes.push(f);
    if (this.opts.silent) return;
    const code = f[0];
    if (code === CMD_MECON && this.opts.mecon) return this.onMecon(f);
    const isSend = code === CMD.SEND_TXT_MSG || code === CMD.SEND_CHANNEL_TXT_MSG;
    if (isSend && this.faults.disconnectOnSend === 'before_device') {
      this.dropLink('mid_send_before_device');
      return;
    }
    switch (code) {
      case CMD.APP_START:
        this.emit(fixtureBytes('respSelfInfo'));
        break;
      case CMD.DEVICE_QUERY:
        this.emit(fixtureBytes('respDeviceInfo'));
        break;
      case CMD.GET_CONTACTS:
        if (!this.opts.contacts) {
          this.emit(fixtureBytes('respContactsStart'));
          this.emit(fixtureBytes('respContactAlice'));
          this.emit(fixtureBytes('respContactBob'));
          this.emit(fixtureBytes('respEndOfContacts'));
          break;
        }
        this.emit(Uint8Array.of(RESP.CONTACTS_START, ...le32(this.nativeContacts().length)));
        for (const c of this.nativeContacts()) this.emit(contactFrame(c));
        this.emit(fixtureBytes('respEndOfContacts'));
        break;
      case CMD.SYNC_NEXT_MESSAGE: {
        const next = this.queue.shift();
        this.emit(next ?? Uint8Array.of(RESP.NO_MORE_MESSAGES));
        break;
      }
      case CMD.SEND_TXT_MSG:
        this.onSendDirect(f);
        break;
      case CMD.SEND_CHANNEL_TXT_MSG:
        this.onSendChannel(f);
        break;
      default:
        this.emit(Uint8Array.of(RESP.ERR, ERR.UNSUPPORTED_CMD));
    }
  }

  private onMecon(f: Uint8Array): void {
    const text = this.ifaceReasm.push(f);
    if (text === null) return;
    const env = JSON.parse(text) as Envelope;
    this.ifaceRequests.push(env);
    const id = String(env.id);
    let reply: Envelope;
    if (env.op === 'hello') {
      reply = this.opts.helloRefused
        ? { v: 1, id, status: 'refused', error: 'untrusted-transport' }
        : helloEnvelope(id, this.opts.helloRole ?? 'companion', { capabilities: this.helloCapabilities(this.opts.capabilities), firmware: this.opts.firmware, hardware: this.opts.hardware });
    } else if (env.op === 'status.get') reply = { v: 1, id, status: 'ok', result: { uptime_s: 12 } };
    else if (env.op === 'clock.get') reply = { v: 1, id, status: 'ok', result: { epoch: null } };
    else reply = (this.lists() ? answerList(env, this.lists()!) : null) ?? { v: 1, id, status: 'unknown-op' };
    for (const fr of encodeMeconFrames(f[1]!, JSON.stringify(reply))) this.emit(fr);
  }

  private onSendDirect(f: Uint8Array): void {
    const prefix = hexOf(f.subarray(7, 13));
    const known = !this.faults.forgetContacts && this.nativeContacts().some((c) => c.key.startsWith(prefix));
    if (!known) {
      this.emit(Uint8Array.of(RESP.ERR, ERR.NOT_FOUND));
      return;
    }
    this.rf.push({ kind: 'direct', target: prefix, text: new TextDecoder().decode(f.subarray(13)) });
    const tag = this.nextTag++;
    const reply = Uint8Array.of(RESP.SENT, 1, ...le32(tag), ...le32(this.opts.suggestedTimeoutMs ?? 4000));
    const ack = Uint8Array.of(PUSH.SEND_CONFIRMED, ...le32(tag), ...le32(1234));
    this.afterProcessing(reply, ack);
  }

  private onSendChannel(f: Uint8Array): void {
    const idx = f[2]!;
    if (idx >= 8) {
      this.emit(Uint8Array.of(RESP.ERR, ERR.NOT_FOUND));
      return;
    }
    this.rf.push({ kind: 'channel', target: String(idx), text: new TextDecoder().decode(f.subarray(7)) });
    const reply = this.opts.channelReply === 'sent' ? Uint8Array.of(RESP.SENT, 1, ...le32(this.nextTag++), ...le32(this.opts.suggestedTimeoutMs ?? 4000)) : Uint8Array.of(RESP.OK);
    this.afterProcessing(reply, null);
  }

  private afterProcessing(reply: Uint8Array, ack: Uint8Array | null): void {
    if (this.faults.disconnectOnSend === 'after_device') {
      this.dropLink('mid_send_after_device');
      return;
    }
    if (this.faults.dropNextSendReply) this.faults.dropNextSendReply = false;
    else this.emit(reply);
    if (ack) {
      if (this.faults.dropNextAck) this.faults.dropNextAck = false;
      else setTimeout(() => this.emit(ack), this.opts.ackDelayMs ?? 0);
    }
  }
}

/** BleTransport over a MockCompanion, with the connection-phase faults. */
export class MockTransport implements BleTransport {
  readonly kind = 'ble' as const;
  readonly support: TransportSupport;
  private frameCbs = new Set<(f: Uint8Array) => void>();
  private discCbs = new Set<() => void>();
  private offs: Array<() => void> = [];
  private chosen: BleDeviceInfo | null = null;
  private connectedNow = false;

  constructor(
    readonly peer: MockCompanion,
    opts: { unsupported?: boolean } = {},
  ) {
    this.support = opts.unsupported ? 'unsupported' : 'supported';
  }

  async requestDevice(): Promise<BleDeviceInfo> {
    if (this.support === 'unsupported') throw new BleError('unsupported');
    if (this.peer.faults.requestDevice === 'denied') throw new BleError('permission_denied');
    if (this.peer.faults.requestDevice === 'cancel') throw new BleError('chooser_cancelled');
    this.chosen = { id: 'synthetic-device-1', name: this.peer.deviceName };
    return this.chosen;
  }

  async connect(): Promise<void> {
    if (!this.chosen) throw new BleError('connect_failed');
    if (this.peer.faults.connect === 'timeout') return new Promise<void>(() => undefined);
    if (this.peer.faults.connect === 'fail') throw new BleError('connect_failed');
    for (const off of this.offs) off();
    this.offs = [
      this.peer.onNotify((f) => {
        for (const cb of [...this.frameCbs]) cb(f);
      }),
      this.peer.onLinkLost(() => {
        this.connectedNow = false;
        for (const cb of [...this.discCbs]) cb();
      }),
    ];
    this.peer.linkUp();
    this.connectedNow = true;
  }

  async write(frame: Uint8Array): Promise<void> {
    if (!this.connectedNow) throw new BleError('not_connected');
    this.peer.receive(frame);
  }

  async disconnect(): Promise<void> {
    if (this.connectedNow) this.peer.dropLink('app_disconnect');
  }

  onFrame(cb: (f: Uint8Array) => void): Unsubscribe {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }
  onDisconnect(cb: () => void): Unsubscribe {
    this.discCbs.add(cb);
    return () => this.discCbs.delete(cb);
  }
}
