# BLE protocol fixtures

Synthetic frames for `../protocol.ts`. Every key (32 repeated bytes), name and
timestamp is invented. Layouts follow the sources listed at the top of
`../protocol.ts`. Integers are little-endian.

| Fixture | Direction | What it is |
|---|---|---|
| `cmdAppStart` | app to device | `CMD_APP_START`: code 1, 7 reserved zero bytes, app name `mecon-reader` |
| `cmdDeviceQuery` | app to device | `CMD_DEVICE_QUERY`: code 0x16, target protocol version 3 |
| `cmdGetContacts` | app to device | `CMD_GET_CONTACTS` without the optional `since` |
| `cmdGetContactsSince` | app to device | `CMD_GET_CONTACTS` with `since` = 1700000000 |
| `cmdSyncNextMessage` | app to device | `CMD_SYNC_NEXT_MESSAGE`: the single byte 0x0A |
| `cmdSendTxtMsg` | app to device | `CMD_SEND_TXT_MSG`: type 0 (plain), attempt 0, timestamp 1700000100, 6-byte key prefix `a1`*6, text `hello dm` |
| `cmdSendChannelTxtMsg` | app to device | `CMD_SEND_CHANNEL_TXT_MSG`: type 0, channel 1, timestamp 1700000200, text `hello channel` |
| `respOk` / `respOkValue` | device to app | `RESP_CODE_OK` without and with the optional u32 (7) |
| `respErrNotFound` / `respErrTableFull` / `respErrNoCode` | device to app | `RESP_CODE_ERR` with code 2, code 3, and no code byte |
| `respDeviceInfo` | device to app | firmware version 10, 100 contacts (50*2), 8 channels, PIN field 123456, build `01 Jan 2026`, model `Synthetic Board`, version `v1.99.0-synthetic`, repeat flag 0, path hash mode 1 |
| `respSelfInfo` | device to app | key `11`*32, lat 55.123456, lon -12.345678, radio 869.618 MHz / 62.5 kHz / SF8 / CR8, name `Synthetic Node` |
| `respContactsStart` | device to app | start of list, count 2 |
| `respContactAlice` / `respContactBob` | device to app | 148-byte contact frames; Alice has an unknown path (0xFF), Bob has a 2-hop path |
| `respEndOfContacts` | device to app | end of list with most-recent lastmod 1700000060 |
| `respSent` / `respSentDirect` | device to app | `RESP_CODE_SENT`: flood / direct, tag 0xDEADBEEF / 0x0BADF00D, suggested timeout 4000 / 2500 ms |
| `pushSendConfirmed` | device to app | `PUSH_CODE_SEND_CONFIRMED` (0x82) for tag 0xDEADBEEF, round trip 1234 ms |
| `pushMsgWaiting` | device to app | `PUSH_CODE_MSG_WAITING` (0x83) |
| `respContactMsgV3` / `respContactMsgV2` | device to app | direct message from Alice, with and without the SNR header (SNR 10.0 dB in V3) |
| `respChannelMsgV3` / `respChannelMsgV2` | device to app | channel message on channel 1 |
| `respNoMoreMessages` | device to app | `RESP_CODE_NO_MORE_MESSAGES` |
| `pushAdvert` | device to app | `PUSH_CODE_ADVERT` (0x80) with a key; the codec treats its body as opaque |
