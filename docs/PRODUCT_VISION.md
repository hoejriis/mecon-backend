# MECON Reader — product vision

This document describes the intended Reader experience. See [availability](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md) for current implementation and hardware support.

## The proposition

MECON Reader is a familiar, communication-first MeshCore client with MECON's visual identity. A person comfortable in the stock MeshCore app should immediately recognize contacts, channels, conversations, Companion selection, composing and send status. It is **inspired by the stock app's interaction model, not a pixel-for-pixel reproduction**. Do not copy stock app artwork, source, icons, layouts or distinctive presentation.

The first deliverable is a **BLE-enabled web Reader for iPhone/iPad using Bluefy**, initially for **Device Users**, with an authorized MECON Backend supplying online history, account/authorization and gateway services. The Reader uses a versioned Backend interface and can evolve independently of the Backend implementation.

## Core experience

1. Open the Reader in Bluefy on an iPhone/iPad; see clear support and connection state.
2. Sign in to a MECON account for Backend features; use the assigned Companion over BLE where device/browser capabilities permit.
3. Pair/connect an authorized MeshCore Companion; show its identity, battery and reachability. Never confuse BLE connected with RF reachable or Backend online.
4. Browse conversations, channels and contacts in familiar patterns. Direct messages belong to the user's assigned identities; channel content requires appropriate channel access. **Device Users do not browse raw observation feeds.**
5. Send a direct or channel message via an available authorized path; distinguish pending, handed to device, transmitted, acknowledged (when supported), failed and unknown. Do not imply recipient read receipts.
6. Reconnect after BLE or network interruption without silently duplicating sends. Explain when an action needs BLE, Backend or both.
7. Switch among up to five assigned Companions/identities. Delegated receive identities (primary + up to four) are **future conditional support**, subject to compatible firmware and Backend support; they are not an MVP launch requirement.

## Personas and security

- **Device User (MVP1):** messages, channels, contacts, assigned Companion, basic status and personal settings.
- **Fleet Owner (later):** fleet/device inventory, assignment, configuration, OTA, diagnostics and fleet observation sharing; can also act as Device User when assigned devices.
- **Instance Admin (later):** deployment, brokers, public sources, accounts and operational metadata. No private-content override.

A Fleet Owner assigns each device to at most one Device User, including themselves. A Device User may have up to five assigned devices. **Fleet Owner/Admin cannot read private messages addressed to another assigned user.** A device's ownership is not a message-read grant. See [access model](ACCESS_MODEL.md).

## What MVP1 is not

Not a new firmware protocol, standalone fully offline Reader, Fleet Owner/Admin GUI, observation explorer, OTA manager, public Backend rewrite, or replacement for the stock MeshCore app. Direct BLE in Bluefy may work while Backend is unavailable, but **offline authorization, secure local private-history storage and Backend reconciliation are later product work**. Do not market this MVP as full offline operation.

## Outcome

A user can go from stock MeshCore to MECON Reader and perform the same everyday messaging tasks without relearning the concepts, with MECON's own branding and clear optional Backend advantages.

[Interaction specification](READER_UX.md) · [Bluefy and Backend architecture](MVP1_ARCHITECTURE.md) · [delivery plan](MVP1_PLAN.md)
