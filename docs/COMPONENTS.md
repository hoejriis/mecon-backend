# Components and interface ownership — target

**Only the Device User Reader GUI is MVP1.** This document describes the complete future system and ownership of contracts.

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

Versioned HTTPS REST and WebSocket for account/session/capabilities, authorized messages/channels/contacts, assigned devices, send attempts/outcomes, selected offline synchronization later. Server-side enforcement is authoritative. Reader is normally served with Backend; MVP1 is served from a separate, access-restricted origin (`reader.mecon.cloud`) against the existing MECON Backend compatibility API ([Reader API contract](READER_API_CONTRACT.md), [OpenAPI](../contracts/reader-api/v1/openapi.yaml)); see [availability](MVP1_PLAN.md#restricted-reader-deployment-and-availability).

## Backend / broker / device

Backend may connect to multiple brokers concurrently. Devices use one active broker; signed MECON management authority is separate from MQTT credentials. Transparent USB Connector bridges a local device to broker, not to a second private Reader API. Direct Bluefy BLE adapter uses device capability evidence, not assumed protocol parity.

## Backend / Backend

Same-Deployment mutual authentication, direct HTTPS first, MQTT fallback, stable event identities, deterministic conflict handling, snapshots and tombstones. No executable-job replication or blanket copying of derived plaintext.

## Public contract boundaries

Native MeshCore semantics remain canonical. Generic firmware contracts live in [mecon-firmware](https://github.com/hoejriis/mecon-firmware); MECON-specific user/fleet policy lives in this application. See [target architecture](TARGET_ARCHITECTURE.md) and [security](SECURITY_AND_PRIVACY.md).

## Live packet observation API (cross-client contract)

The existing MECON Backend is the **sole implementation owner** of a versioned live packet API, to be documented with **public synthetic schemas and fixtures**. It serves two different privacy projections over common normalized reception/provenance events:

- **Anonymous public projection:** public catalogue, approved node profile/coordinates, bounded live SSE and short-lived non-identifying observation links for the [MeshContinuum public map](https://github.com/hoejriis/MeshContinuum). No raw packets, observer identities, keys, private coordinates, source endpoints or privileged metadata.
- **Authenticated capability-scoped projection:** per-authorized-user/fleet/Admin reception evidence, multi-observer packet details, optional bounded live capture and RF analytics for future web-only [Fleet Owner](FLEET_OWNER_EXPERIENCE.md) and [Admin](ADMIN_EXPERIENCE.md) interfaces (not Device User Reader tabs). Operational privileges do not grant another user's private plaintext.

Both contracts specify version, event/cursor identity, dedup/provenance, snapshot + stream reconciliation, reconnect, heartbeat, backpressure, clock confidence, retention, expiry and revocation. The website and Reader never subscribe to Backend MQTT or its SQLite database directly. **This is a contract target, not a published or verified endpoint.** See the [live observation contract](LIVE_OBSERVATION_API_CONTRACT.md).

## Transitional ownership during the MECON Backend period

The MECON Backend team implements Backend semantics, firmware integration, API contracts and **minimal private Reader screens only when needed for E2E tests** (for example FMC provisioning or live observation validation). The public application team owns all polished Reader UX, including future Fleet Owner/Admin and analytics views, and the standalone USB Connector. Public MQTT is the canonical USB Connector transport; the Backend team owns compatible broker/device envelopes, auth and job processing. The public Backend rewrite comes **last**, after Reader, USB Connector and broker interoperability have been validated against frozen contracts.

## Reader MVP2 offline continuity and desktop USB (approved target)

After the P3 Reader MVP, the Reader supports encrypted bounded offline cache, trusted local unlock, Backend-issued scoped offline leases, and **direct desktop Chromium Web Serial** to a Companion. With a valid lease, an authenticated and locally unlocked user may send/receive through authorized **BLE or USB** while the Backend is unreachable. Lease expiry blocks outbound local actions; locally unlocked private cache becomes read-only. Browser USB is separate from the headless USB-to-MQTT Connector. Updates require user-confirmed activation and safe draft/attempt-preserving migration. The private Backend remains online authority; no functionality or hardware support is claimed verified. See [Reader MVP2 design](READER_MVP2_DESIGN.md) and [ADR](ARCHITECTURE_DECISIONS.md).
