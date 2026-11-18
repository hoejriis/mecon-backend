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
- `probe/`: the production, read-only probe page at `/probe/ble` (allowlisted commands, sanitized report); see `docs/BLE_PROBE.md`.
- `fixtures/`: synthetic byte fixtures, documented in `fixtures/README.md`.

`npm run e2e` writes `e2e-artifacts/ble-simulation-matrix.md`.
