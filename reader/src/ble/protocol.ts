/**
 * MeshCore Companion protocol over BLE: frame codec for the subset the Reader
 * needs. Transport-agnostic: bytes in, typed frames out, and the reverse.
 *
 * SOURCES (MIT-licensed code and documentation only; no GPL client was read):
 *  - meshcore-dev/MeshCore @ 75b04ef06def54b348400cb1b138afb6749ffd4f
 *      docs/companion_protocol.md
 *        service/characteristic UUIDs, one-frame-per-write rule, SELF_INFO,
 *        DEVICE_INFO, CHANNEL/CONTACT message layouts (V2/V3), error codes
 *      examples/companion_radio/MyMesh.cpp
 *        command/response/push code numbers; CMD_SEND_TXT_MSG,
 *        CMD_SEND_CHANNEL_TXT_MSG, CMD_GET_CONTACTS, CMD_SYNC_NEXT_MESSAGE
 *        handlers; writeContactRespFrame (contact layout); RESP_CODE_SENT and
 *        PUSH_CODE_SEND_CONFIRMED layouts; END_OF_CONTACTS lastmod
 *      src/helpers/TxtDataHelpers.h   TXT_TYPE_* values
 *      src/helpers/BaseSerialInterface.h   MAX_FRAME_SIZE = 176
 *      src/MeshCore.h   PUB_KEY_SIZE = 32, MAX_PATH_SIZE = 64
 *  - hoejriis/mecon-firmware @ 8c305faf942cf4c2bd73c1f14b44692a0e468c2f
 *      docs/companion_protocol.md (same as upstream plus ERR_CODE_NOT_PERMITTED = 7)
 *
 * Where the upstream prose and the upstream source disagree, the source wins and
 * the disagreement is marked below.
 *
 * Deliberately NOT implemented: private-key export/import, signing, channel
 * secrets (SET_CHANNEL / GET_CHANNEL), CLI commands, factory reset, radio or
 * identity changes. Nothing in this module touches key material.
 */

// ---------------------------------------------------------------------------
// BLE identifiers (docs/companion_protocol.md, "BLE Connection")
// ---------------------------------------------------------------------------
export const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** App writes here (firmware reads). */
export const RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
/** Firmware notifies here (app reads). */
export const TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

/** BaseSerialInterface.h. Each BLE write/notification carries exactly one frame. */
export const MAX_FRAME_SIZE = 176;
export const PUB_KEY_SIZE = 32;
export const MAX_PATH_SIZE = 64;
export const KEY_PREFIX_SIZE = 6;
/** Protocol version the app announces in DEVICE_QUERY. */
export const APP_TARGET_VERSION = 3;
/**
 * Text limits, in UTF-8 bytes (answered by the public firmware's owner on
 * mecon-backend Issue #5, 2026-11-18). A direct message over 160 bytes is
 * refused by the firmware. A channel message is cut SILENTLY at 160 bytes
 * including the "<sender name>: " prefix the firmware prepends, so the Reader
 * refuses any channel text that would not fit whole.
 */
export const MAX_DM_TEXT_BYTES = 160;
export const MAX_CHANNEL_PAYLOAD_BYTES = 160;

/** Bytes left for channel text once the firmware prepends "<name>: ". */
export function channelTextBudget(senderName: string): number {
  return MAX_CHANNEL_PAYLOAD_BYTES - utf8.encode(`${senderName}: `).length;
}

// ---------------------------------------------------------------------------
// Codes (MyMesh.cpp)
// ---------------------------------------------------------------------------
export const CMD = {
  APP_START: 1,
  SEND_TXT_MSG: 2,
  SEND_CHANNEL_TXT_MSG: 3,
  GET_CONTACTS: 4,
  SYNC_NEXT_MESSAGE: 10,
  DEVICE_QUERY: 22,
} as const;

export const RESP = {
  OK: 0,
  ERR: 1,
  CONTACTS_START: 2,
  CONTACT: 3,
  END_OF_CONTACTS: 4,
  SELF_INFO: 5,
  SENT: 6,
  CONTACT_MSG_RECV: 7,
  CHANNEL_MSG_RECV: 8,
  NO_MORE_MESSAGES: 10,
  DEVICE_INFO: 13,
  CONTACT_MSG_RECV_V3: 16,
  CHANNEL_MSG_RECV_V3: 17,
} as const;

export const PUSH = {
  ADVERT: 0x80,
  SEND_CONFIRMED: 0x82,
  MSG_WAITING: 0x83,
} as const;

export const ERR = {
  UNSUPPORTED_CMD: 1,
  NOT_FOUND: 2,
  TABLE_FULL: 3,
  BAD_STATE: 4,
  FILE_IO_ERROR: 5,
  ILLEGAL_ARG: 6,
  /** MECON addition (mecon-firmware docs): command refused on this transport. */
  NOT_PERMITTED: 7,
} as const;

export const ERR_NAMES: Record<number, string> = {
  1: 'unsupported_cmd',
  2: 'not_found',
  3: 'table_full',
  4: 'bad_state',
  5: 'file_io_error',
  6: 'illegal_arg',
  7: 'not_permitted',
};

/** TxtDataHelpers.h */
export const TXT_TYPE = { PLAIN: 0, CLI_DATA: 1, SIGNED_PLAIN: 2, CLI_COMMAND: 3 } as const;

// ---------------------------------------------------------------------------
// Decoded frame types
// ---------------------------------------------------------------------------
export interface DeviceInfo {
  firmwareVersion: number;
  /** UNVERIFIED for versions below 3 (layout of the older frame is not documented). */
  maxContacts: number | null;
  maxChannels: number | null;
  /** The device reports its BLE PIN here. The Reader never displays or stores it. */
  firmwareBuild: string | null;
  model: string | null;
  version: string | null;
  clientRepeat: boolean | null;
  pathHashMode: number | null;
}

export interface SelfInfo {
  advType: number;
  txPower: number;
  maxTxPower: number;
  publicKey: string; // hex, public
  /** Degrees: signed int32 ×1e6 (public firmware owner, Issue #5). */
  advLat: number;
  advLon: number;
  multiAcks: number;
  advLocPolicy: number;
  telemetryMode: number;
  manualAddContacts: boolean;
  radioFreqMHz: number;
  radioBwKHz: number;
  radioSf: number;
  radioCr: number;
  name: string;
}

export interface Contact {
  publicKey: string; // hex, 32 bytes
  type: number;
  flags: number;
  /** 0xFF means no known path (flood). */
  outPathLen: number;
  outPath: string; // hex of the first min(outPathLen, 64) bytes
  name: string;
  lastAdvertTimestamp: number;
  /** Degrees: signed int32 ×1e6 (public firmware owner, Issue #5). */
  lat: number;
  lon: number;
  lastMod: number;
}

export interface IncomingDirectMessage {
  snr: number | null;
  senderKeyPrefix: string; // hex, 6 bytes
  pathLen: number;
  txtType: number;
  timestamp: number;
  /** Present only when txtType is SIGNED_PLAIN. */
  signature: string | null;
  text: string;
}

export interface IncomingChannelMessage {
  snr: number | null;
  channelIndex: number;
  pathLen: number;
  txtType: number;
  timestamp: number;
  text: string;
}

export type Frame =
  | { kind: 'ok'; value: number | null }
  | { kind: 'error'; code: number | null; name: string }
  | { kind: 'contactsStart'; count: number }
  | { kind: 'contact'; contact: Contact }
  | { kind: 'endOfContacts'; lastMod: number }
  | { kind: 'selfInfo'; info: SelfInfo }
  | { kind: 'deviceInfo'; info: DeviceInfo }
  | { kind: 'sent'; flood: boolean; tag: number; suggestedTimeoutMs: number }
  | { kind: 'directMessage'; message: IncomingDirectMessage }
  | { kind: 'channelMessage'; message: IncomingChannelMessage }
  | { kind: 'noMoreMessages' }
  | { kind: 'sendConfirmed'; tag: number; roundTripMs: number }
  | { kind: 'messagesWaiting' }
  | { kind: 'advert' }
  /** A well-formed code this subset does not decode. Never an error. */
  | { kind: 'unknown'; code: number }
  /** A known code with a body too short or inconsistent to decode. */
  | { kind: 'malformed'; code: number; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const utf8 = new TextEncoder();
const utf8d = new TextDecoder('utf-8');

export function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesOfHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new RangeError('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function cstr(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8d.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export class FrameEncodeError extends Error {
  constructor(
    readonly reason: 'text_too_long' | 'frame_too_large' | 'bad_argument',
    message: string,
  ) {
    super(message);
    this.name = 'FrameEncodeError';
  }
}

function checkFrame(frame: Uint8Array): Uint8Array {
  if (frame.length > MAX_FRAME_SIZE) throw new FrameEncodeError('frame_too_large', `frame ${frame.length} > ${MAX_FRAME_SIZE}`);
  return frame;
}

function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new FrameEncodeError('bad_argument', 'u32 out of range');
  const b = new Uint8Array(4);
  view(b).setUint32(0, n, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function textBytes(text: string, maxBytes: number): Uint8Array {
  const t = utf8.encode(text);
  if (t.length === 0) throw new FrameEncodeError('bad_argument', 'empty text');
  if (t.length > maxBytes) throw new FrameEncodeError('text_too_long', `text ${t.length} bytes > ${maxBytes}`);
  return t;
}

// ---------------------------------------------------------------------------
// Encoders (app to device)
// ---------------------------------------------------------------------------
/** companion_protocol.md "App Start": code, 7 reserved bytes, app name. */
export function encodeAppStart(appName = 'mecon-reader'): Uint8Array {
  return checkFrame(concat(Uint8Array.of(CMD.APP_START, 0, 0, 0, 0, 0, 0, 0), utf8.encode(appName)));
}

/** companion_protocol.md "Device Query": 0x16 then the app's target protocol version. */
export function encodeDeviceQuery(targetVersion = APP_TARGET_VERSION): Uint8Array {
  return Uint8Array.of(CMD.DEVICE_QUERY, targetVersion);
}

/** MyMesh.cpp CMD_GET_CONTACTS: optional u32 `since` (lastmod of the previous sync). */
export function encodeGetContacts(since?: number): Uint8Array {
  return since === undefined ? Uint8Array.of(CMD.GET_CONTACTS) : concat(Uint8Array.of(CMD.GET_CONTACTS), u32(since));
}

export function encodeSyncNextMessage(): Uint8Array {
  return Uint8Array.of(CMD.SYNC_NEXT_MESSAGE);
}

/**
 * MyMesh.cpp CMD_SEND_TXT_MSG: [2][txt_type][attempt][ts u32][6-byte key prefix][text].
 * `attempt` is not our client_attempt_id: it changes the packet hash and the
 * expected ACK, so a manual retry of the same draft must increment it (public
 * firmware owner, Issue #5). 0 for a draft's first attempt.
 */
export function encodeSendDirect(keyPrefixHex: string, text: string, timestampSec: number, firmwareAttempt = 0): Uint8Array {
  const key = bytesOfHex(keyPrefixHex);
  if (key.length < KEY_PREFIX_SIZE) throw new FrameEncodeError('bad_argument', 'key prefix < 6 bytes');
  if (!Number.isInteger(firmwareAttempt) || firmwareAttempt < 0 || firmwareAttempt > 255) throw new FrameEncodeError('bad_argument', 'attempt');
  const prefix = key.subarray(0, KEY_PREFIX_SIZE);
  return checkFrame(
    concat(Uint8Array.of(CMD.SEND_TXT_MSG, TXT_TYPE.PLAIN, firmwareAttempt), u32(timestampSec), prefix, textBytes(text, MAX_DM_TEXT_BYTES)),
  );
}

/** companion_protocol.md "Send Channel Message": [3][0][channel][ts u32][text]. */
export function encodeSendChannel(channelIndex: number, text: string, timestampSec: number, senderName: string): Uint8Array {
  if (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex > 255) throw new FrameEncodeError('bad_argument', 'channel');
  return checkFrame(
    concat(Uint8Array.of(CMD.SEND_CHANNEL_TXT_MSG, TXT_TYPE.PLAIN, channelIndex), u32(timestampSec), textBytes(text, channelTextBudget(senderName))),
  );
}

// ---------------------------------------------------------------------------
// Decoder (device to app). Never throws.
// ---------------------------------------------------------------------------
function decodeDeviceInfo(b: Uint8Array): Frame {
  if (b.length < 2) return { kind: 'malformed', code: b[0] ?? 0, reason: 'device info too short' };
  const firmwareVersion = b[1]!;
  if (firmwareVersion < 3) {
    // UNVERIFIED: the pre-v3 layout is not documented; report only the version.
    return { kind: 'deviceInfo', info: { firmwareVersion, maxContacts: null, maxChannels: null, firmwareBuild: null, model: null, version: null, clientRepeat: null, pathHashMode: null } };
  }
  if (b.length < 80) return { kind: 'malformed', code: RESP.DEVICE_INFO, reason: 'device info < 80 bytes' };
  return {
    kind: 'deviceInfo',
    info: {
      firmwareVersion,
      maxContacts: b[2]! * 2,
      maxChannels: b[3]!,
      // bytes 4-7 are the BLE PIN: deliberately not decoded into the result.
      firmwareBuild: cstr(b.subarray(8, 20)),
      model: cstr(b.subarray(20, 60)),
      version: cstr(b.subarray(60, 80)),
      clientRepeat: b.length > 80 ? b[80] !== 0 : null,
      pathHashMode: b.length > 81 ? b[81]! : null,
    },
  };
}

function decodeSelfInfo(b: Uint8Array): Frame {
  if (b.length < 58) return { kind: 'malformed', code: RESP.SELF_INFO, reason: 'self info < 58 bytes' };
  const v = view(b);
  return {
    kind: 'selfInfo',
    info: {
      advType: b[1]!,
      txPower: b[2]!,
      maxTxPower: b[3]!,
      publicKey: hexOf(b.subarray(4, 36)),
      advLat: v.getInt32(36, true) / 1e6,
      advLon: v.getInt32(40, true) / 1e6,
      multiAcks: b[44]!,
      advLocPolicy: b[45]!,
      telemetryMode: b[46]!,
      manualAddContacts: b[47]! > 0,
      radioFreqMHz: v.getUint32(48, true) / 1000,
      radioBwKHz: v.getUint32(52, true) / 1000,
      radioSf: b[56]!,
      radioCr: b[57]!,
      name: cstr(b.subarray(58)),
    },
  };
}

/** MyMesh.cpp writeContactRespFrame: 1+32+1+1+1+64+32+4+4+4+4 = 148 bytes. */
const CONTACT_FRAME_LEN = 1 + PUB_KEY_SIZE + 3 + MAX_PATH_SIZE + 32 + 16;
function decodeContact(b: Uint8Array): Frame {
  if (b.length < CONTACT_FRAME_LEN) return { kind: 'malformed', code: RESP.CONTACT, reason: `contact < ${CONTACT_FRAME_LEN} bytes` };
  const v = view(b);
  const pathLen = b[35]!;
  const usable = pathLen === 0xff ? 0 : Math.min(pathLen, MAX_PATH_SIZE);
  let o = 36 + MAX_PATH_SIZE;
  const name = cstr(b.subarray(o, o + 32));
  o += 32;
  return {
    kind: 'contact',
    contact: {
      publicKey: hexOf(b.subarray(1, 33)),
      type: b[33]!,
      flags: b[34]!,
      outPathLen: pathLen,
      // UNVERIFIED: the path-length byte may encode a hash size in its top bits
      // (see Packet::isValidPathLen upstream); we only expose the raw bytes.
      outPath: hexOf(b.subarray(36, 36 + usable)),
      name,
      lastAdvertTimestamp: v.getUint32(o, true),
      lat: v.getInt32(o + 4, true) / 1e6,
      lon: v.getInt32(o + 8, true) / 1e6,
      lastMod: v.getUint32(o + 12, true),
    },
  };
}

function decodeDirectMessage(b: Uint8Array, v3: boolean): Frame {
  const code = b[0]!;
  const head = v3 ? 4 : 1;
  if (b.length < head + 6 + 2 + 4) return { kind: 'malformed', code, reason: 'direct message too short' };
  const snr = v3 ? ((b[1]! << 24) >> 24) / 4 : null;
  let o = head;
  const senderKeyPrefix = hexOf(b.subarray(o, o + 6));
  o += 6;
  const pathLen = b[o]!;
  const txtType = b[o + 1]!;
  o += 2;
  const timestamp = view(b).getUint32(o, true);
  o += 4;
  let signature: string | null = null;
  if (txtType === TXT_TYPE.SIGNED_PLAIN) {
    if (b.length < o + 4) return { kind: 'malformed', code, reason: 'signed message missing signature' };
    signature = hexOf(b.subarray(o, o + 4));
    o += 4;
  }
  return { kind: 'directMessage', message: { snr, senderKeyPrefix, pathLen, txtType, timestamp, signature, text: utf8d.decode(b.subarray(o)) } };
}

function decodeChannelMessage(b: Uint8Array, v3: boolean): Frame {
  const code = b[0]!;
  const head = v3 ? 4 : 1;
  if (b.length < head + 1 + 1 + 1 + 4) return { kind: 'malformed', code, reason: 'channel message too short' };
  const snr = v3 ? ((b[1]! << 24) >> 24) / 4 : null;
  const o = head;
  return {
    kind: 'channelMessage',
    message: {
      snr,
      channelIndex: b[o]!,
      pathLen: b[o + 1]!,
      txtType: b[o + 2]!,
      timestamp: view(b).getUint32(o + 3, true),
      text: utf8d.decode(b.subarray(o + 7)),
    },
  };
}

export function decodeFrame(b: Uint8Array): Frame {
  if (b.length === 0) return { kind: 'malformed', code: -1, reason: 'empty frame' };
  const code = b[0]!;
  switch (code) {
    case RESP.OK:
      return { kind: 'ok', value: b.length >= 5 ? view(b).getUint32(1, true) : null };
    case RESP.ERR: {
      const c = b.length >= 2 ? b[1]! : null;
      return { kind: 'error', code: c, name: c === null ? 'unspecified' : (ERR_NAMES[c] ?? `unknown_${c}`) };
    }
    case RESP.CONTACTS_START:
      return b.length >= 5 ? { kind: 'contactsStart', count: view(b).getUint32(1, true) } : { kind: 'malformed', code, reason: 'contacts start < 5 bytes' };
    case RESP.CONTACT:
      return decodeContact(b);
    case RESP.END_OF_CONTACTS:
      return b.length >= 5 ? { kind: 'endOfContacts', lastMod: view(b).getUint32(1, true) } : { kind: 'malformed', code, reason: 'end of contacts < 5 bytes' };
    case RESP.SELF_INFO:
      return decodeSelfInfo(b);
    case RESP.SENT:
      // MyMesh.cpp: [6][route flag][expected ack u32][suggested timeout u32] = 10 bytes.
      if (b.length < 10) return { kind: 'malformed', code, reason: 'sent < 10 bytes' };
      return { kind: 'sent', flood: b[1] === 1, tag: view(b).getUint32(2, true), suggestedTimeoutMs: view(b).getUint32(6, true) };
    case RESP.CONTACT_MSG_RECV:
      return decodeDirectMessage(b, false);
    case RESP.CONTACT_MSG_RECV_V3:
      return decodeDirectMessage(b, true);
    case RESP.CHANNEL_MSG_RECV:
      return decodeChannelMessage(b, false);
    case RESP.CHANNEL_MSG_RECV_V3:
      return decodeChannelMessage(b, true);
    case RESP.NO_MORE_MESSAGES:
      return { kind: 'noMoreMessages' };
    case RESP.DEVICE_INFO:
      return decodeDeviceInfo(b);
    case PUSH.SEND_CONFIRMED:
      // MyMesh.cpp processAck writes 9 bytes: [0x82][ack u32][trip time u32].
      // The prose doc says "ACK Code (6 bytes)"; the source is authoritative here.
      if (b.length < 9) return { kind: 'malformed', code, reason: 'send confirmed < 9 bytes' };
      return { kind: 'sendConfirmed', tag: view(b).getUint32(1, true), roundTripMs: view(b).getUint32(5, true) };
    case PUSH.MSG_WAITING:
      return { kind: 'messagesWaiting' };
    case PUSH.ADVERT:
      return { kind: 'advert' };
    default:
      return { kind: 'unknown', code };
  }
}

/** What the firmware answers to a channel send: public firmware answers OK (Issue #5); SENT is still accepted defensively. */
export function isChannelSendAccepted(f: Frame): boolean {
  // Source (MyMesh.cpp CMD_SEND_CHANNEL_TXT_MSG) writes RESP_CODE_OK; the prose
  // doc says RESP_CODE_SENT. Both are accepted as "device accepted", and neither
  // is evidence that anything was transmitted.
  return f.kind === 'ok' || f.kind === 'sent';
}
