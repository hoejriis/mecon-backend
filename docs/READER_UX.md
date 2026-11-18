# Reader UX — familiar to MeshCore users, distinctly MECON

> **Normative baseline (17 November 2026):** [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md) governs milestone order, navigation, privacy, map, restricted deployment and acceptance. Real hardware and Backend API conformance still require verification.

**Status:** Design specification, not a completed UI.

## Navigation

**Device User web Reader:** follow [MeshCore One](https://github.com/Avi0n/MeshCoreOne) as closely as practicable, using original React/TypeScript components and official MECON branding under Apache-2.0. Persistent bottom navigation on all viewports: **Chats / Nodes / Map / Tools / Settings**. Channels live within Chats, following MC1. Responsive desktop/tablet layouts may use split panes while retaining the five-tab organization. Contacts, Companion selection and account functions follow MC1-familiar workflows. Do not copy GPLv3 application source or protected assets.

**Fleet Owner and Instance Admin:** management interfaces are deferred, separate **web-only** work. No Fleet tab in the Device User app, regardless of role. Backend-enforced capabilities and private-message isolation remain mandatory.

- **Chats:** DMs, channels, unread states, compose/reply, identity and truthful send outcomes.
- **Nodes:** MC1-familiar node/Companion discovery and details, limited by verified capabilities and assigned devices.
- **Map:** authorized live packet observations at known receiving-observer locations only; no invented transmitter locations or RF paths.
- **Tools:** MC1-familiar authorized tools and Companion operations; do not imply unsupported hardware capabilities.
- **Settings:** account, local connection, preferences and supported device settings; preserve Backend authority and key custody.

