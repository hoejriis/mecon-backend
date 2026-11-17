# Reader-first MVP1 — delivery plan and acceptance

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

**Design/feasibility** → **working local prototype** → **private-Backend staging integration** → **hardware and privacy acceptance** → **separate owner approval for public beta/deployment**.

Delegated receive identities (up to four extra), offline secure cache and fully standalone Reader are later increments, not MVP1 blockers.

## Tracking

- [Application roadmap](ROADMAP.md)
