import { describe, expect, it } from 'vitest';
import { encodeAppStart, encodeDeviceQuery, encodeSendDirect, encodeSyncNextMessage } from '../ble/protocol';
import { encodeSerialFrame } from '../ble/serialFraming';
import { encodeCliLine } from './cliText';
import { classifyProbeFrame, classifyProbeWrite, guardFrames } from './guard';
import type { CompanionTransport } from '../ble/transport';
import { buildRequest, encodeMeconFrames, encodeMeconLine } from './meconIface';

const refused = (b: Uint8Array) => {
  try {
    classifyProbeWrite(b);
    return false;
  } catch {
    return true;
  }
};
const T = (s: string) => new TextEncoder().encode(s);

describe('probe write allowlist', () => {
  it('allows the read-only units', () => {
    expect(classifyProbeWrite(encodeCliLine('ver')).label).toBe('cli:ver');
    expect(classifyProbeWrite(encodeCliLine('get role')).label).toBe('cli:get role');
    expect(classifyProbeWrite(encodeMeconLine(buildRequest('a', 'hello'))).label).toBe('iface:hello');
    expect(classifyProbeWrite(encodeMeconLine(buildRequest('a', 'status.get'))).label).toBe('iface:status.get');
    expect(classifyProbeWrite(encodeMeconLine(buildRequest('a', 'clock.get'))).label).toBe('iface:clock.get');
    expect(classifyProbeWrite(encodeSerialFrame(encodeAppStart())).label).toBe('frame:1');
    expect(classifyProbeWrite(encodeSerialFrame(encodeDeviceQuery())).label).toBe('frame:22');
    const [one] = encodeMeconFrames(1, buildRequest('a', 'hello'));
    expect(classifyProbeWrite(encodeSerialFrame(one!)).label).toBe('frame-iface:hello');
  });

  it('refuses every stock CLI line that changes or transmits, and secrets', () => {
    for (const l of ['reboot', 'advert', 'advert.zerohop', 'erase', 'poweroff', 'password x', 'set name x', 'set radio 869.6,62.5,8,8', 'get prv.key', 'start ota', 'clear stats', 'clkreboot', 'time 1', 'log erase', 'region put x', 'get acl'])
      expect(refused(encodeCliLine(l)), l).toBe(true);
  });

  it('refuses a read line with anything attached: the firmware matches by prefix', () => {
    for (const l of ['ver ', 'verx', 'ver now', 'board x', 'get role x', ' ver', 'Ver'])
      expect(refused(encodeCliLine(l)), l).toBe(true);
  });

  it('refuses a line that smuggles a second command (embedded CR or LF) or control bytes', () => {
    expect(refused(T('ver\rreboot\r'))).toBe(true);
    expect(refused(T('ver\nreboot\r'))).toBe(true);
    expect(refused(T('ver\x00\r'))).toBe(true);
    expect(refused(T('ver'))).toBe(true); // no terminator
    expect(refused(T('ver\r\n'))).toBe(true);
  });

  it('refuses interface operations that are not on the read list, and any extra field', () => {
    for (const op of ['config.apply', 'device.reboot', 'device.reset', 'deployment.get', 'deployment.provision', 'update.offer', 'identity.rotate', 'password.set', 'message.send', 'advert.send', 'packet.transmit', 'log.erase', 'config.get', 'sub.start'])
      expect(refused(encodeMeconLine(JSON.stringify({ v: 1, id: 'a', op }))), op).toBe(true);
    expect(refused(encodeMeconLine(JSON.stringify({ v: 1, id: 'a', op: 'hello', args: { cursor: 1 } })))).toBe(true);
    expect(refused(encodeMeconLine(JSON.stringify({ v: 1, id: 'a', op: 'hello', auth: {} })))).toBe(true);
    expect(refused(encodeMeconLine(JSON.stringify({ v: 2, id: 'a', op: 'hello' })))).toBe(true);
    expect(refused(encodeMeconLine('{"v":1,"id":"a","op":"hello"'))).toBe(true);
  });

  it('refuses Companion commands other than app start and device query', () => {
    expect(refused(encodeSerialFrame(encodeSyncNextMessage()))).toBe(true);
    expect(refused(encodeSerialFrame(encodeSendDirect('a1'.repeat(6), 'hi', 1)))).toBe(true);
    expect(refused(encodeSerialFrame(Uint8Array.of(3, 0, 0)))).toBe(true);
    expect(refused(encodeSerialFrame(Uint8Array.of(23)))).toBe(true); // export private key
    expect(refused(encodeSerialFrame(Uint8Array.of(66, 0x76, 0x65, 0x72)))).toBe(true); // CLI frame: not built here
  });

  it('refuses a frame whose declared length does not match its bytes, and a multi-frame interface request', () => {
    expect(refused(Uint8Array.of(0x3c, 5, 0, 22, 3))).toBe(true);
    expect(refused(Uint8Array.of(0x3c, 1, 0, 22, 3))).toBe(true);
    const frames = encodeMeconFrames(1, JSON.stringify({ v: 1, id: 'a', op: 'hello', args: { pad: 'x'.repeat(300) } }));
    expect(frames.length).toBeGreaterThan(1);
    expect(refused(encodeSerialFrame(frames[0]!))).toBe(true);
  });

  it('refuses an interface request whose frame header says it is not the only frame', () => {
    const json = T(JSON.stringify({ v: 1, id: 'a', op: 'hello' }));
    const frame = (idx: number, count: number) => {
      const f = new Uint8Array(4 + json.length);
      f.set([0x7f, 1, idx, count]);
      f.set(json, 4);
      return f;
    };
    expect(refused(encodeSerialFrame(frame(0, 1)))).toBe(false); // control: a single frame passes
    expect(refused(encodeSerialFrame(frame(0, 2)))).toBe(true); // first of two
    expect(refused(encodeSerialFrame(frame(1, 1)))).toBe(true); // not the first
    expect(() => classifyProbeFrame(frame(0, 2))).toThrow();
    expect(() => classifyProbeFrame(frame(1, 1))).toThrow();
  });

  it('refuses a text line with a control or non-ASCII byte even when the rest is a valid read request', () => {
    const line = (json: string) => T(`mecon> ${json}\r`);
    expect(refused(line('{"v":1,"id":"a","op":"hello"}'))).toBe(false); // control
    expect(refused(line('{"v":1,\t"id":"a","op":"hello"}'))).toBe(true); // tab is valid JSON whitespace
    expect(refused(new TextEncoder().encode('mecon> {"v":1,"id":"é","op":"hello"}\r'))).toBe(true); // raw non-ASCII
  });

  it('refuses empty and unframed binary', () => {
    expect(refused(new Uint8Array(0))).toBe(true);
    expect(refused(Uint8Array.of(0x16, 0x03, 0x0d))).toBe(true);
  });
});

describe('probe frame allowlist (BLE: frames carry no serial wrapper)', () => {
  const frameRefused = (f: Uint8Array) => {
    try {
      classifyProbeFrame(f);
      return false;
    } catch {
      return true;
    }
  };
  const one = (op: string, extra: Record<string, unknown> = {}) => encodeMeconFrames(1, JSON.stringify({ v: 1, id: 'a', op, ...extra }))[0]!;

  it('allows app start, device query and one read-only interface request in a single 0x7F frame', () => {
    expect(classifyProbeFrame(encodeAppStart()).label).toBe('frame:1');
    expect(classifyProbeFrame(encodeDeviceQuery()).label).toBe('frame:22');
    for (const op of ['hello', 'status.get', 'clock.get']) expect(classifyProbeFrame(one(op)).label).toBe(`frame-iface:${op}`);
  });

  it('refuses every non-read interface operation carried as 0x7F, arguments, authority, and multi-frame requests', () => {
    for (const op of ['config.apply', 'device.reboot', 'device.reset', 'message.send', 'advert.send', 'packet.transmit', 'log.erase', 'update.offer', 'identity.rotate', 'deployment.provision', 'channel.put', 'contact.put', 'job.ack', 'config.get', '']) {
      expect(frameRefused(one(op)), op).toBe(true);
    }
    expect(frameRefused(one('hello', { args: { x: 1 } }))).toBe(true);
    expect(frameRefused(one('hello', { mecon_auth: {} }))).toBe(true);
    const many = encodeMeconFrames(1, JSON.stringify({ v: 1, id: 'a', op: 'hello', args: { pad: 'x'.repeat(400) } }));
    expect(many.length).toBeGreaterThan(1);
    for (const f of many) expect(frameRefused(f)).toBe(true);
    expect(frameRefused(Uint8Array.of(0x7f))).toBe(true);
    expect(frameRefused(Uint8Array.of(0x7f, 1, 0, 1, 0x7b))).toBe(true); // not JSON
  });

  it('refuses native commands that send, change or read private things, and empty frames', () => {
    for (const code of [2, 3, 4, 10, 11, 17, 18, 0x99]) expect(frameRefused(Uint8Array.of(code, 0, 0, 0)), String(code)).toBe(true);
    expect(frameRefused(new Uint8Array(0))).toBe(true);
  });

  it('guardFrames stops a refused frame before the link sees it, and logs what it let through', async () => {
    const written: Uint8Array[] = [];
    const log: string[] = [];
    const g = guardFrames({ ...inertLink, write: async (f) => void written.push(f) }, log);
    await g.write(one('hello'));
    await expect(g.write(one('config.apply'))).rejects.toMatchObject({ code: 'bad_argument' });
    expect(written).toHaveLength(1);
    expect(log).toEqual(['frame-iface:hello']);
  });
});

const inertLink: CompanionTransport = {
  kind: 'ble',
  support: 'supported',
  requestDevice: async () => ({ id: 'x', name: null }),
  connect: async () => undefined,
  write: async () => undefined,
  disconnect: async () => undefined,
  onFrame: () => () => undefined,
  onDisconnect: () => () => undefined,
};
