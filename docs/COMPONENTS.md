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

Versioned HTTPS REST and WebSocket for account/session/capabilities, authorized messages/channels/contacts, assigned devices, send attempts/outcomes, selected offline synchronization later. Server-side enforcement is authoritative. Reader is normally served with Backend; MVP1 may use a separate development origin against the existing private Backend compatibility API.

## Backend / broker / device

Backend may connect to multiple brokers concurrently. Devices use one active broker; signed MECON management authority is separate from MQTT credentials. Transparent USB Connector bridges a local device to broker, not to a second private Reader API. Direct Bluefy BLE adapter uses device capability evidence, not assumed protocol parity.

## Backend / Backend

Same-Deployment mutual authentication, direct HTTPS first, MQTT fallback, stable event identities, deterministic conflict handling, snapshots and tombstones. No executable-job replication or blanket copying of derived plaintext.

## Public contract boundaries

Native MeshCore semantics remain canonical. Generic firmware contracts live in [mecon-firmware](https://github.com/hoejriis/mecon-firmware); MECON-specific user/fleet policy lives in this application. See [target architecture](TARGET_ARCHITECTURE.md) and [security](SECURITY_AND_PRIVACY.md).

## Live packet observation API (cross-client contract)

The existing private Backend is the **sole implementation owner** of a versioned live packet API, to be documented with **public synthetic schemas and fixtures**. It serves two different privacy projections over common normalized reception/provenance events:

- **Anonymous public projection:** public catalogue, approved node profile/coordinates, bounded live SSE and short-lived non-identifying observation links for the [MeshContinuum public map](https://github.com/hoejriis/MeshContinuum/issues/22). No raw packets, observer identities, keys, private coordinates, source endpoints or privileged metadata.
- **Authenticated capability-scoped projection:** per-authorized-user/fleet/Admin reception evidence, multi-observer packet details, optional bounded live capture and RF analytics for future [Fleet Owner](https://github.com/hoejriis/mecon-backend/issues/17) and [Admin](https://github.com/hoejriis/mecon-backend/issues/18) Reader interfaces. Operational privileges do not grant another user's private plaintext.

Both contracts specify version, event/cursor identity, dedup/provenance, snapshot + stream reconciliation, reconnect, heartbeat, backpressure, clock confidence, retention, expiry and revocation. The website and Reader never subscribe to Backend MQTT or its SQLite database directly. **This is a contract target, not a published or verified endpoint.**

## Transitional ownership during the private Backend period

The private Backend team implements Backend semantics, firmware integration, API contracts and **minimal private Reader screens only when needed for E2E tests** (for example FMC provisioning or live observation validation). The public application team owns all polished Reader UX, including future Fleet Owner/Admin and analytics views, and the standalone USB Connector. Public MQTT is the canonical USB Connector transport; the Backend team owns compatible broker/device envelopes, auth and job processing. The public Backend rewrite comes **last**, after Reader, USB Connector and broker interoperability have been validated against frozen contracts.
