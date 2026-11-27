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

- [Components and contracts](docs/COMPONENTS.md) and [migration status](docs/MIGRATION_STATUS.md)
- [Deployment models, multi-site operation and recovery](docs/DEPLOYMENTS.md)
- [Roadmap — active MVP versus future target](docs/ROADMAP.md)

## The Reader experience

A web Reader for Device Users, targeting Bluefy on iPhone/iPad, with MeshCore One-familiar **Chats / Nodes / Map / Tools / Settings** bottom navigation (Channels inside Chats), MECON's original colors/mark, BLE connection to a supported Companion and authorized online history/messaging through an authorized MECON Backend. The GUI is inspired by [MeshCore One](https://github.com/Avi0n/MeshCoreOne) but is original React/TypeScript work under Apache-2.0; no GPLv3 MC1 code or artwork is copied. Fleet Owner and Admin management is separate, deferred, web-only work and is not a Reader tab. Browser and hardware support vary; consult the [availability record](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md).

**Current availability (as of 2026-11-27).** Terms: *merged* means code is in this repository; *deployed* means served by the restricted Reader; *accepted* means a physical or release acceptance check has passed. Details and evidence: [restricted deployment and availability](docs/DEPLOYMENTS.md#restricted-reader-deployment-and-availability), [migration status](docs/MIGRATION_STATUS.md), [acceptance evidence](docs/MVP1_ACCEPTANCE.md).

- **Public production service: none.** No Backend from this repository serves users. The existing hosted Backend remains the only production Backend, and nothing here replaces it.
- **Restricted deployed Reader** (existing hosted-Backend users only, on a separate restricted origin, release v0.9.4): the five-tab Reader shell, login client, design system and read-only Bluetooth diagnostics, routed to the existing Backend. v0.9.3 was build-only; v0.9.5 and v0.9.6 change the Connector and the contracts, not the served Reader. Implemented and deployed in the restricted Reader, awaiting acceptance: the offline cache and leases, safe updates and USB access.
- **Physical UAT pending:** BLE and USB Companion use on real hardware, Bluefy on iPhone/iPad, a real passkey on a phone, and the USB hardware acceptance session. The Backend-path messaging client and local sends are implemented but not accepted on hardware, and no lease from a real Backend has been exercised on hardware.
- **Code merged, not deployed:** the public Reader facade (`reader-backend/`), which serves REST and server-sent events (SSE) and reaches a core through the session-lookup and reader-core contracts (its `HttpSessionLookup` and `HttpReaderCore` adapters), run only against fakes and a stub. No public core implementation exists yet, and an interop run against the reference Backend's reader-core is pending. Also merged and not deployed: observation processing.
- **Test bench only:** the USB Connector. Release v0.9.6 (serial DFU, the enrolment-gate probe classification and the clean DFU stop) runs as a service on a test bench against the hosted Backend. There is no user deployment yet.
- **Shadow trial:** the public capture service (release v0.9.2) has run since 2026-11-25 as a bounded 7-day subscribe-only shadow trial beside the hosted Backend. As last recorded it was connected and subscribed but had received no observation traffic, so there is no capture-parity evidence and nothing has been cut over.
- **Target:** the live observation Map (its anonymous public feed is specified as a contract, `contracts/public-map/v1`, and not served by anything in this repository), contacts and the staged public Backend, described in the [target architecture](docs/TARGET_ARCHITECTURE.md).

This is not a public release.

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
