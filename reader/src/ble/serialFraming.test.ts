import { describe, expect, it } from 'vitest';
import { MAX_FRAME_SIZE } from './protocol';
import { SERIAL_BAUD_RATE, SerialDeframer, encodeSerialFrame } from './serialFraming';

// Byte fixtures are written out by hand from the wrapper definition in
// ArduinoSerialInterface.cpp (marker, u16 LE length, payload); none is produced by the codec under test.
const GT = 0x3e; // '>' device to app
const LT = 0x3c; // '<' app to device
const f = (...b: number[]) => Uint8Array.from(b);
const hex = (a: Uint8Array) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');

describe('serial wrapper encode', () => {
  it('app start style frame: "<", length 2 LE, payload', () => {
    expect(hex(encodeSerialFrame(f(0x16, 0x03)))).toBe('3c02001603');
  });
  it('a 176-byte payload encodes a length of 0x00b0 little-endian', () => {
    const w = encodeSerialFrame(new Uint8Array(176).fill(7));
    expect(Array.from(w.subarray(0, 3))).toEqual([LT, 0xb0, 0x00]);
    expect(w.length).toBe(179);
  });
  it('refuses empty and oversize payloads', () => {
    expect(() => encodeSerialFrame(new Uint8Array(0))).toThrow();
    expect(() => encodeSerialFrame(new Uint8Array(MAX_FRAME_SIZE + 1))).toThrow();
  });
  it('opens the port at 115200 (the rate the firmware source opens)', () => expect(SERIAL_BAUD_RATE).toBe(115200));
});

describe('deframer', () => {
  it('one frame in one chunk', () => {
    const d = new SerialDeframer();
    expect(d.feed(f(GT, 3, 0, 0x0a, 0x0b, 0x0c)).map(hex)).toEqual(['0a0b0c']);
  });
  it('a frame split at every byte boundary', () => {
    const wire = f(GT, 3, 0, 1, 2, 3);
    for (let cut = 1; cut < wire.length; cut++) {
      const d = new SerialDeframer();
      const out = [...d.feed(wire.subarray(0, cut)), ...d.feed(wire.subarray(cut))];
      expect(out.map(hex), `cut at ${cut}`).toEqual(['010203']);
    }
  });
  it('byte at a time', () => {
    const d = new SerialDeframer();
    const out: string[] = [];
    for (const b of f(GT, 2, 0, 9, 8, GT, 1, 0, 7)) out.push(...d.feed(f(b)).map(hex));
    expect(out).toEqual(['0908', '07']);
  });
  it('several frames coalesced in one chunk', () => {
    const d = new SerialDeframer();
    expect(d.feed(f(GT, 1, 0, 0xaa, GT, 2, 0, 0xbb, 0xcc, GT, 1, 0, 0xdd)).map(hex)).toEqual(['aa', 'bbcc', 'dd']);
  });
  it('skips garbage before and between frames', () => {
    const d = new SerialDeframer();
    const out = d.feed(f(0x00, 0xff, 0x41, GT, 1, 0, 0xaa, 0x0d, 0x0a, 0x42, GT, 1, 0, 0xbb));
    expect(out.map(hex)).toEqual(['aa', 'bb']);
    expect(d.stats.skippedBytes).toBe(6);
  });
  it('a zero length is skipped, not a frame', () => {
    const d = new SerialDeframer();
    expect(d.feed(f(GT, 0, 0, GT, 1, 0, 5)).map(hex)).toEqual(['05']);
    expect(d.stats.emptyFrames).toBe(1);
  });
  it('an oversize length (177 and 0xFFFF) is refused at once and the stream resyncs', () => {
    const d = new SerialDeframer();
    // length 0xffff would swallow 64 KiB if believed; the next real frame must still arrive.
    const out = d.feed(f(GT, 0xff, 0xff, GT, 2, 0, 0x11, 0x22));
    expect(out.map(hex)).toEqual(['1122']);
    expect(d.stats.oversizeLengths).toBe(1);
    const out2 = d.feed(f(GT, 177, 0, GT, 1, 0, 0x33));
    expect(out2.map(hex)).toEqual(['33']);
    expect(d.stats.oversizeLengths).toBe(2);
  });
  it('a marker hidden inside a refused length is found again (rescan)', () => {
    const d = new SerialDeframer();
    // false header "> 0xFF '>'" : the second length byte is a real marker starting the next frame "> 01 00 AA" -> needs lenLo=1
    expect(d.feed(f(GT, 0xff, GT, 1, 0, 0xaa)).map(hex)).toEqual(['aa']);
  });
  it('never buffers more than MAX_FRAME_SIZE whatever the input (huge declared lengths, endless stream)', () => {
    const d = new SerialDeframer();
    const junk = new Uint8Array(99_999);
    for (let i = 0; i < junk.length; i += 3) junk.set([GT, 0xff, 0x7f], i); // every header declares ~32 KiB
    expect(d.feed(junk)).toEqual([]);
    expect(d.stats.oversizeLengths).toBeGreaterThan(1000);
    expect(d.pendingBytes).toBeLessThanOrEqual(3);
  });
  it('accepts exactly MAX_FRAME_SIZE', () => {
    const d = new SerialDeframer();
    const wire = new Uint8Array(3 + 176).fill(0x55);
    wire.set([GT, 176, 0]);
    const out = d.feed(wire);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(176);
  });
  it('a partial frame at disconnect is discarded and counted; the next stream starts clean', () => {
    const d = new SerialDeframer();
    expect(d.feed(f(GT, 5, 0, 1, 2))).toEqual([]);
    expect(d.pendingBytes).toBe(5);
    expect(d.reset()).toBe(5);
    expect(d.stats.discardedPartialBytes).toBe(5);
    expect(d.feed(f(GT, 1, 0, 9)).map(hex)).toEqual(['09']);
  });
  it('returns private copies', () => {
    const d = new SerialDeframer();
    const a = d.feed(f(GT, 1, 0, 1))[0]!;
    d.feed(f(GT, 1, 0, 2));
    expect(a[0]).toBe(1);
  });
});
