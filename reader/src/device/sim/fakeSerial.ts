import type { SerialPeer } from './serialPeers';

/**
 * A fake `navigator.serial` (Web Serial shape) backed by a SerialPeer, with real
 * ReadableStream/WritableStream so the transport's reader loop and writer run as
 * they would in Chromium. Used by unit tests (jsdom) and bundled into the
 * Playwright init script. SIMULATED: not hardware verified.
 */
function err(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export interface SerialFaults {
  /** requestPort: ok | cancel (NotFoundError) | denied (NotAllowedError). */
  requestPort: 'ok' | 'cancel' | 'denied';
  /** open: ok | busy (InvalidStateError) | fail (NetworkError) | hang. */
  open: 'ok' | 'busy' | 'fail';
  /** Make the next write never settle. */
  hangNextWrite: boolean;
  /** Make the next read fail with a recoverable BufferOverrunError, then carry on. */
  recoverableReadErrorNext: boolean;
}
export const NO_SERIAL_FAULTS = (): SerialFaults => ({ requestPort: 'ok', open: 'ok', hangNextWrite: false, recoverableReadErrorNext: false });

export interface FakeSerialHandle {
  peer: SerialPeer;
  faults: SerialFaults;
  requestPortCalls(): number;
  openCalls(): number;
  closeCalls(): number;
  /** The cable is pulled: streams error, `disconnect` fires. */
  unplug(): void;
  /** The cable goes back in: the browser fires `connect` on navigator.serial. Nothing is reopened. */
  replug(): void;
  /** Permission revoked in browser settings: same `disconnect` event. */
  revoke(): void;
  /** Writes the host made to the port, as the port saw them. */
  hostWrites: Uint8Array[];
}

export function installFakeSerial(target: object, peer: SerialPeer, info: { usbVendorId?: number; usbProductId?: number } = { usbVendorId: 0x303a, usbProductId: 0x1001 }): FakeSerialHandle {
  const faults = NO_SERIAL_FAULTS();
  let requests = 0;
  let opens = 0;
  let closes = 0;
  const hostWrites: Uint8Array[] = [];
  const serial = new EventTarget();
  const port = new EventTarget() as EventTarget & { readable: ReadableStream<Uint8Array> | null; writable: WritableStream<Uint8Array> | null } & Record<string, unknown>;
  port.readable = null;
  port.writable = null;
  let isOpen = false;
  let closing = false;
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let offOut: (() => void) | null = null;
  const gestureActive = (): boolean => {
    const ua = (target as { userActivation?: { isActive: boolean } }).userActivation;
    return ua ? ua.isActive : true;
  };

  const cleanup = () => {
    isOpen = false;
    offOut?.();
    offOut = null;
  };
  const unplugNow = (reason: string) => {
    if (!isOpen) {
      port.dispatchEvent(new Event('disconnect'));
      serial.dispatchEvent(new Event('disconnect'));
      return;
    }
    void reason;
    try {
      ctl?.error(err('NetworkError', 'The device has been lost.'));
    } catch {
      /* already closed */
    }
    port.readable = null;
    port.writable = null;
    cleanup();
    port.dispatchEvent(new Event('disconnect'));
    serial.dispatchEvent(new Event('disconnect'));
  };
  peer.onLinkLost((r) => {
    if (!closing && isOpen) unplugNow(r);
  });

  port.getInfo = () => ({ ...info });
  port.open = async () => {
    opens++;
    if (isOpen) throw err('InvalidStateError', 'The port is already open.');
    if (faults.open === 'busy') throw err('InvalidStateError', 'The port is already open.');
    if (faults.open === 'fail') throw err('NetworkError', 'Failed to open serial port.');
    isOpen = true;
    closing = false;
    port.readable = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        offOut = peer.onOutput((b) => {
          if (faults.recoverableReadErrorNext) {
            faults.recoverableReadErrorNext = false;
            // The spec's recoverable errors error the current stream; a fresh readable follows.
            const old = ctl;
            port.readable = new ReadableStream<Uint8Array>({
              start(c2) {
                ctl = c2;
              },
            });
            try {
              old?.error(err('BufferOverrunError', 'Buffer overrun'));
            } catch {
              /* ignore */
            }
          }
          try {
            ctl?.enqueue(b);
          } catch {
            /* closed */
          }
        });
      },
      cancel() {
        offOut?.();
        offOut = null;
      },
    });
    port.writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (!isOpen) throw err('NetworkError', 'The device has been lost.');
        if (faults.hangNextWrite) {
          faults.hangNextWrite = false;
          return new Promise<void>(() => undefined);
        }
        const copy = chunk.slice();
        hostWrites.push(copy);
        peer.receiveBytes(copy);
      },
    });
    peer.linkUp();
  };
  port.close = async () => {
    closes++;
    if (!isOpen) return;
    closing = true;
    port.readable = null;
    port.writable = null;
    cleanup();
    peer.dropLink('app_close');
  };

  const nav = {
    async requestPort() {
      requests++;
      if (!gestureActive()) throw err('SecurityError', 'Must be handling a user gesture to show a permission request.');
      if (faults.requestPort === 'denied') throw err('NotAllowedError', 'Serial permission has been blocked.');
      if (faults.requestPort === 'cancel') throw err('NotFoundError', 'No port selected by the user.');
      return port;
    },
    async getPorts() {
      return [port];
    },
    addEventListener: serial.addEventListener.bind(serial),
    removeEventListener: serial.removeEventListener.bind(serial),
    dispatchEvent: serial.dispatchEvent.bind(serial),
  };
  Object.defineProperty(target, 'serial', { value: nav, configurable: true });

  return {
    peer,
    faults,
    requestPortCalls: () => requests,
    openCalls: () => opens,
    closeCalls: () => closes,
    unplug: () => peer.dropLink('unplug'),
    replug: () => serial.dispatchEvent(new Event('connect')),
    revoke: () => unplugNow('revoked'),
    hostWrites,
  };
}
