import { BleAdapter, type AttemptFacts, type BleAdapterOptions, type BleSnapshot, type LinkState } from '../ble/adapter';
import { BleError, type BleErrorCode, type DisconnectReason } from '../ble/transport';
import { CompanionSerialTransport } from './companionSerial';
import { detectDevice, type Capability, type DetectedDevice, type DetectOptions } from './detect';
import type { ByteTransport } from './serialBytes';

/**
 * One USB device, any role. Owns the byte pipe, identifies the device after
 * the port opens (detect.ts) and exposes only what the detected capabilities
 * allow. The Companion messaging driver (the existing adapter, with its send
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

export class DeviceSession {
  private snap: SessionSnapshot;
  private listeners = new Set<() => void>();
  private adapter: BleAdapter | null = null;
  private adapterTransport: CompanionSerialTransport | null = null;
  private offAdapter: (() => void) | null = null;
  private offs: Array<() => void> = [];
  private busy = false;

  constructor(
    private readonly bytes: ByteTransport,
    private readonly opts: SessionOptions = {},
  ) {
    this.snap = { link: bytes.support === 'supported' ? 'idle' : 'unsupported', phase: 'idle', lastError: null, detected: null, companion: null };
    this.offs.push(bytes.onDisconnect((r) => this.onLinkEnd(r)));
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
    const chooser = this.bytes.requestDevice();
    return this.afterChooser(chooser).finally(() => {
      this.busy = false;
    });
  }

  /** Reopens the port the user chose earlier. An explicit user action; the session never does it by itself. */
  reconnect(): Promise<SessionResult> {
    const l = this.snap.link;
    if (this.busy || l === 'connected' || l === 'requesting') return Promise.resolve({ ok: false, error: 'busy' });
    if (!this.bytes.chosen) return Promise.resolve({ ok: false, error: 'not_connected' });
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
      await this.bytes.connect();
    } catch (e) {
      const code = e instanceof BleError ? e.code : 'connect_failed';
      this.set({ link: code === 'port_busy' ? 'busy' : 'disconnected', phase: 'failed', lastError: code });
      return { ok: false, error: code };
    }
    this.set({ link: 'connected', phase: 'detecting' });
    const detected = await detectDevice(this.bytes, this.opts.detect);
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
      this.adapterTransport = new CompanionSerialTransport(this.bytes, { stallMs: this.opts.stallMs });
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
    await this.bytes.disconnect();
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

  dispose(): void {
    this.offAdapter?.();
    this.adapter?.dispose();
    this.adapterTransport?.dispose();
    for (const off of this.offs.splice(0)) off();
    this.listeners.clear();
  }
}
