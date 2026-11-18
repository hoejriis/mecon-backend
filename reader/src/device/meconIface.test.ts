import { describe, expect, it } from 'vitest';
import fx from './fixtures/framing.json';
import { MeconReassembler, encodeMeconFrames, encodeMeconLine, parseHello, parseMeconLine } from './meconIface';

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (a: Uint8Array) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');

describe('0x7F frames against the firmware repository fixture (framing.json, xid 5)', () => {
  it('produces exactly the recorded frames (minus the serial wrapper)', () => {
    const frames = encodeMeconFrames(fx.xid, fx.message_utf8);
    // fixture lines are the interface frames; 0x7F | xid | index | count | body
    expect(frames.map(toHex)).toEqual(fx.frames_hex);
  });
  it('reassembles the recorded frames in any order', () => {
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      const r = new MeconReassembler();
      let out: string | null = null;
      for (const i of order) out = r.push(fromHex(fx.frames_hex[i]!)) ?? out;
      expect(out).toBe(fx.message_utf8);
    }
  });
  it('ignores a repeated frame, and a frame for a new xid drops the incomplete message', () => {
    const r = new MeconReassembler();
    expect(r.push(fromHex(fx.frames_hex[0]!))).toBeNull();
    expect(r.push(fromHex(fx.frames_hex[0]!))).toBeNull();
    const other = encodeMeconFrames(9, '{"v":1,"id":"x","status":"ok"}');
    expect(r.push(other[0]!)).toBe('{"v":1,"id":"x","status":"ok"}');
    // the old message is gone: its last two frames alone cannot complete it
    expect(r.push(fromHex(fx.frames_hex[1]!))).toBeNull();
    expect(r.push(fromHex(fx.frames_hex[2]!))).toBeNull();
  });
  it('refuses count 0, count over 25 and index out of range', () => {
    const r = new MeconReassembler();
    expect(r.push(Uint8Array.of(0x7f, 1, 0, 0, 0x41))).toBeNull();
    expect(r.push(Uint8Array.of(0x7f, 1, 0, 26, 0x41))).toBeNull();
    expect(r.push(Uint8Array.of(0x7f, 1, 3, 2, 0x41))).toBeNull();
  });
});

describe('console line', () => {
  it('encodes as "mecon> " + JSON + CR', () => {
    expect(new TextDecoder().decode(encodeMeconLine('{"v":1}'))).toBe('mecon> {"v":1}\r');
  });
  it('parses only lines that start with "mecon> {"', () => {
    expect(parseMeconLine('mecon> {"v":1,"id":"a","status":"ok"}')).toMatchObject({ id: 'a' });
    expect(parseMeconLine('  -> Unknown command')).toBeNull();
    expect(parseMeconLine('mecon> not json')).toBeNull();
    expect(parseMeconLine('mecon> {broken')).toBeNull();
  });
  it('refuses a line over 1600 bytes', () => expect(() => encodeMeconLine('x'.repeat(1700))).toThrow());
});

describe('hello', () => {
  const ok = { status: 'ok', result: { interface: '1.0', role: 'repeater', firmware: 'v1.18.0-mecon.1', capabilities: ['hello'], device_id: 'a', node_key: 'b' } };
  it('reads the schema fields', () => expect(parseHello(ok)).toMatchObject({ interfaceVersion: '1.0', role: 'repeater', deviceIdPresent: true }));
  it('an unknown role string is not mapped to a known role', () => expect(parseHello({ ...ok, result: { ...ok.result, role: 'gateway' } })).toMatchObject({ role: null, roleRaw: 'gateway' }));
  it('refused or malformed is null', () => {
    expect(parseHello({ status: 'refused' })).toBeNull();
    expect(parseHello({ status: 'ok', result: { interface: '2.0', role: 'repeater' } })).toBeNull();
  });
});
