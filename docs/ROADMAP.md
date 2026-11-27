# Application roadmap

MeshContinuum's application grows from a familiar messaging Reader into a self-hostable service for people and communities operating MeshCore networks. The architecture is designed to work locally first, with optional multi-site connectivity. See the [target architecture](TARGET_ARCHITECTURE.md) and [product vision](PRODUCT_VISION.md).

## Reader for everyday messaging

The first application experience focuses on Device Users: chats (with channels inside), nodes, map, tools, contacts, Companion selection and reliable explanations of what a message's status actually means.

- Direct Web Bluetooth access to a compatible Companion where the browser and hardware support it.
- Account-authorized online history and messaging through a versioned Backend API.
- Clear separation between local BLE and Backend send/read paths, including provenance and acknowledgements.
- MeshCore One-inspired GUI workflows with original React components, official MECON branding and existing Apache-2.0 license.
- Privacy boundaries that prevent administrators and fleet owners from reading other users' private messages.

The [Reader architecture](MVP1_ARCHITECTURE.md), [experience design](READER_UX.md) and [delivery and acceptance](MVP1_PLAN.md) describe this first increment. Hardware and browser compatibility must be demonstrated before it is advertised as available. A restricted shell is deployed for existing users; see the [availability table](MVP1_PLAN.md#restricted-reader-deployment-and-availability).

## Future native Apple Reader

The separate `mecon-app` will fork [MeshCore One](https://github.com/Avi0n/MeshCoreOne) to reuse its native iOS/iPadOS features as much as practical and integrate MECON Backend online services under the same authorization and messaging contracts. MC1 application code is GPLv3; verify dependency licenses, source obligations, upstream maintenance and distribution before release. The React web Reader remains mandatory; Fleet Owner and Instance Admin GUI use cases remain **web-only**. This is target direction, not implemented or verified.

## Fleet operations and administration

Fleet Owners gain device inventory, assignment, configuration, diagnostics and observation-sharing controls. Instance Administrators manage deployments, accounts, infrastructure, public sources and security. Permissions remain composable; owning or administering a device does not grant access to its user's private conversations.

## Self-hosting, continuity and resilience

The complete application brings together a Python/FastAPI Backend, served TypeScript/React Reader, SQLite state, a standard MQTT broker and optional transparent USB Connector. It is designed for a single small site first, then trusted multi-Backend federation, continuity and recovery. A secure local Reader cache and broader offline support are later capabilities.

See [deployments](DEPLOYMENTS.md), [components](COMPONENTS.md), [security](SECURITY_AND_PRIVACY.md) and [roles](ROLES_AND_PERMISSIONS.md).

## Staged public Backend

The Backend moves into this repository one testable block at a time: the contract and synthetic conformance cases live here, the private reference Backend replays them in its own CI, and a block has moved when a public implementation passes the same cases and runs behind a switch with a tested way back. The order is capture and processing, then the observation contracts, the Reader API facade, the job lifecycle and device dispatch, and last the core (accounts, identity, key custody, domain persistence, federation).

**Shipped so far (merged, none serving users):** contracts with conformance cases or fixtures for the Reader API, session lookup, reader-core, observations, the anonymous public map feed, observation capture and processing, job lifecycle and device dispatch; public capture and processing services; the Reader facade with its session-lookup and reader-core HTTP adapters, which serves REST and SSE and has run only against fakes and a stub. **Next:** an interop run of the facade against the reference Backend's reader-core, and then a public core, with message history, deduplication and send outcomes. **Planned, not built:** the anonymous public map feed in a public Backend, job lifecycle and device dispatch implementations, and the core. Per-block status and the conformance replays are in [migration status](MIGRATION_STATUS.md).

## Availability

The roadmap describes intended capabilities, not a claim that they are implemented. See the [public availability statement](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md) for current software and hardware evidence.

## Reader MVP2 offline continuity and desktop USB (approved target)

After the P3 Reader MVP, the Reader supports encrypted bounded offline cache, trusted local unlock, Backend-issued scoped offline leases, and **direct desktop Chromium Web Serial** to a Companion. With a valid lease, an authenticated and locally unlocked user may send/receive through authorized **BLE or USB** while the Backend is unreachable. Lease expiry blocks outbound local actions; locally unlocked private cache becomes read-only. Browser USB is separate from the headless USB-to-MQTT Connector. Updates require user-confirmed activation and safe draft/attempt-preserving migration. The private Backend remains online authority; no functionality or hardware support is claimed verified. See [Reader MVP2 design](READER_MVP2_DESIGN.md) and [ADR](ARCHITECTURE_DECISIONS.md).
