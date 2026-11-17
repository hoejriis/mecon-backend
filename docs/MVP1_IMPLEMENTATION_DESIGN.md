# Reader MVP1 — approved implementation design and delivery gates

**Status:** owner-approved target UX, architecture and restricted F2 deployment (17 November 2026). This document is implementation-ready for the Reader shell and design system. It is **not** evidence of deployed functionality, BLE interoperability or completed Backend API. Hardware and external-contract verification remain explicit gates.

## Objective and release stages

Build a public TypeScript/React **Device User Reader** that uses the existing **private F2 Backend**, not a new public Backend. **First independently deployable milestone:** restricted `https://reader.mecon.cloud` on F2, sharing exactly the existing `mecon.cloud` user population and Backend authority. This milestone precedes full BLE/messaging completion and is not a public beta.

1. **M0 design and contracts:** use this approved UX and brand; public Reader API contract, private Backend #1836, live observation contract/private #1838; sanitized fixtures. Do not block shell work on live hardware.
2. **M1 restricted F2 shell:** HTTPS/DNS, separate deployment/rollback, same Backend login/session and capability checks, responsive bottom navigation, role-gated phone Fleet, map empty/loading/error and authorized feed integration when available. Existing `mecon.cloud` remains unchanged.
3. **M2 Backend-connected messaging/map:** Chats/Channels, authorized messages/contacts/identities, safe send/status and live packet observation map from permitted projection; no BLE required to operate Backend-only.
4. **M3 BLE hardware and adapter:** prove Bluefy on real iPhone/iPad and supported Companion; implement only verified GATT/protocol capabilities, no assumptions of background support.
5. **M4 MVP1 acceptance:** real-device E2E, privacy, duplicates, reconnection, usability, failure paths and release evidence. Public beta/GA remains separately approved.

## GUI inspiration and licensing

Owner-approved: [MeshCore One](https://github.com/Avi0n/MeshCoreOne) replaces the stock MeshCore app as primary visual/interaction reference. Implement original React/TypeScript components with MECON branding under existing Apache-2.0 license; do not copy MC1 GPLv3 application code or protected artwork without explicit licensing review. Approved navigation, Fleet role gating, milestones, API and privacy remain unchanged. Future native Apple `mecon-app` will fork MC1 for Device Users and integrate MECON Backend online services; Fleet Owner/Admin use cases remain web-only. Native integration is target, not implemented.

## Layout and navigation

- **Phone, tablet and desktop web:** persistent **bottom** tabs in order **Chats | Channels | Map**; selected tab and keyboard/screen-reader semantics are clear. Tablet/desktop may show master/detail columns above bottom bar. Do not substitute a sidebar for bottom tabs.
- **Phone only, with Backend-granted Fleet Owner or Instance Admin management capability:** fourth **Fleet** tab (existing Devices functionality). No Fleet tab for users lacking grants. Do not infer management rights from a user label; use capabilities. The separate desktop/tablet management/Admin GUI is a **future** project, not MVP1.
- **Secondary:** Contacts (reachable from Chats/search/new conversation), Companion selection/connection (header/status or relevant context), Settings/account/logout (header/menu). These are routes or panels, not additional bottom tabs.
- **Chats:** recent authorized DMs, unread and send state, conversation detail, composer, explicit sender identity and transport path.
- **Channels:** public and authorized private channels, membership/key rules, conversation view; no recipient-wide ACK.
- **Map:** **live packet observation map first**, not an inferred topology map. Mark actual receiving observer locations when authorized and location known, show timestamps, RF evidence and observation freshness. Do **not** infer transmitter locations, radio links or RF paths. Missing location produces an observation list without invented pins. Separate public-safe and authenticated role-scoped projections, respecting source consent/rights. Provide paused/disconnected/empty/no-permission states. Never display another user's private plaintext.
- **Fleet phone:** authorized inventory/device status/actions equivalent to existing Devices, using private Backend permission checks; no cross-user private message access. No new management API implied.

## Brand and visual system

Use actual `hoejriis/MeshContinuum/brand/` SVG assets (`lockup-dark.svg`, `lockup-light.svg`, `mark.svg`, `mark-small.svg`), never hand-drawn replacement logos or MeshCore marks. Canonical palette: navy `#0D1736`, violet `#8B7CFF`, turquoise `#25D6C9`, light `#F5F7FB`; dark surfaces `#0A1230`/`#131D45`. Observe contrast and responsive/accessibility rules in [BRAND](https://github.com/hoejriis/MeshContinuum/blob/main/docs/BRAND.md). Illustrative [SVG mockups](../design/reader-mvp1-map-fleet-concepts.svg) are **not** pixel-perfect requirements or authoritative logos.

## Authentication, API and isolation

- `reader.mecon.cloud` is independently hosted on F2 and connects by HTTPS to the **existing private Backend** on F2. Existing users only; **no Reader-side user store, signup, role expansion or bypass**. Sessions, logout, revocation and capability resolution come from Backend.
- Private Backend #1836 owns compatible versioned Reader API and secure cross-origin auth; public Reader consumes it. Agree safe cookie/domain strategy or equivalent, CORS allowlist, CSRF, SSE authorization, TLS, cache controls, reconnect and logout before real-account integration. Never put secrets, MQTT credentials, private API keys or user content into public source/fixtures.
- Unauthorized/expired sessions fail closed. Server independently enforces every message, device, Fleet and live-feed permission; hiding a tab is not authorization. Admin/Fleet Owner grants never imply permission to decrypt another Device User's private messages.
- Backend-path sends: user chooses authorized **sender identity and destination**; Backend automatically coordinates Companion-first or eligible Repeater Gateway origins. No gateway chooser in Reader. Show truthful logical send and ACK state.
- BLE-path sends: user may explicitly choose local BLE versus Backend path; **never automatically fall back to Backend after an uncertain BLE send**. Track distinct draft, attempt, native packet and observation identities; never silently merge histories or claim unknown equals failure. Direct-message native ACK is not a human read receipt.
- Reader must not persist MeshCore private keys. Device capability comes from verified hello/protocol evidence, not board model assumptions.

## Acceptance criteria

**M1 deploy gate:** DNS/TLS and separate rollback; only existing mecon.cloud users can authenticate; authorized login/logout/session expiry/revocation tested; no cross-user data or unauthorized Fleet access; bottom tabs on phone/tablet/desktop; safe map unavailable state; smoke-tested Backend connectivity; no regression to existing UI/Backend; no production RF action required.

**M2 feature gate:** authorized Chats/Channels and observation map use actual API evidence; no invented RF paths; packet feed privacy/source rights respected; no duplicate/ambiguous send; accurate errors and no cross-user history.

**M3 BLE gate:** versioned evidence matrix for real iPhone/iPad Bluefy, firmware/board, BLE permission/PIN, send/receive, reconnect, screen lock/background limits and native outcomes; unsupported behavior clearly labeled, Backend-only remains usable.

**M4 acceptance gate:** E2E signed-in device users and fleet roles; real hardware and stock familiarity review; accessible controls and contrast; sanitized reproducible evidence; privacy and security checks; independent public beta approval.

## Ownership, tracking and deferred

Public Reader issues [#1](../issues/1), [#2](../issues/2), [#3](../issues/3), [#4](../issues/4), [#5](../issues/5), [#6](../issues/6), [#7](../issues/7). Private Backend [#1836](https://github.com/hoejriis/deimos-mesh/issues/1836) for API/auth and [#1838](https://github.com/hoejriis/deimos-mesh/issues/1838) for normalized live observation contract; public firmware [#537](https://github.com/hoejriis/mecon-firmware/issues/537) for generic authorized RF TX.

Deferred: public Backend replacement, desktop/tablet Admin GUI design, broad offline history, delegated receive identity completion, full BLE/Backend history reconciliation, advanced analytics, and public beta/GA. Do not silently promote deferred work into MVP1.

**Implementation unknowns to resolve in code/contract tests rather than new product decisions:** exact cross-origin session mechanism, deployed DNS/TLS/proxy wiring, API readiness, Bluefy hardware support, feed rights/latency, and map projection details. Record evidence before marking functionality implemented.
