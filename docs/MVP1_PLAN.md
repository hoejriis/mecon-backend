> **Owner UX revision, 17 November 2026:** Device User web Reader follows MC1 with **Chats / Nodes / Map / Tools / Settings** bottom tabs, Channels inside Chats, and Fleet/Admin management deferred to later web-only GUI. This supersedes any three-tab or phone Fleet wording below. See [ADR](ARCHITECTURE_DECISIONS.md) and [implementation design](MVP1_IMPLEMENTATION_DESIGN.md). Backend/security and delivery sequencing remain unchanged.

# Reader-first MVP1 — delivery plan and acceptance

> **Approved MVP1 implementation baseline (17 November 2026):** [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md) governs milestone order, navigation, privacy, map, F2 deployment and acceptance. Older illustrative or five-tab descriptions are superseded where conflicting. Real hardware and Backend API conformance still require verification.

**Status:** Reader MVP issue-backed design plan; full-product replacement is separately scoped in future  issues. No coding, deployment or production cutover authorized by this document.

## Workstreams in dependency order

1. **Product, visual and navigation contracts.** Approve stock-familiar **persistent bottom Chats / Channels / Map on phone, tablet and web**, role-gated fourth **Fleet** tab for Fleet Owner/Admin on phone (equivalent to existing Devices), secondary placement of Contacts/Companion/Settings, brand usage and user acceptance. Future desktop/tablet Admin GUI design is deferred. Define bounded Map MVP acceptance without inventing public data rights.
2. **Bluefy BLE feasibility spike.** Real iPhone/iPad Bluefy + supported Companion, connection, GATT, send/receive, reconnect, screen lock and permission behavior. Record actual supported firmware/board/browser versions. No simulated hardware acceptance.
3. **MECON Backend compatibility contract.** Inventory current endpoints and central authorization; define minimal versioned contract and sanitized fixtures, then implement adapter only where needed without breaking existing Reader.
4. **New Reader shell.** React/TypeScript app, account/session context, persistent bottom navigation across viewports, role-gated phone Fleet entry, MECON brand assets and accessibility.
5. **Direct BLE Companion adapter.** Pairing, capability discovery, status, device message/send flow; source/provenance and error semantics.
6. **Messaging and Backend integration.** Chats, channels, contacts, compose, normalized outcomes, authorized identity selection, clear BLE-vs-Backend path.
7. **End-to-end acceptance.** Cross-user isolation, honest send outcomes, reconnect, duplicate prevention, Bluefy iPhone/iPad and secondary desktop browser, compatibility with current Reader.

## MVP1 launch gates

- A Device User can connect an accepted Companion from Bluefy on iPhone/iPad and read/send the supported native MeshCore message types.
- A signed-in Device User can read only messages to public/authorized channels and their assigned identities, with no private-message exposure through Fleet Owner/Admin.
- Device identity and send route are clear; no silent duplicate sends or false delivery/read acknowledgements.
- Familiarity review by a stock MeshCore user: basic chats/channels/contacts/Companion workflows discoverable without a tutorial.
- Branding follows MeshContinuum's existing brand guide without copying MeshCore artwork/UI.
- Existing MECON Backend, USB agent, MQTT and Reader continue to work. No production migration required.
- Real device/browser test evidence and known limitations documented before describing MVP1 as available.

## Release staging

**Design/feasibility** → **working local prototype** → **approved access-restricted F2 integration deployment at reader.mecon.cloud** → **hardware and privacy acceptance** → **separate owner approval for public beta/GA**.

Delegated receive identities (up to four extra), offline secure cache and fully standalone Reader are later increments, not MVP1 blockers.

## Tracking

- [Application roadmap](ROADMAP.md)

## Approved first F2 Reader integration deployment — 17 November 2026

- **URL:** `https://reader.mecon.cloud`, independently deployed on **F2**; public Reader code, private Backend unchanged as the system of record at `mecon.cloud` on F2.
- **Access:** **same existing users as `mecon.cloud`**, using its established Backend login/session and per-user capability checks. No independent users, new sign-up, additional authorization grants, or bypass via API/live updates. Fleet management is role/capability-gated; admins do not gain other users' private messages.
- **Integration:** versioned private Backend Reader API, HTTPS, secure cross-origin session/cookie/CORS/CSRF/WebSocket contract, sanitized test fixtures and auditable configuration. No private credentials or production endpoint assumptions embedded in public client code beyond explicitly approved deployment configuration.
- **First milestone:** reachable restricted Reader shell, authentication/session, Chats/Channels/Map navigation, safe empty/loading states and authorized Backend connectivity; live packet map consumes only permitted observation projection as API is delivered. BLE and complete messaging journeys can follow after real-device feasibility.
- **Coexistence:** existing `mecon.cloud` UI/Backend and MQTT/USB remain operational; no public Backend migration or cutover. This restricted integration deployment is **approved**, but is not an open public beta or proof of all MVP1 acceptance gates. Public beta/GA and production RF behavior require separate acceptance/approval.
- **Status:** approved **target**, not deployed or verified. Infrastructure, DNS/TLS, auth behavior and security tests are implementation tasks.
