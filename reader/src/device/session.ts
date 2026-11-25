import { BleAdapter, type AttemptFacts, type BleAdapterOptions, type BleSnapshot, type LinkState } from '../ble/adapter';
import { BleError, type BleDeviceInfo, type BleErrorCode, type CompanionTransport, type DisconnectReason, type TransportSupport } from '../ble/transport';
import { CompanionSerialTransport } from './companionSerial';
import { detectBleDevice, detectDevice, type Capability, type DetectedDevice, type DetectOptions } from './detect';
import { MAX_CHANNEL_PAGES, parseChannelPage } from './channelList';
import { matchDestination, sameDestination, type BackendDest, type Destination, type DestinationToken, type DeviceChannelRef, type DeviceChannelsState, type DeviceContactRef, type MapOutcome, type SessionMapping } from './destinations';
import { MeconReassembler, buildRequest, encodeMeconFrames, type Envelope, type ReadArgs } from './meconIface';
import type { ByteTransport } from './serialBytes';
import { OfflineSendBlocked, offlineSendGuard } from '../offline/gate';
import type { PermitQuery } from '../offline/lease';
import { assertOperationAllowed, linkTrustOf, type LinkTrust } from './trust';

/**
 * One device, any role, over USB (a byte pipe) or BLE (a frame link). Owns the
 * link, identifies the device after it opens (detect.ts) and exposes only what
 * the detected capabilities allow. Both links produce the same snapshot and the
 * same DetectedDevice; the only differences are `detected.transport` and the
 * link's `trust` (USB: trusted; BLE: unknown, because a browser cannot read the
 * PIN state, so only class `read` operations are ever requested there, see
 * trust.ts). The Companion messaging driver (the existing adapter, with its send
 * safety) is attached only when the device answered Companion binary frames,
 * and `sendDirect`/`sendChannel` refuse with `unsupported_capability`, writing
 * nothing, on a device without that capability.
 *
 * Every local send passes `authorize()` first: the offline guard (online: the
 * server decides and the lease is not consulted; offline: the lease must permit
 * this operation, identity, device and channel), then a check that the connected
 * device is the sending identity's own. The guard sits here, at the call that
 * writes to the device, so a caller that skips the UI is refused the same way.
 *
 * Out of scope here: choosing between USB, BLE and Backend in a composer
 * (messaging/localPath.ts), and the interface's own message operations (the
 * Companion binary driver stays the messaging path until those are wired).
 */
export type SessionPhase = 'idle' | 'choosing' | 'opening' | 'detecting' | 'ready' | 'closed' | 'failed';

export interface SessionSnapshot {
  link: LinkState;
  phase: SessionPhase;
  lastError: BleErrorCode | null;
  /** How far the link is trusted. USB: trusted. BLE: unknown (the PIN state is not observable). */
  trust: LinkTrust;
  detected: DetectedDevice | null;
  /** The Companion driver's own facts (attempts, contacts, inbox), when attached. */
  companion: BleSnapshot | null;
  /** The device's own channel list (`channel.list`, class read), read once the link is ready. Never typed in, never guessed. */
  deviceChannels: DeviceChannelsState;
}

export interface SessionOptions {
  detect?: DetectOptions;
  companion?: Partial<Omit<BleAdapterOptions, 'transport'>>;
  stallMs?: number;
}

/**
 * What a local send must carry. `PermitQuery` is what the offline lease is asked
 * (operation, identity, device, channel); `identityKeyPrefix` is the sending
 * identity's public key prefix, which must match the connected device's own key.
 */
export interface LocalSendAuth extends PermitQuery {
  identityKeyPrefix: string;
  /** The Backend target id this send is for. The destination token must have been issued for exactly this target. */
  targetId: string;
}

export interface SessionResult {
  ok: boolean;
  error: BleErrorCode | null;
}

/** What the session needs from either kind of link. */
interface Link {
  readonly kind: 'usb' | 'ble';
  readonly support: TransportSupport;
  readonly trust: LinkTrust;
  requestDevice(): Promise<unknown>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onDisconnect(cb: (r?: DisconnectReason) => void): () => void;
  /** True once the user has chosen a device, so reconnect needs no chooser. */
  hasChosen(): boolean;
  detect(opts: DetectOptions | undefined): Promise<DetectedDevice>;
  /** The transport the Companion adapter runs on. Created once. */
  companionTransport(stallMs: number | undefined): CompanionTransport & { dispose(): void };
}

const BUILDABLE: readonly string[] = ['hello', 'status.get', 'clock.get', 'channel.list'];

export function isByteTransport(t: ByteTransport | CompanionTransport): t is ByteTransport {
  return typeof (t as ByteTransport).writeBytes === 'function';
}

function usbLink(bytes: ByteTransport): Link {
  return {
    kind: 'usb',
    support: bytes.support,
    trust: linkTrustOf('usb'),
    requestDevice: () => bytes.requestDevice(),
    connect: () => bytes.connect(),
    disconnect: () => bytes.disconnect(),
    onDisconnect: (cb) => bytes.onDisconnect(cb),
    hasChosen: () => !!bytes.chosen,
    detect: (o) => detectDevice(bytes, o),
    companionTransport: (stallMs) => new CompanionSerialTransport(bytes, { stallMs }),
  };
}

/**
 * The Companion adapter's view of a BLE transport once the session has chosen and connected
 * it: no second chooser, and connect() only reconnects when the link is down. The adapter's
 * send safety is untouched: it still gets every frame as one write.
 */
class ChosenBleTransport implements CompanionTransport {
  readonly kind = 'ble' as const;
  private up = true;
  private readonly off: () => void;
  constructor(
    private readonly inner: CompanionTransport,
    private readonly info: BleDeviceInfo | null,
  ) {
    this.off = inner.onDisconnect(() => {
      this.up = false;
    });
  }
  get support(): TransportSupport {
    return this.inner.support;
  }
  requestDevice(): Promise<BleDeviceInfo> {
    return this.info ? Promise.resolve(this.info) : this.inner.requestDevice();
  }
  async connect(): Promise<void> {
    if (this.up) return;
    await this.inner.connect();
    this.up = true;
  }
  write(frame: Uint8Array): Promise<void> {
    return this.inner.write(frame);
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  onFrame(cb: (frame: Uint8Array) => void): () => void {
    return this.inner.onFrame(cb);
  }
  onDisconnect(cb: (reason?: DisconnectReason) => void): () => void {
    return this.inner.onDisconnect(cb);
  }
  /** Called when the session (re)connects the inner transport itself. */
  markUp(): void {
    this.up = true;
  }
  dispose(): void {
    this.off();
  }
}

function bleLink(t: CompanionTransport): Link {
  let info: BleDeviceInfo | null = null;
  let wrapped: ChosenBleTransport | null = null;
  return {
    kind: 'ble',
    support: t.support,
    trust: linkTrustOf('ble'),
    requestDevice: async () => {
      info = await t.requestDevice();
      return info;
    },
    connect: async () => {
      await t.connect();
      wrapped?.markUp();
    },
    disconnect: () => t.disconnect(),
    onDisconnect: (cb) => t.onDisconnect(cb),
    hasChosen: () => info !== null,
    detect: (o) => detectBleDevice(t, { stepTimeoutMs: o?.stepTimeoutMs, onStep: o?.onStep, trust: linkTrustOf('ble') }),
    companionTransport: () => (wrapped ??= new ChosenBleTransport(t, info)),
  };
}

export class DeviceSession {
  private snap: SessionSnapshot;
  private listeners = new Set<() => void>();
  private adapter: BleAdapter | null = null;
  private adapterTransport: (CompanionTransport & { dispose(): void }) | null = null;
  private readonly link: Link;
  private offAdapter: (() => void) | null = null;
  private offs: Array<() => void> = [];
  private busy = false;
  private reqSeq = 0;
  /** Every destination token this session issued. A token not in here (forged, from another session) is refused. */
  private readonly minted = new WeakSet<object>();

  constructor(
    transport: ByteTransport | CompanionTransport,
    private readonly opts: SessionOptions = {},
  ) {
    this.link = isByteTransport(transport) ? usbLink(transport) : bleLink(transport);
    this.snap = { link: this.link.support === 'supported' ? 'idle' : 'unsupported', phase: 'idle', lastError: null, trust: this.link.trust, detected: null, companion: null, deviceChannels: { status: 'idle' } };
    this.offs.push(this.link.onDisconnect((r) => this.onLinkEnd(r)));
  }

  /** The link this session drives. */
  get path(): 'usb' | 'ble' {
    return this.link.kind;
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): SessionSnapshot => this.snap;

  private set(p: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  /** Whether the connected device supports an operation. False whenever the link is not up. */
  can(cap: Capability): boolean {
    const s = this.snap;
    if (s.link !== 'connected' || s.phase !== 'ready' || !s.detected) return false;
    if (!s.detected.capabilities.includes(cap)) return false;
    if (cap === 'message.send.direct' || cap === 'message.send.channel') return !!this.adapter && s.companion?.helloComplete === true;
    return true;
  }

  /**
   * Chooser, open, identify. Call it directly from a click handler: the first
   * thing it does is bytes.requestDevice(), with nothing awaited before it.
   */
  connect(): Promise<SessionResult> {
    const l = this.snap.link;
    if (l === 'unsupported') return Promise.resolve({ ok: false, error: 'unsupported' });
    if (this.busy || l === 'connected') return Promise.resolve({ ok: false, error: 'busy' });
    this.busy = true;
    this.set({ link: 'requesting', phase: 'choosing', lastError: null, detected: null, deviceChannels: { status: 'idle' } });
    const chooser = this.link.requestDevice();
    return this.afterChooser(chooser).finally(() => {
      this.busy = false;
    });
  }

  /** Reopens the port or device the user chose earlier. An explicit user action; the session never does it by itself. */
  reconnect(): Promise<SessionResult> {
    const l = this.snap.link;
    if (this.busy || l === 'connected' || l === 'requesting') return Promise.resolve({ ok: false, error: 'busy' });
    if (!this.link.hasChosen()) return Promise.resolve({ ok: false, error: 'not_connected' });
    this.busy = true;
    this.set({ link: 'requesting', phase: 'opening', lastError: null, detected: null, deviceChannels: { status: 'idle' } });
    return this.openAndIdentify().finally(() => {
      this.busy = false;
    });
  }

  private async afterChooser(chooser: Promise<unknown>): Promise<SessionResult> {
    try {
      await chooser;
    } catch (e) {
      const code = e instanceof BleError ? e.code : 'connect_failed';
      const link: LinkState = code === 'permission_denied' || code === 'gesture_required' ? 'denied' : code === 'unsupported' ? 'unsupported' : 'idle';
      this.set({ link, phase: 'idle', lastError: code });
      return { ok: false, error: code };
    }
    this.set({ phase: 'opening' });
    return this.openAndIdentify();
  }

  private async openAndIdentify(): Promise<SessionResult> {
    try {
      await this.link.connect();
    } catch (e) {
      const code = e instanceof BleError ? e.code : 'connect_failed';
      this.set({ link: code === 'port_busy' ? 'busy' : 'disconnected', phase: 'failed', lastError: code });
      return { ok: false, error: code };
    }
    this.set({ link: 'connected', phase: 'detecting' });
    const detected = await this.link.detect(this.opts.detect);
    if (detected.linkLost) {
      this.set({ detected, phase: 'closed' });
      return { ok: false, error: 'disconnected' };
    }
    this.set({ detected });
    if (detected.companionBinary) {
      const err = await this.attachCompanion();
      if (err) {
        this.set({ phase: 'ready', lastError: err });
        return { ok: false, error: err };
      }
    }
    this.set({ phase: 'ready' });
    await this.refreshChannels();
    return { ok: true, error: null };
  }

  private async attachCompanion(): Promise<BleErrorCode | null> {
    if (!this.adapter) {
      this.adapterTransport = this.link.companionTransport(this.opts.stallMs);
      this.adapter = new BleAdapter({ ...this.opts.companion, transport: this.adapterTransport });
      this.offAdapter = this.adapter.subscribe(() => this.set({ companion: this.adapter!.getSnapshot() }));
      this.set({ companion: this.adapter.getSnapshot() });
      const r = await this.adapter.connect();
      return r.ok ? null : r.error;
    }
    const r = await this.adapter.reconnect();
    return r.ok ? null : r.error;
  }

  async disconnect(): Promise<void> {
    await this.link.disconnect();
  }

  private onLinkEnd(reason?: DisconnectReason): void {
    const wasLive = this.snap.link === 'connected' || this.snap.link === 'requesting';
    if (wasLive) this.set({ link: reason === 'port_lost' ? 'unplugged' : 'disconnected', phase: 'closed', deviceChannels: { status: 'idle' } });
  }

  // -- capability-gated operations ------------------------------------------
  private require(cap: Capability): BleAdapter {
    if (!this.can(cap) || !this.adapter) throw new BleError('unsupported_capability', `this device does not support ${cap}`);
    return this.adapter;
  }

  /**
   * Refuses, before anything reaches the adapter or the device, a send the offline rules or the
   * device identity do not allow. Throws OfflineSendBlocked (the guard said no) or BleError
   * 'bad_argument' / 'wrong_device'. Nothing is written in any of those cases.
   */
  private authorize(kind: 'direct' | 'channel', auth: LocalSendAuth): void {
    if (auth.op !== (kind === 'direct' ? 'send.direct' : 'send.channel')) throw new BleError('bad_argument', 'the lease operation does not match this send');
    if (kind === 'channel' && auth.channelId === undefined) throw new BleError('bad_argument', 'a channel send must name its channel for the lease check');
    const decision = offlineSendGuard(auth);
    if (!decision.allowed) throw new OfflineSendBlocked(decision);
    const own = this.snap.companion?.selfInfo?.publicKey?.toLowerCase();
    const want = auth.identityKeyPrefix.toLowerCase();
    if (!own || want === '' || !own.startsWith(want)) throw new BleError('wrong_device', 'the connected device is not the one this identity belongs to');
  }

  /** The device's own contacts, as the Companion driver last read them. */
  private deviceContacts(): DeviceContactRef[] {
    return (this.snap.companion?.contacts ?? []).map((c) => ({ publicKey: c.publicKey, name: c.name }));
  }

  private resolve(dest: BackendDest, pick: string | undefined): MapOutcome {
    return matchDestination(dest, this.deviceContacts(), this.snap.deviceChannels, pick);
  }

  /**
   * The only way to obtain a destination for a send. Matches the Backend target against what this
   * device itself reports (its contact keys, its channel list) and issues a token for exactly that
   * target, or refuses with the reason. `pick` is accepted only to choose among the contacts that
   * already match the key prefix; it can never name a contact or slot that does not.
   */
  mapDestination(dest: BackendDest, pick?: string): SessionMapping {
    const kind = dest.kind === 'contact' ? 'direct' : 'channel';
    if (!this.can(kind === 'direct' ? 'message.send.direct' : 'message.send.channel')) {
      return { ok: false, code: 'not_ready', reason: 'This device cannot send that kind of message right now.', candidates: [] };
    }
    const out = this.resolve(dest, pick);
    if (!out.ok) return out;
    const token: DestinationToken = Object.freeze({ kind, targetId: dest.targetId, dest, pick, destination: out.destination });
    this.minted.add(token);
    return { ok: true, destination: out.destination, token };
  }

  /**
   * Re-verifies a token at the call that writes: issued here, for this very Backend target, and the
   * matcher still gives the same destination against the device's current tables. Throws
   * 'unmapped_destination' otherwise; nothing has been written at that point.
   */
  private verifyToken(kind: 'direct' | 'channel', token: DestinationToken | undefined, auth: LocalSendAuth): Destination {
    const bad = (why: string): never => {
      throw new BleError('unmapped_destination', `refused: ${why}`);
    };
    if (!token || typeof token !== 'object' || !this.minted.has(token)) return bad('the destination was not chosen by the device mapping for this target');
    if (token.kind !== kind) return bad('the destination is for another kind of message');
    if (!auth.targetId || token.targetId !== auth.targetId) return bad('the destination was mapped for another target');
    const now = this.resolve(token.dest, token.pick);
    if (!now.ok || !sameDestination(now.destination, token.destination)) return bad('the device no longer matches this target to that destination');
    return now.destination;
  }

  async sendDirect(input: { clientDraftId: string; clientAttemptId: string; text: string; auth: LocalSendAuth; mapping: DestinationToken }): Promise<AttemptFacts> {
    const { auth, mapping, ...rest } = input;
    const adapter = this.require('message.send.direct');
    this.authorize('direct', auth);
    const d = this.verifyToken('direct', mapping, auth);
    if (d.kind !== 'direct') throw new BleError('unmapped_destination', 'refused: not a contact destination');
    return adapter.sendDirect({ ...rest, contactKey: d.contactKey });
  }

  async sendChannel(input: { clientDraftId: string; clientAttemptId: string; text: string; auth: LocalSendAuth; mapping: DestinationToken }): Promise<AttemptFacts> {
    const { auth, mapping, ...rest } = input;
    const adapter = this.require('message.send.channel');
    this.authorize('channel', auth);
    const d = this.verifyToken('channel', mapping, auth);
    if (d.kind !== 'channel') throw new BleError('unmapped_destination', 'refused: not a channel destination');
    return adapter.sendChannel({ ...rest, channelIndex: d.slot });
  }

  /**
   * Reads the device's channel list with `channel.list` (class read: no key, no secret; allowed on the
   * cable and on a trusted link, never requested where the device did not list it). A device without
   * it (a stock Companion, a link the device does not trust) leaves local channel sends unavailable,
   * with the reason. Nothing here ever writes to the device.
   */
  async refreshChannels(): Promise<DeviceChannelsState> {
    const set = (deviceChannels: DeviceChannelsState): DeviceChannelsState => {
      this.set({ deviceChannels });
      return deviceChannels;
    };
    const d = this.snap.detected;
    if (!d || this.snap.link !== 'connected' || this.snap.phase !== 'ready') return set({ status: 'idle' });
    if (!d.interfaceOps.includes('channel.list')) {
      if (d.interfaceRefused) return set({ status: 'unavailable', reason: "the device does not trust this link (default PIN or Hardened), so it refused its interface. Pair with the device's own PIN." });
      if (d.firmware !== 'mecon') return set({ status: 'unavailable', reason: 'this device is not running MECON firmware (a stock Companion), which has no channel list the Reader can read.' });
      return set({ status: 'unavailable', reason: `this ${d.role} does not offer a channel list.` });
    }
    const all: DeviceChannelRef[] = [];
    let cursor: number | null = null;
    try {
      for (let i = 0; i < MAX_CHANNEL_PAGES; i++) {
        const env: Envelope = await this.request('channel.list', 3000, cursor === null ? undefined : { cursor });
        const page = parseChannelPage(env);
        if (!page.ok) return set({ status: 'error', reason: page.reason });
        all.push(...page.channels);
        if (page.next === null) {
          if (new Set(all.map((c) => c.slot)).size !== all.length) return set({ status: 'error', reason: 'The device listed the same channel slot twice.' });
          return set({ status: 'ready', channels: all });
        }
        if (cursor !== null && page.next <= cursor) return set({ status: 'error', reason: 'The device channel list did not advance.' });
        cursor = page.next;
      }
      return set({ status: 'error', reason: 'The device channel list was longer than the Reader reads.' });
    } catch (e) {
      return set({ status: 'error', reason: e instanceof BleError ? `the device did not answer channel.list (${e.code}).` : 'the device channel list could not be read.' });
    }
  }

  /**
   * Sends one interface request and returns the device's answer envelope. The order of the
   * checks matters: the link's trust gate comes first, so a class the link may not be asked
   * for is refused before anything else is looked at and nothing is written; then the detected
   * capability (an operation the device did not list answers `unknown-op`, so it is not sent);
   * then the carriage. Only requests the Reader can build are sent (`hello`, `status.get`,
   * `clock.get`, `channel.list` with its cursor). The console-line carriage (Repeater, Room server over USB) is not wired here.
   */
  async request(op: string, timeoutMs = 3000, args?: ReadArgs): Promise<Envelope> {
    assertOperationAllowed(this.snap.trust, op);
    const d = this.snap.detected;
    if (this.snap.link !== 'connected' || this.snap.phase !== 'ready' || !d) throw new BleError('not_connected');
    if (!d.interfaceOps.includes(op)) throw new BleError('unsupported_capability', `this device did not list ${op}`);
    if (!BUILDABLE.includes(op)) throw new BleError('unsupported_capability', `${op} is not built by this Reader`);
    const t = this.adapterTransport;
    if (d.carriage !== 'companion-frames' || !t) throw new BleError('unsupported_capability', 'interface requests are only wired over Companion frames');
    const id = `rq-${++this.reqSeq}`;
    const reasm = new MeconReassembler();
    let off = (): void => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fail!: (e: BleError) => void;
    const answer = new Promise<Envelope>((resolve, reject) => {
      fail = reject;
      off = t.onFrame((f) => {
        const text = reasm.push(f);
        if (text === null) return;
        try {
          const env = JSON.parse(text) as Envelope;
          if (env.id !== id) return;
          clearTimeout(timer);
          resolve(env);
        } catch {
          /* not ours */
        }
      });
    });
    answer.catch(() => undefined);
    try {
      // Each write is bounded (default 60 s; same option as the adapter's), so a transport whose write never settles cannot hang request().
      const writeMs = this.opts.companion?.writeTimeoutMs ?? 60000;
      for (const f of encodeMeconFrames(1, buildRequest(id, op as 'hello', args))) {
        let wt: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            t.write(f),
            new Promise<never>((_, rej) => {
              wt = setTimeout(() => {
                console.warn(`[reader] write_timeout during ${op} after ${writeMs} ms`);
                rej(new BleError('write_timeout', `write of ${op} not completed`));
              }, writeMs);
            }),
          ]);
        } finally {
          clearTimeout(wt);
        }
      }
      // The reply timer starts after the writes: a write can block (serial flow control), and that is not a slow device.
      timer = setTimeout(() => {
        console.warn(`[reader] response_timeout: no answer to ${op} within ${timeoutMs} ms`);
        fail(new BleError('response_timeout', `no answer to ${op}`));
      }, timeoutMs);
      return await answer;
    } finally {
      clearTimeout(timer);
      off();
    }
  }

  dispose(): void {
    this.offAdapter?.();
    this.adapter?.dispose();
    this.adapterTransport?.dispose();
    for (const off of this.offs.splice(0)) off();
    this.listeners.clear();
  }
}
