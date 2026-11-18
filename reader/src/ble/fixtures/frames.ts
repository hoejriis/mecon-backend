// Synthetic byte fixtures for the Companion protocol codec. Each entry is
// documented in README.md in this folder. All keys, names and timestamps are
// made up; none of these bytes came from a real device.
// The bytes were produced by an independent script (not by the codec under
// test), so a codec test that round-trips through them is not circular.
export const FIXTURES = {
  cmdAppStart: '01000000000000006d65636f6e2d726561646572',
  cmdDeviceQuery: '1603',
  cmdGetContacts: '04',
  cmdGetContactsSince: '0400f15365',
  cmdSyncNextMessage: '0a',
  cmdSendTxtMsg: '02000064f15365a1a1a1a1a1a168656c6c6f20646d',
  cmdSendChannelTxtMsg: '030001c8f1536568656c6c6f206368616e6e656c',
  respOk: '00',
  respOkValue: '0007000000',
  respErrNotFound: '0102',
  respErrTableFull: '0103',
  respErrNoCode: '01',
  respDeviceInfo: '0d0a320840e201003031204a616e20323032360053796e74686574696320426f6172640000000000000000000000000000000000000000000000000076312e39392e302d73796e7468657469630000000001',
  respSelfInfo: '0501161e1111111111111111111111111111111111111111111111111111111111111111001e4903b29e43ff00000001f2440d0024f40000080853796e746865746963204e6f6465',
  respContactsStart: '0202000000',
  respContactAlice: '03a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a10100ff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000416c6963652053796e746865746963000000000000000000000000000000000000f15365c03b4703001bb70032f15365',
  respContactBob: '03b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b201000201020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000426f622053796e746865746963000000000000000000000000000000000000000af1536500000000000000003cf15365',
  respEndOfContacts: '043cf15365',
  respSent: '0601efbeaddea00f0000',
  respSentDirect: '06000df0ad0bc4090000',
  pushSendConfirmed: '82efbeadded2040000',
  pushMsgWaiting: '83',
  respContactMsgV3: '10280000a1a1a1a1a1a1ff002cf2536568692066726f6d20616c696365',
  respContactMsgV2: '07a1a1a1a1a1a102002df253656869207632',
  respChannelMsgV3: '11f8000001030090f253656368616e2068656c6c6f',
  respChannelMsgV2: '0801ff0091f253656368616e207632',
  respNoMoreMessages: '0a',
  pushAdvert: '80c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
} as const;

export type FixtureName = keyof typeof FIXTURES;

export function fixtureBytes(name: FixtureName): Uint8Array {
  const hex = FIXTURES[name];
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Synthetic public keys used by the fixtures (32 repeated bytes). */
export const SYNTHETIC_KEYS = {
  self: '11'.repeat(32),
  alice: 'a1'.repeat(32),
  bob: 'b2'.repeat(32),
  advert: 'c3'.repeat(32),
} as const;
