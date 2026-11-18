# MECON Backend & Reader

The public application architecture for [MeshContinuum (MECON)](https://github.com/hoejriis/MeshContinuum): a familiar MeshCore messaging Reader, fleet operations, observation history and a self-hostable Backend for individuals and small communities.

The application combines a familiar MeshCore Reader, fleet operations, observation history and a self-hostable Backend. Explore the intended product below; [availability](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md) separately explains what is ready to use.

## Start with the product

- [Overall target architecture](docs/TARGET_ARCHITECTURE.md)
- [User experience — messaging and Companions](docs/USER_EXPERIENCE.md)
- [Fleet Owner experience — devices, assignments, sharing](docs/FLEET_OWNER_EXPERIENCE.md)
- [Instance Administrator experience — infrastructure and accounts](docs/ADMIN_EXPERIENCE.md)
- [Roles and GUI permissions](docs/ROLES_AND_PERMISSIONS.md)
- [Security and privacy](docs/SECURITY_AND_PRIVACY.md)

## Understand the system

- [Components and contracts](docs/COMPONENTS.md)
- [Deployment models, multi-site operation and recovery](docs/DEPLOYMENTS.md)
- [Roadmap — active MVP versus future target](docs/ROADMAP.md)

## The Reader experience

A web Reader for Device Users, targeting Bluefy on iPhone/iPad, with MeshCore One-familiar **Chats / Nodes / Map / Tools / Settings** bottom navigation (Channels inside Chats), MECON's original colors/mark, BLE connection to a supported Companion and authorized online history/messaging through an authorized MECON Backend. The GUI is inspired by [MeshCore One](https://github.com/Avi0n/MeshCoreOne) but is original React/TypeScript work under Apache-2.0; no GPLv3 MC1 code or artwork is copied. Fleet Owner and Admin management is separate, deferred, web-only work and is not a Reader tab. Browser and hardware support vary; consult the [availability record](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md).

**Current availability (2026-11-18, conservative).** Deployed, restricted to existing `mecon.cloud` users: the Reader shell at `https://reader.mecon.cloud` with five-tab navigation, login client, design system and a read-only Bluetooth diagnostics page; the Reader API is routed to the existing Backend (signed-out checks pass), but signed-in acceptance with test accounts has not yet run, so verified sign-in is not claimed. Implemented but not verified live: the Backend-path messaging client (against a draft contract). Simulated only: the BLE Companion adapter (Android Chrome profile; not hardware verified); Bluefy/iOS awaits real-hardware testing. Planned: live observation Map, contacts, offline cache, safe updates, USB and the public Backend replacement. This is not a public release. Details: [restricted deployment and availability](docs/MVP1_PLAN.md#restricted-reader-deployment-and-availability), [acceptance evidence](docs/MVP1_ACCEPTANCE.md).

- [MVP product vision](docs/PRODUCT_VISION.md)
- [Reader interaction specification](docs/READER_UX.md)
- [Reader BLE and Backend integration](docs/MVP1_ARCHITECTURE.md)
- [MVP delivery plan](docs/MVP1_PLAN.md) and [acceptance matrix](docs/MVP1_ACCEPTANCE.md)
- [Normative implementation design](docs/MVP1_IMPLEMENTATION_DESIGN.md), [Reader API contract](docs/READER_API_CONTRACT.md) and [OpenAPI](contracts/reader-api/v1/openapi.yaml)



## Related public repositories

- [MeshContinuum](https://github.com/hoejriis/MeshContinuum) — product story, branding, roadmap, hosted-beta context and public-facing documentation.
- [mecon-firmware](https://github.com/hoejriis/mecon-firmware) — independent managed-device firmware and contracts, hardware evidence and releases.

MECON is independent of [MeshCore](https://github.com/meshcore-dev/MeshCore); no official affiliation is implied. Protect private messages, device keys, credentials and sensitive deployment information.


## Architecture decisions

Before proposing changes to roles, fleets, devices, trust, messaging or federation, consult the [Architecture decisions](docs/ARCHITECTURE_DECISIONS.md). Accepted decisions should not be reopened without a documented change; unresolved matters are listed separately.
