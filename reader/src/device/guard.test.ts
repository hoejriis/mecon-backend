import { describe, expect, it } from 'vitest';
import { encodeAppStart, encodeDeviceQuery, encodeSendDirect, encodeSyncNextMessage } from '../ble/protocol';
import { encodeSerialFrame } from '../ble/serialFraming';
import { encodeCliLine } from './cliText';
import { classifyProbeWrite } from './guard';
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

  it('refuses empty and unframed binary', () => {
    expect(refused(new Uint8Array(0))).toBe(true);
    expect(refused(Uint8Array.of(0x16, 0x03, 0x0d))).toBe(true);
  });
});
