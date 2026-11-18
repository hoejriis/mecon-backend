import { BleAdapter, type AttemptFacts, type BleAdapterOptions, type BleSnapshot, type LinkState } from '../ble/adapter';
import { BleError, type BleDeviceInfo, type BleErrorCode, type CompanionTransport, type DisconnectReason, type TransportSupport } from '../ble/transport';
import { CompanionSerialTransport } from './companionSerial';
import { detectBleDevice, detectDevice, type Capability, type DetectedDevice, type DetectOptions } from './detect';
import { MeconReassembler, buildRequest, encodeMeconFrames, type Envelope } from './meconIface';
import type { ByteTransport } from './serialBytes';
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
 * Out of scope here: choosing between USB, BLE and Backend in a composer
 * (Issue #6), and the interface's own message operations (the Companion binary
 * driver stays the messaging path until those are wired).
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
}

export interface SessionOptions {
  detect?: DetectOptions;
  companion?: Partial<Omit<BleAdapterOptions, 'transport'>>;
  stallMs?: number;
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

const BUILDABLE: readonly string[] = ['hello', 'status.get', 'clock.get'];

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

  constructor(
    transport: ByteTransport | CompanionTransport,
    private readonly opts: SessionOptions = {},
  ) {
    this.link = isByteTransport(transport) ? usbLink(transport) : bleLink(transport);
    this.snap = { link: this.link.support === 'supported' ? 'idle' : 'unsupported', phase: 'idle', lastError: null, trust: this.link.trust, detected: null, companion: null };
    this.offs.push(this.link.onDisconnect((r) => this.onLinkEnd(r)));
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
    this.set({ link: 'requesting', phase: 'choosing', lastError: null, detected: null });
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
    this.set({ link: 'requesting', phase: 'opening', lastError: null, detected: null });
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
    if (wasLive) this.set({ link: reason === 'port_lost' ? 'unplugged' : 'disconnected', phase: 'closed' });
  }

  // -- capability-gated operations ------------------------------------------
  private require(cap: Capability): BleAdapter {
    if (!this.can(cap) || !this.adapter) throw new BleError('unsupported_capability', `this device does not support ${cap}`);
    return this.adapter;
  }

  async sendDirect(input: { clientDraftId: string; clientAttemptId: string; contactKey: string; text: string }): Promise<AttemptFacts> {
    return this.require('message.send.direct').sendDirect(input);
  }

  async sendChannel(input: { clientDraftId: string; clientAttemptId: string; channelIndex: number; text: string }): Promise<AttemptFacts> {
    return this.require('message.send.channel').sendChannel(input);
  }

  /**
   * Sends one interface request and returns the device's answer envelope. The order of the
   * checks matters: the link's trust gate comes first, so a class the link may not be asked
   * for is refused before anything else is looked at and nothing is written; then the detected
   * capability (an operation the device did not list answers `unknown-op`, so it is not sent);
   * then the carriage. Only requests the Reader can build are sent (`hello`, `status.get`,
   * `clock.get`). The console-line carriage (Repeater, Room server over USB) is not wired here.
   */
  async request(op: string, timeoutMs = 3000): Promise<Envelope> {
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
    const answer = new Promise<Envelope>((resolve, reject) => {
      timer = setTimeout(() => reject(new BleError('response_timeout', `no answer to ${op}`)), timeoutMs);
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
    try {
      for (const f of encodeMeconFrames(1, buildRequest(id, op as 'hello'))) await t.write(f);
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
