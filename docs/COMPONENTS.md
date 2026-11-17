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
