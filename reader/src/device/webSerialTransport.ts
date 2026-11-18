import { BleError, type DisconnectReason, type TransportSupport, type Unsubscribe } from '../ble/transport';
import { SERIAL_BAUD_RATE } from '../ble/serialFraming';
import type { ByteTransport, SerialPortInfo } from './serialBytes';

// Minimal structural types: TypeScript's DOM lib has no Web Serial types.
export interface WsReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
export interface WsWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
}
export interface WsPort extends EventTarget {
  readable: { getReader(): WsReader } | null;
  writable: { getWriter(): WsWriter } | null;
  open(options: { baudRate: number; bufferSize?: number; flowControl?: 'none' | 'hardware' }): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
export interface WsSerial extends EventTarget {
  requestPort(options?: unknown): Promise<WsPort>;
}

export function getSerial(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): WsSerial | null {
  const n = nav as { serial?: WsSerial; isSecureContext?: boolean } | undefined;
  const s = n?.serial;
  if (!s || typeof s.requestPort !== 'function') return null;
  // Web Serial exists only in secure contexts; a page that says otherwise is not one we trust it in.
  const secure = n?.isSecureContext ?? (typeof isSecureContext === 'undefined' ? true : isSecureContext);
  return secure === false ? null : s;
}

export function detectSerialSupport(nav?: unknown): TransportSupport {
  return getSerial(nav) ? 'supported' : 'unsupported';
}

/** Largest single write. A wrapped Companion frame is at most 179 bytes; an interface line at most 1,600 plus prefix. */
export const MAX_WRITE_BYTES = 2048;
/** Errors the Web Serial spec says leave the port usable (the stream can be re-read). */
const RECOVERABLE_READ_ERRORS = new Set(['BreakError', 'FramingError', 'BufferOverrunError', 'ParityError']);

interface Activation {
  isActive: boolean;
}

export interface WebSerialOptions {
  baudRate?: number;
  writeTimeoutMs?: number;
}

/**
 * Web Serial byte transport for a laptop Chromium browser. Not hardware
 * verified: see the simulation matrix.
 *
 * - The chooser (requestPort) is called synchronously from a user gesture.
 * - Only the port the user chose is ever opened. After a loss (the `disconnect`
 *   event, a fatal read error) nothing reopens it: connect() is an explicit
 *   call, and the browser's `connect` event on navigator.serial is ignored.
 * - Open uses 115200 baud, the rate the firmware source opens; a native USB CDC
 *   port ignores it (UNVERIFIED on hardware). DTR/RTS are left as the browser
 *   sets them on open (UNVERIFIED whether any board resets on open).
 * - No USB vendor filter: public firmware runs on boards with several USB
 *   bridges, and the list is unverified. The user picks the port.
 * - Each write is one writer.write() of at most MAX_WRITE_BYTES, with a timeout.
 */
export class WebSerialTransport implements ByteTransport {
  readonly kind = 'usb' as const;
  readonly support: TransportSupport;
  private readonly serial: WsSerial | null;
  private readonly nav: unknown;
  private readonly baudRate: number;
  private readonly writeTimeoutMs: number;
  private port: WsPort | null = null;
  chosen: SerialPortInfo | null = null;
  private opened = false;
  private reader: WsReader | null = null;
  private writer: WsWriter | null = null;
  private epoch = 0;
  private byteCbs = new Set<(c: Uint8Array) => void>();
  private discCbs = new Set<(r?: DisconnectReason) => void>();
  /** Read errors the port recovered from (diagnostic only). */
  recoveredReadErrors = 0;

  constructor(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator, opts: WebSerialOptions = {}) {
    this.nav = nav;
    this.serial = getSerial(nav);
    this.support = this.serial ? 'supported' : 'unsupported';
    this.baudRate = opts.baudRate ?? SERIAL_BAUD_RATE;
    this.writeTimeoutMs = opts.writeTimeoutMs ?? 3000;
  }

  isOpen(): boolean {
    return this.opened;
  }

  async requestDevice(): Promise<SerialPortInfo> {
    if (!this.serial) throw new BleError('unsupported', 'navigator.serial is not available');
    const act = (this.nav as { userActivation?: Activation } | undefined)?.userActivation;
    if (act && !act.isActive) throw new BleError('gesture_required', 'requestPort must be called from a user gesture');
    let port: WsPort;
    try {
      port = await this.serial.requestPort({});
    } catch (e) {
      throw mapRequestPortError(e);
    }
    this.detach();
    this.port = port;
    port.addEventListener('disconnect', this.onPortDisconnect);
    let info: { usbVendorId?: number; usbProductId?: number } = {};
    try {
      info = port.getInfo();
    } catch {
      /* optional */
    }
    this.chosen = { id: 'serial-port', name: null, usbVendorId: info.usbVendorId, usbProductId: info.usbProductId };
    return this.chosen;
  }

  async connect(): Promise<void> {
    const port = this.port;
    if (!port) throw new BleError('connect_failed', 'no port selected');
    if (this.opened) return;
    try {
      await port.open({ baudRate: this.baudRate, flowControl: 'none' });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? '';
      const msg = e instanceof Error ? e.message : 'open failed';
      // InvalidStateError: the port is already open (by this page elsewhere, or the browser says so).
      // NetworkError: the OS refused; another program holding the port is a common cause (UNVERIFIED which error Chrome gives for another tab).
      if (name === 'InvalidStateError') throw new BleError('port_busy', msg);
      throw new BleError('connect_failed', name === 'NetworkError' ? `${msg} (the port may be in use by another program)` : msg);
    }
    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined);
      throw new BleError('connect_failed', 'port has no streams');
    }
    // DTR and RTS always together, both asserted (public firmware owner, Issue #30): unequal
    // lines trigger the auto-reset circuit on boards such as the Heltec V3, and nRF52 boards
    // stay silent without DTR. Best effort: a failure here does not fail the connection.
    await port.setSignals?.({ dataTerminalReady: true, requestToSend: true }).catch(() => undefined);
    this.opened = true;
    const epoch = ++this.epoch;
    this.writer = port.writable.getWriter();
    void this.readLoop(port, epoch);
  }

  private async readLoop(port: WsPort, epoch: number): Promise<void> {
    while (epoch === this.epoch && this.opened && port.readable) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (epoch !== this.epoch) return;
          if (done) {
            this.lost('closed');
            return;
          }
          if (value && value.length) {
            const copy = value.slice();
            for (const cb of [...this.byteCbs]) cb(copy.slice());
          }
        }
      } catch (e) {
        if (epoch !== this.epoch) return;
        const name = (e as { name?: string } | null)?.name ?? '';
        if (RECOVERABLE_READ_ERRORS.has(name)) {
          this.recoveredReadErrors++;
          try {
            reader.releaseLock();
          } catch {
            /* stream already errored */
          }
          continue; // take a fresh reader on the same port
        }
        this.lost(name === 'NetworkError' ? 'port_lost' : 'error');
        return;
      }
    }
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0 || bytes.length > MAX_WRITE_BYTES) throw new BleError('frame_too_large');
    const w = this.writer;
    if (!w || !this.opened) throw new BleError('not_connected');
    const copy = bytes.slice();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        w.write(copy),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('write timed out')), this.writeTimeoutMs);
        }),
      ]);
    } catch (e) {
      throw new BleError('write_failed', e instanceof Error ? e.message : 'write failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.opened) return;
    this.lost('closed');
  }

  onBytes(cb: (chunk: Uint8Array) => void): Unsubscribe {
    this.byteCbs.add(cb);
    return () => this.byteCbs.delete(cb);
  }

  onDisconnect(cb: (reason?: DisconnectReason) => void): Unsubscribe {
    this.discCbs.add(cb);
    return () => this.discCbs.delete(cb);
  }

  private detach(): void {
    this.port?.removeEventListener('disconnect', this.onPortDisconnect);
    this.port = null;
    this.chosen = null;
  }

  private onPortDisconnect = (): void => {
    this.lost('port_lost');
  };

  /** Ends the link once; releases the streams; tells listeners. Never reopens anything. */
  private lost(reason: DisconnectReason): void {
    if (!this.opened) return;
    this.opened = false;
    this.epoch++;
    const { reader, writer, port } = this;
    this.reader = null;
    this.writer = null;
    void (async () => {
      try {
        await reader?.cancel();
      } catch {
        /* gone */
      }
      try {
        reader?.releaseLock();
      } catch {
        /* gone */
      }
      try {
        writer?.releaseLock();
      } catch {
        /* gone */
      }
      try {
        await port?.close();
      } catch {
        /* gone */
      }
    })();
    for (const cb of [...this.discCbs]) cb(reason);
  }
}

export function mapRequestPortError(e: unknown): BleError {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'NotFoundError') return new BleError('chooser_cancelled', msg); // chooser closed, or no port to choose
  if (name === 'SecurityError' && /gesture/i.test(msg)) return new BleError('gesture_required', msg);
  if (name === 'NotAllowedError' || name === 'SecurityError') return new BleError('permission_denied', msg);
  if (name === 'NotSupportedError') return new BleError('unsupported', msg);
  return new BleError('connect_failed', msg);
}
