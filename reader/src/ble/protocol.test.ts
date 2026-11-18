import { describe, expect, it } from 'vitest';
import { FIXTURES, fixtureBytes, SYNTHETIC_KEYS, type FixtureName } from './fixtures/frames';
import {
  MAX_FRAME_SIZE,
  MAX_DM_TEXT_BYTES,
  channelTextBudget,
  FrameEncodeError,
  decodeFrame,
  encodeAppStart,
  encodeDeviceQuery,
  encodeGetContacts,
  encodeSendChannel,
  encodeSendDirect,
  encodeSyncNextMessage,
  hexOf,
  isChannelSendAccepted,
} from './protocol';

const S = 'SIMULATED — not Android hardware verified: codec';
const hex = (b: Uint8Array) => hexOf(b);

describe(`${S} / encoders match independent byte fixtures`, () => {
  it('app start, device query, get contacts, sync next', () => {
    expect(hex(encodeAppStart())).toBe(FIXTURES.cmdAppStart);
    expect(hex(encodeDeviceQuery())).toBe(FIXTURES.cmdDeviceQuery);
    expect(hex(encodeGetContacts())).toBe(FIXTURES.cmdGetContacts);
    expect(hex(encodeGetContacts(1700000000))).toBe(FIXTURES.cmdGetContactsSince);
    expect(hex(encodeSyncNextMessage())).toBe(FIXTURES.cmdSyncNextMessage);
  });
  it('send direct and send channel', () => {
    expect(hex(encodeSendDirect(SYNTHETIC_KEYS.alice, 'hello dm', 1700000100))).toBe(FIXTURES.cmdSendTxtMsg);
    expect(hex(encodeSendChannel(1, 'hello channel', 1700000200, 'Synth'))).toBe(FIXTURES.cmdSendChannelTxtMsg);
  });
  it('uses only the first 6 key bytes for a direct message', () => {
    const full = encodeSendDirect(SYNTHETIC_KEYS.alice, 'x', 1);
    const short = encodeSendDirect('a1'.repeat(6), 'x', 1);
    expect(hex(full)).toBe(hex(short));
  });
  it('refuses text over the limit, empty text, a short key and an oversized frame', () => {
    expect(() => encodeSendDirect(SYNTHETIC_KEYS.alice, 'x'.repeat(MAX_DM_TEXT_BYTES + 1), 1)).toThrow(FrameEncodeError);
    expect(() => encodeSendChannel(0, '', 1, 'Synth')).toThrow(FrameEncodeError);
    expect(() => encodeSendDirect('a1a1', 'x', 1)).toThrow(FrameEncodeError);
    expect(() => encodeAppStart('n'.repeat(MAX_FRAME_SIZE))).toThrow(FrameEncodeError);
  });
  it('direct messages: up to 160 UTF-8 bytes, counted in bytes not characters', () => {
    expect(encodeSendDirect(SYNTHETIC_KEYS.alice, 'x'.repeat(160), 1).length).toBeLessThanOrEqual(MAX_FRAME_SIZE);
    expect(() => encodeSendDirect(SYNTHETIC_KEYS.alice, 'x'.repeat(161), 1)).toThrow(/text/);
    // 80 two-byte characters = 160 bytes fits; 81 = 162 bytes does not
    expect(() => encodeSendDirect(SYNTHETIC_KEYS.alice, 'é'.repeat(80), 1)).not.toThrow();
    expect(() => encodeSendDirect(SYNTHETIC_KEYS.alice, 'é'.repeat(81), 1)).toThrow(/text/);
  });
  it('channel messages: the firmware prepends "<name>: " and cuts at 160 silently, so the budget subtracts it', () => {
    // "Synth: " is 7 bytes, leaving 153
    expect(channelTextBudget('Synth')).toBe(153);
    expect(() => encodeSendChannel(0, 'x'.repeat(153), 1, 'Synth')).not.toThrow();
    expect(() => encodeSendChannel(0, 'x'.repeat(154), 1, 'Synth')).toThrow(/text/);
    // a multi-byte name costs its bytes, not its characters ("Ærø: " is 7 bytes)
    expect(channelTextBudget('Ærø')).toBe(153);
    expect(encodeSendChannel(0, 'x'.repeat(153), 1, 'Synth').length).toBeLessThanOrEqual(MAX_FRAME_SIZE);
  });
  it('the firmware attempt byte is 0 by default and carried when given', () => {
    const base = encodeSendDirect(SYNTHETIC_KEYS.alice, 'x', 1);
    const retry = encodeSendDirect(SYNTHETIC_KEYS.alice, 'x', 1, 1);
    expect(base[2]).toBe(0);
    expect(retry[2]).toBe(1);
    expect(() => encodeSendDirect(SYNTHETIC_KEYS.alice, 'x', 1, 256)).toThrow(FrameEncodeError);
  });
});

describe(`${S} / decoders`, () => {
  it('ok and errors', () => {
    expect(decodeFrame(fixtureBytes('respOk'))).toEqual({ kind: 'ok', value: null });
    expect(decodeFrame(fixtureBytes('respOkValue'))).toEqual({ kind: 'ok', value: 7 });
    expect(decodeFrame(fixtureBytes('respErrNotFound'))).toEqual({ kind: 'error', code: 2, name: 'not_found' });
    expect(decodeFrame(fixtureBytes('respErrTableFull'))).toEqual({ kind: 'error', code: 3, name: 'table_full' });
    expect(decodeFrame(fixtureBytes('respErrNoCode'))).toEqual({ kind: 'error', code: null, name: 'unspecified' });
    expect(decodeFrame(Uint8Array.of(1, 7))).toMatchObject({ code: 7, name: 'not_permitted' });
    expect(decodeFrame(Uint8Array.of(1, 99))).toMatchObject({ code: 99, name: 'unknown_99' });
  });
  it('device info, without exposing the BLE PIN', () => {
    const f = decodeFrame(fixtureBytes('respDeviceInfo'));
    expect(f).toMatchObject({ kind: 'deviceInfo', info: { firmwareVersion: 10, maxContacts: 100, maxChannels: 8, firmwareBuild: '01 Jan 2026', model: 'Synthetic Board', version: 'v1.99.0-synthetic', clientRepeat: false, pathHashMode: 1 } });
    expect(JSON.stringify(f)).not.toContain('123456');
  });
  it('self info', () => {
    const f = decodeFrame(fixtureBytes('respSelfInfo'));
    expect(f).toMatchObject({ kind: 'selfInfo', info: { publicKey: SYNTHETIC_KEYS.self, advLat: 55.123456, advLon: -12.345678, radioFreqMHz: 869.618, radioBwKHz: 62.5, radioSf: 8, radioCr: 8, name: 'Synthetic Node' } });
  });
  it('contact list', () => {
    expect(decodeFrame(fixtureBytes('respContactsStart'))).toEqual({ kind: 'contactsStart', count: 2 });
    expect(decodeFrame(fixtureBytes('respEndOfContacts'))).toEqual({ kind: 'endOfContacts', lastMod: 1700000060 });
    const a = decodeFrame(fixtureBytes('respContactAlice'));
    expect(a).toMatchObject({ kind: 'contact', contact: { publicKey: SYNTHETIC_KEYS.alice, name: 'Alice Synthetic', outPathLen: 255, outPath: '', lat: 55, lon: 12, lastMod: 1700000050 } });
    const b = decodeFrame(fixtureBytes('respContactBob'));
    expect(b).toMatchObject({ kind: 'contact', contact: { publicKey: SYNTHETIC_KEYS.bob, name: 'Bob Synthetic', outPathLen: 2, outPath: '0102' } });
  });
  it('sent and send-confirmed', () => {
    expect(decodeFrame(fixtureBytes('respSent'))).toEqual({ kind: 'sent', flood: true, tag: 0xdeadbeef, suggestedTimeoutMs: 4000 });
    expect(decodeFrame(fixtureBytes('respSentDirect'))).toEqual({ kind: 'sent', flood: false, tag: 0x0badf00d, suggestedTimeoutMs: 2500 });
    expect(decodeFrame(fixtureBytes('pushSendConfirmed'))).toEqual({ kind: 'sendConfirmed', tag: 0xdeadbeef, roundTripMs: 1234 });
    expect(decodeFrame(fixtureBytes('pushMsgWaiting'))).toEqual({ kind: 'messagesWaiting' });
  });
  it('direct and channel messages, V2 and V3', () => {
    expect(decodeFrame(fixtureBytes('respContactMsgV3'))).toMatchObject({ kind: 'directMessage', message: { snr: 10, senderKeyPrefix: 'a1'.repeat(6), pathLen: 255, txtType: 0, timestamp: 1700000300, signature: null, text: 'hi from alice' } });
    expect(decodeFrame(fixtureBytes('respContactMsgV2'))).toMatchObject({ kind: 'directMessage', message: { snr: null, pathLen: 2, txtType: 0, timestamp: 1700000301, signature: null, text: 'hi v2' } });
    // signed text (type 2): 4 signature bytes sit between timestamp and text (synthetic bytes)
    const signed = Uint8Array.of(7, ...Array(6).fill(0xa1), 0xff, 2, 0x2d, 0x01, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x68, 0x69);
    expect(decodeFrame(signed)).toMatchObject({ kind: 'directMessage', message: { txtType: 2, timestamp: 301, signature: 'deadbeef', text: 'hi' } });
    expect(decodeFrame(fixtureBytes('respChannelMsgV3'))).toMatchObject({ kind: 'channelMessage', message: { snr: -2, channelIndex: 1, pathLen: 3, text: 'chan hello', timestamp: 1700000400 } });
    expect(decodeFrame(fixtureBytes('respChannelMsgV2'))).toMatchObject({ kind: 'channelMessage', message: { snr: null, channelIndex: 1, pathLen: 255, text: 'chan v2' } });
    expect(decodeFrame(fixtureBytes('respNoMoreMessages'))).toEqual({ kind: 'noMoreMessages' });
  });
  it('treats channel OK and SENT as the device accepting a channel send, nothing more', () => {
    expect(isChannelSendAccepted(decodeFrame(fixtureBytes('respOk')))).toBe(true);
    expect(isChannelSendAccepted(decodeFrame(fixtureBytes('respSent')))).toBe(true);
    expect(isChannelSendAccepted(decodeFrame(fixtureBytes('respErrNotFound')))).toBe(false);
  });
  it('advert and unknown codes are not errors', () => {
    expect(decodeFrame(fixtureBytes('pushAdvert'))).toEqual({ kind: 'advert' });
    expect(decodeFrame(Uint8Array.of(0x6f, 1, 2))).toEqual({ kind: 'unknown', code: 0x6f });
  });
  it('never throws on any truncation of any fixture, and flags short frames as malformed', () => {
    for (const name of Object.keys(FIXTURES) as FixtureName[]) {
      const full = fixtureBytes(name);
      for (let n = 0; n <= full.length; n++) {
        expect(() => decodeFrame(full.subarray(0, n))).not.toThrow();
      }
    }
    expect(decodeFrame(new Uint8Array(0)).kind).toBe('malformed');
    expect(decodeFrame(fixtureBytes('respSent').subarray(0, 9)).kind).toBe('malformed');
    expect(decodeFrame(fixtureBytes('pushSendConfirmed').subarray(0, 8)).kind).toBe('malformed');
    expect(decodeFrame(fixtureBytes('respContactAlice').subarray(0, 147)).kind).toBe('malformed');
    expect(decodeFrame(fixtureBytes('respSelfInfo').subarray(0, 57)).kind).toBe('malformed');
  });
});
