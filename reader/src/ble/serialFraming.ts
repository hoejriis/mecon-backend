/**
 * Companion serial ("USB") frame wrapper and streaming deframer. Transport
 * agnostic: bytes in, frames out, and the reverse. The payload inside a frame
 * is the same Companion frame the BLE transport carries (see protocol.ts).
 *
 * SOURCES (MIT-licensed code and documentation only; no GPL client was read):
 *  - meshcore-dev/MeshCore @ 75b04ef06def54b348400cb1b138afb6749ffd4f
 *      src/helpers/ArduinoSerialInterface.cpp   writeFrame / checkRecvFrame: the wrapper
 *        is a marker byte, a 16-bit little-endian payload length, then the payload.
 *        Device to app uses '>' (0x3E); app to device uses '<' (0x3C). The device's
 *        own receive loop skips every byte outside a frame while idle, and a zero
 *        length returns it to idle.
 *      src/helpers/ArduinoSerialInterface.h     receive buffer is MAX_FRAME_SIZE bytes
 *      src/helpers/BaseSerialInterface.h        MAX_FRAME_SIZE = 176
 *      examples/companion_radio/main.cpp        setup() calls Serial.begin(115200)
 *  - hoejriis/mecon-firmware @ 5a729ef6127869d404fdffd7e5e08ddbb72a87b5
 *      src/helpers/ArduinoSerialInterface.cpp   same wrapper; adds a gate that holds
 *        a frame back, or on nRF52 drops it whole, when the host is not reading
 *      src/helpers/SerialTxGate.h               "a partial frame would desynchronise
 *        the host's framing": frames are written whole or not at all
 *      docs/contract/DEVICE_INTERFACE.md section 7   "A board's USB UART can lose
 *        bytes under mesh traffic": the reason the deframer must resynchronise
 *
 * The wrapper has no checksum. The deframer therefore cannot detect a corrupted
 * length that still looks plausible, or corrupted payload bytes; it can only
 * (a) skip bytes that are not a frame start, (b) refuse lengths above
 * MAX_FRAME_SIZE and rescan from the byte after the marker, and (c) let the
 * caller drop a stalled partial frame with reset(). A frame that is cut short
 * by lost bytes swallows the start of the next frame until its length is met;
 * the Companion protocol above it tolerates that (replies are matched to the
 * command in flight, unknown frames are ignored, a send reply that never
 * arrives becomes `unknown`).
 *
 * Differences from the firmware's receive loop, on purpose: the firmware
 * truncates an oversize frame to MAX_FRAME_SIZE after consuming the whole
 * declared length (so a corrupted length eats up to 64 KiB of the stream). This
 * deframer instead refuses the length at once and rescans, so it never waits on
 * or buffers more than MAX_FRAME_SIZE bytes. A zero-length frame carries no
 * Companion command and is skipped, as the firmware does.
 *
 * UNVERIFIED: no real board was read. That the same wrapper is used on every
 * USB Companion build (ESP32-S3 native USB, nRF52 CDC, CP210x/CH340 bridges),
 * that boot-time debug text never precedes frames (it would be skipped as
 * garbage here), and the baud rate for non-native-USB boards (115200 is what
 * the source opens; native USB CDC ignores it).
 */
import { FrameEncodeError, MAX_FRAME_SIZE } from './protocol';

/** App to device marker, '<'. */
export const SERIAL_MARKER_TO_DEVICE = 0x3c;
/** Device to app marker, '>'. */
export const SERIAL_MARKER_FROM_DEVICE = 0x3e;
/** Marker + 16-bit little-endian length. */
export const SERIAL_HEADER_SIZE = 3;
/** The rate the firmware opens its serial port at (UNVERIFIED on hardware; native USB CDC ignores it). */
export const SERIAL_BAUD_RATE = 115200;

/** Wraps one Companion frame for the wire. Throws FrameEncodeError for an empty or oversize payload. */
export function encodeSerialFrame(payload: Uint8Array, marker: number = SERIAL_MARKER_TO_DEVICE): Uint8Array {
  if (payload.length === 0) throw new FrameEncodeError('bad_argument', 'empty frame');
  if (payload.length > MAX_FRAME_SIZE) throw new FrameEncodeError('frame_too_large', `frame ${payload.length} > ${MAX_FRAME_SIZE}`);
  const out = new Uint8Array(SERIAL_HEADER_SIZE + payload.length);
  out[0] = marker;
  out[1] = payload.length & 0xff;
  out[2] = payload.length >> 8;
  out.set(payload, SERIAL_HEADER_SIZE);
  return out;
}

export interface DeframerStats {
  /** Bytes skipped while looking for a frame start. */
  skippedBytes: number;
  /** Declared lengths above MAX_FRAME_SIZE that were refused. */
  oversizeLengths: number;
  /** Zero-length frames skipped. */
  emptyFrames: number;
  /** Bytes of a partial frame thrown away by reset(). */
  discardedPartialBytes: number;
  framesOut: number;
}

const IDLE = 0;
const LEN_LO = 1;
const LEN_HI = 2;
const BODY = 3;

/**
 * Streaming deframer. Feed it whatever chunks the port delivers: split frames,
 * several frames in one chunk and garbage between frames are all handled. Memory
 * is one fixed MAX_FRAME_SIZE buffer whatever the input.
 */
export class SerialDeframer {
  private state = IDLE;
  private lenLo = 0;
  private want = 0;
  private have = 0;
  private readonly buf = new Uint8Array(MAX_FRAME_SIZE);
  readonly stats: DeframerStats = { skippedBytes: 0, oversizeLengths: 0, emptyFrames: 0, discardedPartialBytes: 0, framesOut: 0 };

  constructor(private readonly marker: number = SERIAL_MARKER_FROM_DEVICE) {}

  /** Bytes of a frame that has started and not finished (header included). 0 when idle. */
  get pendingBytes(): number {
    if (this.state === IDLE) return 0;
    return this.state === LEN_LO ? 1 : this.state === LEN_HI ? 2 : SERIAL_HEADER_SIZE + this.have;
  }

  /** Returns the complete frames in this chunk, each a private copy. */
  feed(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < chunk.length; i++) this.step(chunk[i]!, out);
    return out;
  }

  /** Drops a partial frame (disconnect, or a stall). Returns the bytes discarded. */
  reset(): number {
    const n = this.pendingBytes;
    this.stats.discardedPartialBytes += n;
    this.state = IDLE;
    this.have = 0;
    return n;
  }

  private step(b: number, out: Uint8Array[]): void {
    switch (this.state) {
      case IDLE:
        if (b === this.marker) this.state = LEN_LO;
        else this.stats.skippedBytes++;
        return;
      case LEN_LO:
        this.lenLo = b;
        this.state = LEN_HI;
        return;
      case LEN_HI: {
        const len = this.lenLo | (b << 8);
        if (len === 0) {
          this.stats.emptyFrames++;
          this.state = IDLE;
        } else if (len > MAX_FRAME_SIZE) {
          // Refuse at once; the two length bytes may themselves hold the next marker, so rescan them.
          this.stats.oversizeLengths++;
          this.state = IDLE;
          this.stats.skippedBytes++; // the marker that started this false frame
          this.step(this.lenLo, out);
          this.step(b, out);
        } else {
          this.want = len;
          this.have = 0;
          this.state = BODY;
        }
        return;
      }
      default:
        this.buf[this.have++] = b;
        if (this.have >= this.want) {
          out.push(this.buf.slice(0, this.want));
          this.stats.framesOut++;
          this.state = IDLE;
          this.have = 0;
        }
    }
  }
}
