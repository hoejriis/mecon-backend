# MVP1 architecture — Bluefy Reader + MECON Backend

> **Normative baseline (17 November 2026):** [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md) governs milestone order, navigation, privacy, map, restricted deployment and acceptance. Real hardware and Backend API conformance still require verification.

**Status:** Target integration design; interfaces require inventory and conformance. No new Backend implementation or migration in MVP1.

```mermaid
flowchart TD
  U["Device User · Bluefy on iPhone/iPad"]
  R["New public TypeScript/React Reader"]
  C["Assigned MeshCore Companion · BLE"]
  A["MECON Backend · versioned Reader API"]
  M["Existing MQTT / USB agent / storage"]
  U --> R
  R <-->|"Web Bluetooth · user gesture · capability gated"| C
  R <-->|"HTTPS + authorized live updates"| A
  A <--> M
```

## Responsibilities

**Reader:** MeshCore One-familiar persistent bottom **Chats / Nodes / Map / Tools / Settings** navigation across phone/tablet/web, with Channels inside Chats and no Fleet tab on any viewport (Fleet Owner/Admin management is separate, deferred, web-only work); presentation, device/transport state, user interactions, local BLE adapter, identity selection and normalized message display. No direct MQTT credentials, MECON Backend internals, fleet-management bypass or Backend business logic.

**Companion:** canonical device identity and native MeshCore BLE operations; BLE may provide local messages and sends where supported. No assumption that browser can export keys or perform all stock-app operations.

**MECON Backend:** session/auth, assigned-device authorization, authorized message history, online send, contacts/channels and outcome evidence, MQTT and USB-agent integration. Provide a **versioned, bounded compatibility API**. Preserve current Reader and existing production behavior.

## Critical integration rule

There are **two possible send/read paths** (direct BLE and online Backend). MVP1 must define an explicit active path, source provenance, stable message/attempt IDs and outcome mapping. **Never silently transmit the same draft through both paths** or merge local device messages into the wrong account. If safe dedup/reconciliation is unavailable, keep paths separate and show that limitation; do not imply full cross-source history or automatic failover.

## Browser support

**Primary target:** Bluefy on iOS/iPadOS with Web Bluetooth, subject to real-device proof and device GATT compatibility; not yet tested on hardware. Android Chrome Web Bluetooth may be used in simulation and is not physical verification. **Secondary:** desktop Chromium Web Bluetooth where supported. **Fallback:** Backend-only Reader in browsers without compatible BLE. Standard iOS Safari is not a promised BLE path. BLE access is permission- and foreground-sensitive; background behavior must be verified, not assumed.

## MVP1 API inventory

- Session, account and capability scope
- Assigned Companion list and authorized identities
- Conversations/messages with paging and provenance
- Channels/contacts/favourites with actual access rules
- Authorized send request and normalized outcomes
- Device status and transport/reachability evidence
- Live update subscription/reconnect where supported

Do not publish private production URLs, credentials, customer data or internal source code in this public repository. Build sanitized fixtures and contract tests.

## Deferred

Offline encrypted history and local unlock, automatic BLE/Backend event reconciliation, the web-only Fleet Owner/Admin management GUI, advanced observation analytics, public Backend implementation, OTA and firmware protocol expansion.

[Product vision](PRODUCT_VISION.md) · [UX](READER_UX.md) · [MVP plan](MVP1_PLAN.md) · [Reader API contract](READER_API_CONTRACT.md) · [OpenAPI](../contracts/reader-api/v1/openapi.yaml) · [Acceptance](MVP1_ACCEPTANCE.md)

## Restricted Reader deployment and availability

**Approved 17 November 2026; availability as of 18 November 2026.** The first Reader deployment is an access-restricted integration environment at `https://reader.mecon.cloud`, independently deployed from the public Reader code and connected to the existing Backend at `mecon.cloud`. It is **not** a public beta, a cutover or a public Backend replacement.

- **Access:** exactly the existing `mecon.cloud` users, through the Backend's own login, session and per-user capability checks. No independent user store, self-signup, extra grants or bypass through the API or live updates. Administrators and Fleet Owners do not gain other users' private messages.
- **Integration:** the versioned Reader API ([contract](READER_API_CONTRACT.md), [OpenAPI](../contracts/reader-api/v1/openapi.yaml)), HTTPS, a secure cross-origin session/CSRF/live-update arrangement, sanitized fixtures and auditable configuration. No private credentials in public client code.
- **Coexistence:** the existing `mecon.cloud` UI, Backend, MQTT and USB agent stay in service.
- **Separate gates:** public beta/GA and production RF writes each need their own acceptance and approval. Nothing in the restricted deployment waits for, or is blocked by, those gates or by real-hardware Bluefy results.

| Status | What |
|---|---|
| **Deployed (restricted, existing `mecon.cloud` users only)** | The Reader shell with the five-tab navigation (Chats / Nodes / Map / Tools / Settings), the login client, the design system and a read-only Bluetooth diagnostics page. The Reader API is routed to the existing Backend (signed-out checks pass); signed-in acceptance with test accounts has not yet run, so verified sign-in is not claimed. |
| **Implemented, not verified live** | The Backend-path messaging client, written against a draft contract. |
| **Simulated only** | The BLE Companion adapter, exercised through an Android Chrome profile simulation; not verified on hardware. Bluefy on iPhone/iPad still awaits real-hardware testing. |
| **Planned** | Live observation Map, contacts, offline cache, safe updates, USB access and the public Backend replacement. |

Evidence is recorded in the [acceptance matrix](MVP1_ACCEPTANCE.md); the normative design is [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md). Nothing here implies public availability or verified full messaging.
