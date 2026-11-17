# MeshContinuum — public Backend and Reader

The public application repository for **MECON**, beginning with a **Bluefy-enabled, Device User-focused web Reader** inspired by the familiar workflows of the stock MeshCore app, but with MECON's original identity and interface.

> **Status (17 November 2026): documentation and MVP planning only.** No Reader code, public Backend implementation, supported release or public installation is available here yet. The first Reader MVP will integrate with the **existing private Backend**, not replace it.

## Start here

- [Product vision and MVP boundaries](docs/PRODUCT_VISION.md)
- [Reader navigation, interaction and MECON visual language](docs/READER_UX.md)
- [User, fleet and administrator access model](docs/ACCESS_MODEL.md)
- [Bluefy BLE and private Backend integration architecture](docs/MVP1_ARCHITECTURE.md)
- [Implementation sequence and acceptance gates](docs/MVP1_PLAN.md)

## Repositories

- [MeshContinuum](https://github.com/hoejriis/MeshContinuum) — product, public documentation and visual identity
- [mecon-firmware](https://github.com/hoejriis/mecon-firmware) — device firmware and public contracts
- [deimos-mesh](https://github.com/hoejriis/deimos-mesh/issues/35) — existing private Backend and transition programme

MECON is independent of MeshCore. It is not an official MeshCore app; stock MeshCore devices and apps remain supported separately. Do not submit private keys, credentials, real messages or private deployment data in public issues.
