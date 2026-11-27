# Reader MVP1 — approved implementation design and delivery gates

**Status:** approved target UX, architecture and restricted deployment (17 November 2026). This document is implementation-ready for the Reader shell and design system. It is **not** evidence of deployed functionality, BLE interoperability or completed Backend API. Hardware and external-contract verification remain explicit gates.

## Objective and release stages

Build a public TypeScript/React **Device User Reader** that uses the existing **private Backend**, not a new public Backend. **First independently deployable milestone:** a restricted Reader host, sharing exactly the existing hosted-Backend user population and Backend authority. This milestone precedes full BLE/messaging completion and is not a public beta.

1. **M0 design and contracts:** use this approved UX and brand; public [Reader API contract](READER_API_CONTRACT.md) and [OpenAPI](../contracts/reader-api/v1/openapi.yaml), the compatible private Backend API, the [live observation contract](LIVE_OBSERVATION_API_CONTRACT.md); sanitized fixtures. Do not block shell work on live hardware.
2. **M1 restricted shell:** HTTPS/DNS, separate deployment/rollback, same Backend login/session and capability checks, responsive bottom navigation, MC1-like five-tab Device User navigation, map empty/loading/error and authorized feed integration when available. The existing hosted Backend remains unchanged.
3. **M2 Backend-connected messaging/map:** Chats (Channels inside), authorized messages/contacts/identities, safe send/status and live packet observation map from permitted projection; no BLE required to operate Backend-only.
4. **M3 BLE hardware and adapter:** prove Bluefy on real iPhone/iPad and supported Companion; implement only verified GATT/protocol capabilities, no assumptions of background support.
5. **M4 MVP1 acceptance:** real-device E2E, privacy, duplicates, reconnection, usability, failure paths and release evidence. Public beta/GA remains separately approved.

## GUI inspiration and licensing

Owner-approved: [MeshCore One](https://github.com/Avi0n/MeshCoreOne) replaces the stock MeshCore app as primary visual/interaction reference. Implement original React/TypeScript components with MECON branding under existing Apache-2.0 license; do not copy MC1 GPLv3 application code or protected artwork without explicit licensing review. Approved navigation, milestones, API and privacy are unchanged by this choice. Future native Apple `mecon-app` will fork MC1 for Device Users and integrate MECON Backend online services; Fleet Owner/Admin use cases remain web-only. Native integration is target, not implemented.

## Layout and navigation

**Navigation:** persistent **Chats | Nodes | Map | Tools | Settings** bottom tabs for Device Users on phone/tablet/desktop. MC1-like light mobile UI, conversation list filters for All/Unread/DMs/Channels/Rooms where supported, individual conversation and channel views, node lists/details, map and tool entry points. **There is no Fleet tab on any viewport. Fleet Owner and Instance Admin management GUI is later, web-only work**; do not build Fleet as an MVP1 Device User destination. Responsive desktop/tablet may use split panes but preserve the MC1 information architecture.

M1 shell should expose truthful loading/empty/unavailable states for each tab; MC1 features without verified MECON firmware/Backend support must not be simulated as functional. Messaging, BLE-vs-Backend send, privacy and live observation Map rules below remain authoritative. Map pins are actual authorized observer locations, never inferred transmitters. Nodes show only authorized information; Tools actions require verified capabilities.


## Brand and visual system

Use actual `hoejriis/MeshContinuum/brand/` SVG assets (`lockup-dark.svg`, `lockup-light.svg`, `mark.svg`, `mark-small.svg`), never hand-drawn replacement logos or MeshCore marks. Canonical palette: navy `#0D1736`, violet `#8B7CFF`, turquoise `#25D6C9`, light `#F5F7FB`; dark surfaces `#0A1230`/`#131D45`. Observe contrast and responsive/accessibility rules in [BRAND](https://github.com/hoejriis/MeshContinuum/blob/main/docs/BRAND.md). Illustrative mockups ([visual examples](READER_VISUAL_EXAMPLES.md)) are **not** pixel-perfect requirements or authoritative logos.

## Authentication, API and isolation

- The restricted Reader host is independently hosted and connects by HTTPS to the **existing private Backend**. Existing users only; **no Reader-side user store, signup, role expansion or bypass**. Sessions, logout, revocation and capability resolution come from Backend.
- The private Backend owns the compatible versioned Reader API and secure cross-origin auth ([contract](READER_API_CONTRACT.md)); the public Reader consumes it. Agree safe cookie/domain strategy or equivalent, CORS allowlist, CSRF, SSE authorization, TLS, cache controls, reconnect and logout before real-account integration. Never put secrets, MQTT credentials, private API keys or user content into public source/fixtures.
- Unauthorized/expired sessions fail closed. Server independently enforces every message, device, Fleet and live-feed permission; hiding a tab is not authorization. Admin/Fleet Owner grants never imply permission to decrypt another Device User's private messages.
- Backend-path sends: user chooses authorized **sender identity and destination**; Backend automatically coordinates Companion-first or eligible Repeater Gateway origins. No gateway chooser in Reader. Show truthful logical send and ACK state.
- BLE-path sends: user may explicitly choose local BLE versus Backend path; **never automatically fall back to Backend after an uncertain BLE send**. Track distinct draft, attempt, native packet and observation identities; never silently merge histories or claim unknown equals failure. Direct-message native ACK is not a human read receipt.
- Reader must not persist MeshCore private keys. Device capability comes from verified hello/protocol evidence, not board model assumptions.

## Acceptance criteria

**M1 deploy gate:** DNS/TLS and separate rollback; only existing hosted-Backend users can authenticate; authorized login/logout/session expiry/revocation tested; no cross-user data or unauthorized management access; MC1-like five-tab bottom navigation on phone/tablet/desktop; safe map unavailable state; smoke-tested Backend connectivity; no regression to existing UI/Backend; no production RF action required.

**M2 feature gate:** authorized Chats (including Channels) and observation map use actual API evidence; no invented RF paths; packet feed privacy/source rights respected; no duplicate/ambiguous send; accurate errors and no cross-user history.

**M3 BLE gate:** versioned evidence matrix for real iPhone/iPad Bluefy, firmware/board, BLE permission/PIN, send/receive, reconnect, screen lock/background limits and native outcomes; unsupported behavior clearly labeled, Backend-only remains usable.

**M4 acceptance gate:** E2E signed-in device users and fleet roles; real hardware and stock familiarity review; accessible controls and contrast; sanitized reproducible evidence; privacy and security checks; independent public beta approval.

## Ownership, sources and deferred

Normative sources: this document, the [Reader API contract](READER_API_CONTRACT.md) with [OpenAPI](../contracts/reader-api/v1/openapi.yaml), the [live observation contract](LIVE_OBSERVATION_API_CONTRACT.md), the [acceptance matrix](MVP1_ACCEPTANCE.md) and the [decision register](ARCHITECTURE_DECISIONS.md). Generic authorized RF transmission is a public firmware contract.

Deferred: public Backend replacement, desktop/tablet Admin GUI design, broad offline history, delegated receive identity completion, full BLE/Backend history reconciliation, advanced analytics, and public beta/GA. Do not silently promote deferred work into MVP1.

**Availability as of 2026-11-27:** see the [availability table](MVP1_PLAN.md#restricted-reader-deployment-and-availability); the Reader is deployed to existing users only, and BLE is simulated only.

**Implementation unknowns to resolve in code/contract tests rather than new product decisions:** exact cross-origin session mechanism, deployed DNS/TLS/proxy wiring, API readiness, Bluefy hardware support, feed rights/latency, and map projection details. Record evidence before marking functionality implemented.
