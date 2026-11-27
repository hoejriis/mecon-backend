# Reader-first MVP1 — delivery plan and acceptance

> **Normative baseline (17 November 2026):** [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md) governs milestone order, navigation, privacy, map, restricted deployment and acceptance; this plan summarizes its delivery sequence. Real hardware and Backend API conformance still require verification.

**Status:** Reader MVP delivery plan. The full-product (public Backend) replacement is separately scoped and not part of MVP1. This document authorizes no production cutover; the restricted deployment below is approved separately.

## Workstreams in dependency order

1. **Product, visual and navigation contracts.** MeshCore One-familiar **persistent bottom Chats / Nodes / Map / Tools / Settings on phone, tablet and web**, with Channels inside Chats and no Fleet tab on any viewport. Fleet Owner/Admin management is separate, deferred, web-only work. Brand usage and user acceptance; bounded Map MVP acceptance without inventing public data rights.
2. **Bluefy BLE feasibility spike.** Real iPhone/iPad Bluefy + supported Companion, connection, GATT, send/receive, reconnect, screen lock and permission behavior. Record actual supported firmware/board/browser versions. Android Chrome Web Bluetooth simulation is permitted for development but is never reported as physically verified, and real-hardware Bluefy evidence gates the BLE claim, not the restricted shell.
3. **MECON Backend compatibility contract** ([Reader API contract](READER_API_CONTRACT.md), [OpenAPI](../contracts/reader-api/v1/openapi.yaml)). Inventory current endpoints and central authorization; define minimal versioned contract and sanitized fixtures, then implement adapter only where needed without breaking existing Reader.
4. **New Reader shell.** React/TypeScript app, account/session context, the five-tab persistent bottom navigation across viewports, MECON brand assets and accessibility.
5. **Direct BLE Companion adapter.** Pairing, capability discovery, status, device message/send flow; source/provenance and error semantics.
6. **Messaging and Backend integration.** Chats (with Channels inside), nodes, contacts, compose, normalized outcomes, authorized identity selection, clear BLE-vs-Backend path.
7. **End-to-end acceptance.** Cross-user isolation, honest send outcomes, reconnect, duplicate prevention, Bluefy iPhone/iPad and secondary desktop browser, compatibility with current Reader.

## MVP1 launch gates

- A Device User can connect an accepted Companion from Bluefy on iPhone/iPad and read/send the supported native MeshCore message types.
- A signed-in Device User can read only messages to public/authorized channels and their assigned identities, with no private-message exposure through Fleet Owner/Admin.
- Device identity and send route are clear; no silent duplicate sends or false delivery/read acknowledgements.
- Familiarity review by a stock MeshCore user: basic chat, channel, node, contact and Companion workflows discoverable without a tutorial.
- Branding follows MeshContinuum's existing brand guide; the GUI is original React/TypeScript work inspired by MeshCore One, with no GPLv3 MC1 code or artwork copied.
- Existing MECON Backend, USB agent, MQTT and Reader continue to work. No production migration required.
- Real device/browser test evidence and known limitations documented before describing MVP1 as available.

## Release staging

**Design/feasibility** → **access-restricted integration deployment (approved; shell deployed)** → **Backend-connected messaging and map** → **BLE hardware and privacy acceptance** → **separate owner approval for public beta/GA**. The restricted deployment does not wait for the later stages; public beta/GA and production RF writes do.

Delegated receive identities (up to four extra), offline secure cache and fully standalone Reader are later increments, not MVP1 blockers.

## Tracking

- [Application roadmap](ROADMAP.md)
- [Acceptance matrix and evidence](MVP1_ACCEPTANCE.md)

## Restricted Reader deployment and availability

**Approved 17 November 2026; availability as of 27 November 2026.** The first Reader deployment is an access-restricted integration environment, independently deployed from the public Reader code and connected to the existing hosted Backend. It is **not** a public beta, a cutover or a public Backend replacement.

- **Access:** exactly the existing hosted-Backend users, through the Backend's own login, session and per-user capability checks. No independent user store, self-signup, extra grants or bypass through the API or live updates. Administrators and Fleet Owners do not gain other users' private messages.
- **Integration:** the versioned Reader API ([contract](READER_API_CONTRACT.md), [OpenAPI](../contracts/reader-api/v1/openapi.yaml)), HTTPS, a secure cross-origin session/CSRF/live-update arrangement, sanitized fixtures and auditable configuration. No private credentials in public client code.
- **Coexistence:** the existing hosted Backend's UI, Backend, MQTT and USB agent stay in service.
- **Separate gates:** public beta/GA and production RF writes each need their own acceptance and approval. Nothing in the restricted deployment waits for, or is blocked by, those gates or by real-hardware Bluefy results.

| Status | What |
|---|---|
| **Deployed (restricted, existing hosted-Backend users only)** | The Reader shell with the five-tab navigation (Chats / Nodes / Map / Tools / Settings), the login client, the design system and a read-only Bluetooth diagnostics page. The Reader API is routed to the existing Backend. Live acceptance with two test users passed on 2026-11-19 (33 passed, 1 manual row skipped), as the [acceptance matrix](MVP1_ACCEPTANCE.md) records. |
| **Deployed, awaiting acceptance** | The encrypted offline cache with Backend-issued leases, safe updates with confirmed activation, USB access and the Backend-path messaging client. Each is checked by its own tests and, where the matrix says so, live with test users; each waits on a hands-on acceptance step on real hardware or a real passkey. The Map's live observation view passes its live checks for one test user (only `scope=self` requests, pins for located observers); the two-user comparison has not run. |
| **Simulated only** | The BLE Companion adapter, exercised through an Android Chrome profile simulation; not verified on hardware. Bluefy on iPhone/iPad still awaits real-hardware testing. |
| **Planned** | Contacts, and the public Backend. The public Backend moves in testable blocks (see the [migration status](MIGRATION_STATUS.md)) and does not replace the hosted Backend. |

Evidence is recorded in the [acceptance matrix](MVP1_ACCEPTANCE.md); the normative design is [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md). Nothing here implies public availability or verified full messaging.
