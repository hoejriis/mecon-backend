# Components and interface ownership — target

**Only the Device User Reader GUI is MVP1.** This document describes the complete future system and ownership of contracts. The migration of Backend blocks into this repository is staged; see [migration status](MIGRATION_STATUS.md) for what exists.

| Component | Responsibility | Must not do |
|---|---|---|
| Reader (React/TypeScript) | GUI, capability-aware navigation, direct supported BLE/USB, selected offline cache later | Online MQTT login, Backend business logic, private-key custody, admin bypass |
| Backend (Python/FastAPI) | Session/auth, user/fleet authorization, message/observation history, send orchestration, device jobs, federation | Implicitly treat operator as user, infer RF ACK/read receipts |
| SQLite | Application state and authorized history per Backend | Serve as MQTT broker or federation transport |
| Mosquitto | Transparent MQTT routing/ACL, public/private transport profiles | Decrypt traffic, own identities, decide sharing permissions |
| USB Connector | Transparent serial↔MQTT bridge for attached radio | Inspect plaintext, substitute identity, choose packet routes |
| mecon-firmware | Generic managed-device interfaces, telemetry, updates, native send/receive | Require MECON Backend, override native MeshCore RF independence |
| Companion | Canonical MeshCore identity, native RF, local BLE/USB | Delegate send-as merely from receive delegation |

## Reader / Backend contract

Versioned HTTPS REST and server-sent events (SSE, not WebSocket) for account/session/capabilities, authorized messages/channels/contacts, assigned devices, send attempts/outcomes, selected offline synchronization later. Server-side enforcement is authoritative. Reader is normally served with Backend; MVP1 is served from a separate, access-restricted origin against the existing MECON Backend compatibility API ([Reader API contract](READER_API_CONTRACT.md), [OpenAPI](../contracts/reader-api/v1/openapi.yaml)); see [availability](MVP1_PLAN.md#restricted-reader-deployment-and-availability).

## Facade and core (staged migration)

The public Reader facade (`reader-backend/`, merged and not deployed) serves the Reader API and the authorized observation projection. It reaches a core only through two contracts, each with synthetic conformance cases in this repository:

- [`session-lookup/v1`](../contracts/session-lookup/v1/openapi.yaml): who a session is, and the revocation feed (adapter: `HttpSessionLookup`).
- [`reader-core/v1`](../contracts/reader-core/v1/openapi.yaml): one operation per core-owned capability, such as conversations, send attempts, the event feed and leases (adapter: `HttpReaderCore`).

These are internal routes on a private network, gated by a per-deployment service token; they must never be exposed through a public reverse proxy. No public core implementation exists yet; the facade has run only against fakes and a stub. See [migration status](MIGRATION_STATUS.md).

## Backend / broker / device

Backend may connect to multiple brokers concurrently. Devices use one active broker; signed MECON management authority is separate from MQTT credentials. Transparent USB Connector bridges a local device to broker, not to a second private Reader API. Direct Bluefy BLE adapter uses device capability evidence, not assumed protocol parity.

## Backend / Backend

Same-Deployment mutual authentication, direct HTTPS first, MQTT fallback, stable event identities, deterministic conflict handling, snapshots and tombstones. No executable-job replication or blanket copying of derived plaintext.

## Public contract boundaries

Native MeshCore semantics remain canonical. Generic firmware contracts live in [mecon-firmware](https://github.com/hoejriis/mecon-firmware); MECON-specific user/fleet policy lives in this application. See [target architecture](TARGET_ARCHITECTURE.md) and [security](SECURITY_AND_PRIVACY.md).

## Live packet observation API (cross-client contract)

Two privacy projections over common normalized reception events, each with its own machine-readable contract and synthetic fixtures:

- **Anonymous public projection:** [`contracts/public-map/v1`](../contracts/public-map/v1/openapi.yaml) (`1.0.0-draft.1`), served at `/api/public/v1`: `GET /nodes` and a **polled** `GET /events` with a `since` cursor. It is a polled feed, not SSE, and it supersedes the earlier target path `/api/observations/v1/public`. It is described from the behaviour the reference Backend ships; nothing in this repository serves it yet. No raw packets, observer identities, keys, private coordinates, source endpoints or privileged metadata. It feeds the [MeshContinuum public map](https://github.com/hoejriis/MeshContinuum).
- **Authenticated capability-scoped projection:** [`contracts/observations/v1`](../contracts/observations/v1/openapi.yaml) (`1.0.0-draft.4`) under `/api/observations/v1/authorized`: per-authorized-user reception evidence with a bounded SSE stream. Direct receptions only (nothing inferred; null means not reported), and an `observer_id` is scoped to the caller. The facade in `reader-backend/` serves it and passes all 14 published cases. Fleet Owner and Admin analytics are future web-only [Fleet Owner](FLEET_OWNER_EXPERIENCE.md) and [Admin](ADMIN_EXPERIENCE.md) interfaces, not Device User Reader tabs. Operational privileges do not grant another user's private plaintext.

The website and Reader never subscribe to Backend MQTT or its SQLite database directly. See the [live observation contract](LIVE_OBSERVATION_API_CONTRACT.md).

## Transitional ownership during the MECON Backend period

The MECON Backend team implements Backend semantics, firmware integration, API contracts and **minimal private Reader screens only when needed for E2E tests** (for example FMC provisioning or live observation validation). The public application team owns all polished Reader UX, including future Fleet Owner/Admin and analytics views, and the standalone USB Connector. Public MQTT is the canonical USB Connector transport; the Backend team owns compatible broker/device envelopes, auth and job processing. The public Backend moves in testable blocks (see [migration status](MIGRATION_STATUS.md)): capture and processing, the observation contracts, the Reader API facade, the job lifecycle and device dispatch, and the core (accounts, identity, key custody, domain persistence, federation) last.

## Reader MVP2 offline continuity and desktop USB (approved target)

After the P3 Reader MVP, the Reader supports encrypted bounded offline cache, trusted local unlock, Backend-issued scoped offline leases, and **direct desktop Chromium Web Serial** to a Companion. With a valid lease, an authenticated and locally unlocked user may send/receive through authorized **BLE or USB** while the Backend is unreachable. Lease expiry blocks outbound local actions; locally unlocked private cache becomes read-only. Browser USB is separate from the headless USB-to-MQTT Connector. Updates require user-confirmed activation and safe draft/attempt-preserving migration. The private Backend remains online authority; no functionality or hardware support is claimed verified. See [Reader MVP2 design](READER_MVP2_DESIGN.md) and [ADR](ARCHITECTURE_DECISIONS.md).
