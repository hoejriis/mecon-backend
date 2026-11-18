import { FrameEncodeError } from '../ble/protocol';
import { SerialDeframer, encodeSerialFrame } from '../ble/serialFraming';
import { BleError, type BleDeviceInfo, type CompanionTransport, type DisconnectReason, type TransportSupport, type Unsubscribe } from '../ble/transport';
import type { ByteTransport } from './serialBytes';

/**
 * The Companion binary driver's transport over a byte pipe: wraps each outgoing
 * Companion frame in the serial wrapper and deframes the incoming stream, so the
 * adapter sees the same frames over USB as over BLE. Used only once detection
 * found a device that speaks Companion frames.
 *
 * Resync: garbage and oversize lengths are handled by the deframer. A frame
 * that stalls part-way (lost bytes) is dropped when the next chunk arrives
 * after `stallMs`, so it cannot swallow the next frame forever. 1500 ms is a
 * choice, not a measured value (UNVERIFIED on hardware).
 */
export class CompanionSerialTransport implements CompanionTransport {
  readonly kind = 'usb' as const;
  private readonly deframer = new SerialDeframer();
  private readonly frameCbs = new Set<(f: Uint8Array) => void>();
  private readonly discCbs = new Set<(r?: DisconnectReason) => void>();
  private lastChunkAt = 0;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly bytes: ByteTransport,
    private readonly opts: { stallMs?: number; now?: () => number } = {},
  ) {
    this.offs.push(bytes.onBytes((c) => this.onChunk(c)));
    this.offs.push(
      bytes.onDisconnect((reason) => {
        this.deframer.reset();
        for (const cb of [...this.discCbs]) cb(reason);
      }),
    );
  }

  get support(): TransportSupport {
    return this.bytes.support;
  }

  /** The port is chosen by the session before the adapter runs; this returns it without a chooser. */
  requestDevice(): Promise<BleDeviceInfo> {
    return this.bytes.chosen ? Promise.resolve(this.bytes.chosen) : this.bytes.requestDevice();
  }

  async connect(): Promise<void> {
    if (!this.bytes.isOpen()) await this.bytes.connect();
  }

  async write(frame: Uint8Array): Promise<void> {
    let wrapped: Uint8Array;
    try {
      wrapped = encodeSerialFrame(frame);
    } catch (e) {
      if (e instanceof FrameEncodeError) throw new BleError(e.reason === 'bad_argument' ? 'bad_argument' : e.reason, e.message);
      throw e;
    }
    await this.bytes.writeBytes(wrapped);
  }

  disconnect(): Promise<void> {
    return this.bytes.disconnect();
  }

  onFrame(cb: (frame: Uint8Array) => void): Unsubscribe {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }

  onDisconnect(cb: (reason?: DisconnectReason) => void): Unsubscribe {
    this.discCbs.add(cb);
    return () => this.discCbs.delete(cb);
  }

  get deframerStats() {
    return { ...this.deframer.stats };
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private onChunk(chunk: Uint8Array): void {
    const now = (this.opts.now ?? Date.now)();
    if (this.deframer.pendingBytes > 0 && now - this.lastChunkAt > (this.opts.stallMs ?? 1500)) this.deframer.reset();
    this.lastChunkAt = now;
    for (const f of this.deframer.feed(chunk)) for (const cb of [...this.frameCbs]) cb(f.slice());
  }
}
