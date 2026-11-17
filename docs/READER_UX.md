# Reader UX — familiar to MeshCore users, distinctly MECON

**Status:** Design specification, not a completed UI.

## Navigation — owner-approved 17 November 2026

**Device User GUI:** use the stock MeshCore application's primary organization: a **persistent bottom navigation bar with Chats, Channels and Map on every viewport**, including phone, tablet and desktop web. Responsive layouts may use split panes, but must not replace the bottom navigation with a desktop sidebar. Contacts, Companion connection/selection, account and Settings are secondary actions reachable from their relevant views or a header/menu, not extra bottom tabs. Preserve recognizable MeshCore task organization without copying stock app art or proprietary layouts.

**Fleet Owner / Instance Admin:** when using the phone-oriented GUI, expose a fourth bottom destination **Fleet**, capability-gated to Fleet Owners/Admins and functionally corresponding to today's **Devices** entry. This is an entry to authorized fleet/device management, not permission to view Device Users' private messages. A user without the relevant capability sees only Chats, Channels and Map. Roles are composable; Fleet tab visibility must use actual granted capabilities, not an account-type guess.

**Future Admin GUI:** a separate, more desktop-oriented management experience for Fleet Owners and Instance Admins on web/tablet; its information architecture and detailed UX are **deferred for later design**. Do not invent a complete Admin GUI as part of Reader MVP1. The phone Fleet entry may initially link to existing authorized management functionality, subject to explicit scope and tests.

- **Chats:** direct-message conversations, unread markers, identity, compose/reply and honest send state.
- **Channels:** public and authorized private channels, membership and messages; no fabricated recipient-wide ACK.
- **Map:** stock-familiar map destination; data, privacy and source rights follow approved observation/map contracts. Do not infer that all observed packets/locations are public. The MVP1 Map implementation depth remains to be scoped against existing Backend functionality.
- **Secondary Contacts, Companion and Settings:** accessible without adding bottom tabs; maintain identity/device selection, Bluetooth/Backend state and account controls.

