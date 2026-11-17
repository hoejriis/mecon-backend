# Reader UX — familiar to MeshCore users, distinctly MECON

**Status:** Design specification, not a completed UI.

## Navigation

On phone: primary destinations **Chats**, **Channels**, **Contacts**, **Companion**, **Settings**. Keep core tasks reachable with minimal navigation. On tablet/desktop: a list/detail split view for chats and channels; selected conversation stays visible. Use simple, consistent iconography and conventional message bubbles/timestamps. Avoid complex operator dashboards in the Device User experience.

- **Chats:** most recent conversations, unread markers, selected identity where relevant, compose/reply, send state and clear failure recovery.
- **Channels:** public channel and channels the user is authorized to read; channel membership/keys are distinct from a favourite. Channel sends do not acquire fabricated recipient ACKs.
- **Contacts:** identity, advert-derived information when available, add/inspect contact where authorized, open conversation.
- **Companion:** paired/assigned devices, active device, BLE connection, battery, identity, transport availability, supported device actions. Distinguish device connection from RF delivery.
- **Settings:** theme, notification preferences when available, account and security, app/about, privacy and capability explanations.

## Bluefy-first connection journey

1. Show a **Connect Companion** action in Bluefy; use an explicit user gesture for Web Bluetooth.
2. Discover and select supported Companion, pair if required, show permission and PIN instructions only as needed.
3. Read identity and capability evidence from the device. A connected device is not automatically authorized for Backend-account data or management.
4. Show **Connected via Bluetooth** separately from **Backend connected** and **Mesh reachability unknown/known**.
5. On disconnect, preserve the visible context; disable unsupported actions, give a meaningful reconnect action, and avoid invented delivery outcomes.
6. Outside Bluefy, display truthful browser compatibility guidance and allow Backend-only messaging when authorized. Do not promise iOS Safari Web Bluetooth.

Bluefy Web Bluetooth support and firmware-specific GATT behavior require real-device verification before claiming compatibility. Pairing, reconnect, permissions, foreground/background behavior, screen lock and BLE event delivery must be tested on iPhone and iPad.

## Visual identity

Use the existing MeshContinuum [brand reference](https://github.com/hoejriis/MeshContinuum/blob/main/docs/BRAND.md) and original assets from its `brand/` folder:
- Navy `#0D1736` for primary identity and high-contrast text.
- Violet `#8B7CFF` and turquoise `#25D6C9` as accents, respecting contrast.
- Light surface `#F5F7FB`; dark backgrounds `#0A1230` and `#131D45`.
- Original MECON mark/lockup; do not recolor, distort or substitute stock MeshCore brand assets.

Preserve familiarity in **information architecture and task sequence**, not proprietary illustrations or exact layouts. Prefer readable native system typography, accessible targets, keyboard navigation, screen-reader labels, dark/light support and restrained animation.

## Message and status language

Use normalized Backend/firmware evidence; never infer success from a button tap. Separate local draft, queued, handed to transport, RF transmitted, native ACK where applicable, failed, and unknown. Unknown is not failed. A channel post has no individual recipient read receipt. Explain next actions and prevent accidental duplicate sends.

## User-journey acceptance

- First launch, Bluetooth connection, open public channel, read an authorized DM, send a DM, inspect send outcome.
- Switch active Companion without changing ownership or leaking another user's messages.
- Resume after BLE disconnect and Backend disconnect, with clear capability degradation.
- Test on iPhone Bluefy and iPad Bluefy; desktop supported browser as secondary. Check small-screen, landscape, accessibility and empty/error states.
