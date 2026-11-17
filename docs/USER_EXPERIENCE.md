# Device User — target product experience

**Target UX; only the Bluefy-first Reader GUI is MVP1.**

## Everyday tasks

A Device User opens MECON Reader and immediately recognizes the MeshCore concepts of Chats, Channels, Contacts and Companion. The first experience is a familiar messaging client with original MECON iconography and visual treatment, not a copied MeshCore interface. In Bluefy on iPhone/iPad, the user can connect to an authorized Companion over BLE where hardware/browser support is proven; when signed in, they can also use authorized online Backend history and messaging. Desktop browser is secondary.

- **Chats:** read and send direct messages, switch conversations, see true send/ACK/unknown status; no invented read receipts.
- **Channels:** public and authorized private channels; distinguish channel keys/membership from favourites.
- **Contacts:** adverts and contact information where supported, open conversation and manage authorized contacts.
- **Companion:** assigned devices, active identity, battery, BLE and Backend connection, supported actions and clear reconnect.
- **Settings:** personal preferences, accessibility, session, transport and privacy explanation.

The user sees **messages** to a public channel or one of their authorized identities/private channels, **not raw observations** or a fleet's packet analytics.

## Identity and assignment

Each fleet device is assigned to one user, including possibly its Fleet Owner. A user may have **up to five assigned devices**. One primary Companion can eventually receive for up to four additional identities; delegated receive/decrypt/ACK is **not send-as** and is gated on firmware/Backend support. Switching identities must never grant access to another person's messages.

## Online and offline behavior

BLE and Backend are independent paths; connection to one is not evidence of the other. MVP1 must avoid accidental duplicate sends and make source/outcome explicit. Later target: locally cached app and selected encrypted, authorized history, local unlock where supported, offline authorization lease, explicit confirmation before sending unsent drafts after lease expiry, safe event reconciliation. Platforms without trustworthy local unlock expose only an account-independent public offline shell.

## Acceptance principles

A regular stock MeshCore user can find a channel, send a DM, choose a Companion and understand send status without retraining. Responsive phone/iPad/desktop UX; high contrast and accessible touch targets. Never claim direct BLE works on ordinary iOS Safari; Bluefy requires hardware acceptance.

[Reader interaction detail](READER_UX.md) · [MVP plan](MVP1_PLAN.md)
