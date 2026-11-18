# BLE Companion adapter (foundation)

Browser BLE adapter for a MeshCore Companion, built and tested against a
simulated device. **Every result is SIMULATED, not Android hardware verified.**
Real Android Chrome and iOS Bluefy behaviour is unverified until tested on
devices.

- `protocol.ts`: transport-agnostic frame codec for the supported subset (device
  query and app start, self info, contact list, next message, send direct text,
  send channel text, sent and ACK pushes, error codes). The header lists the exact
  upstream sources and commit SHAs, and every uncertain detail is marked
  `UNVERIFIED`. No key export or any private-key handling exists.
- `transport.ts`, `webBluetoothTransport.ts`: `BleTransport` and its Web Bluetooth
  implementation (one frame per GATT write, no chunking, chooser only from a user
  gesture, explicit `unsupported`).
- `adapter.ts`: state machine with separate facts: `bleConnection`,
  `deviceAccepted`, `rfTransmitted`, `dmAck`, `unknown`. An attempt is written at
  most once; after an uncertain outcome it is never resent over BLE and never
  routed to the Backend. A new explicit user action uses a new attempt id.
  Nothing is stored (no storage API is used).
- `mockCompanion.ts`, `fakeBluetooth.ts`: simulated GATT peer with injectable
  faults, and a fake `navigator.bluetooth` over it.
- `BleDevPage.tsx`: harness at `/dev/ble`, dev builds only. Production builds
  omit the harness; BLE code is only in the lazy probe chunk (checked by `e2e/ble-prod.spec.ts`).
- `probe/`: the production, read-only probe page at `/probe/ble` (shared detection, read-only frame allowlist, sanitized report that includes the detected firmware, role and capabilities); see `docs/BLE_PROBE.md`.
- `BleSessionDevPage.tsx`: dev-only harness at `/dev/ble-session` for the shared device session over Bluetooth (below).
- `fixtures/`: synthetic byte fixtures, documented in `fixtures/README.md`.

`npm run e2e` writes `e2e-artifacts/ble-simulation-matrix.md`.

## USB (Web Serial)

The same adapter runs over USB. `transport.ts` defines `CompanionTransport`
(`kind: 'ble' | 'usb'`; `BleTransport` and `DeviceTransport` are aliases).
`serialFraming.ts` is the Companion serial wrapper (marker, 16-bit length,
payload) with a streaming deframer that resyncs on garbage and refuses lengths
above `MAX_FRAME_SIZE`; its header lists the sources and the UNVERIFIED items.
The USB transport, device identification, the read-only probe and the
simulation live in `../device/` (see `docs/DEVELOPMENT.md`, "USB device
access", and `docs/USB_PROBE.md`). All results are SIMULATED, not hardware
verified.

## Bluetooth on the shared device layer

BLE now sits on the same role-agnostic layer as USB (`../device/`). The Companion
binary adapter above is unchanged, with every send-safety guarantee and test, and
becomes the secondary driver:

- **Detection** (`../device/detect.ts`, `detectBleDevice`): after the BLE connect,
  the interface `hello` as `0x7F` (`CMD_MECON`) frames, then the Companion device
  query, with no console step (BLE has no console, and only Companions have BLE).
  The result is the same `DetectedDevice` as on USB: "MECON firmware vX, role R,
  capabilities ..." or "not MECON / unknown". The BLE device name is never read.
  Every write passes the read-only frame guard (`../device/guard.ts`).
- **One session** (`../device/session.ts`): `DeviceSession` takes either a USB byte
  transport or a BLE `CompanionTransport` and produces the same snapshot. Features
  are gated on detected capabilities (`can(...)`), the Companion adapter attaches
  only when the device answered Companion frames (its attempts then record
  `path: 'ble'`), and `request(op)` sends one read-only interface request.
- **Link trust** (`../device/trust.ts`): USB is `trusted`; BLE is `unknown`, because
  Web Bluetooth cannot say whether the bond used a default PIN (`0` or `123456`)
  or a custom one. On an unknown link the session requests class `read` operations
  only and refuses every other class, and any operation of unknown class, before
  anything is written. A default-PIN link may be refused `hello`; that shows as
  `interfaceRefused`, not as an identification.
- **Simulation**: `MockCompanion` answers `0x7F` as a MECON Companion
  (`mecon: true`), as a stock Companion does not (error frame, the default), or
  not at all (`silent: true`); `helloRefused` models a link the device does not
  trust. The fake `navigator.bluetooth` is built on it.

Sources: hoejriis/mecon-firmware @ `6bfff48c9d3dec9ad8a0219309db2a01c1a3077a`,
`docs/contract/DEVICE_INTERFACE.md` (sections 3, 4 and 7), `OPERATIONS.md`,
`AUTHORITY.md` (sections 3.5 and 9) and `fixtures/framing.json`; no GPL client
was read. UNVERIFIED: that Web Bluetooth exposes no PIN state in any browser; that
a real MECON Companion answers `0x7F` over BLE exactly as over USB; what a real
default-PIN link answers to `hello`. All results are SIMULATED, not hardware verified.
