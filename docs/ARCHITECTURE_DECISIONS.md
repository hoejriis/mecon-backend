# MECON architecture decision register

**Authority:** accepted product and architecture decisions of the MECON project, as reflected in the linked public specifications. Decisions describe the **target**, not a statement that every capability is shipped. For implementation availability see [capabilities](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md).

## How to use this register

1. Read this register before reopening architectural questions. Accepted decisions are defaults unless explicitly superseded by the project maintainers.
2. Detailed normative specifications and API contracts remain authoritative for field-level behavior; reconcile contradictions rather than silently picking one.
3. When a decision changes, record the old and new decision, rationale and affected specifications; update all affected documents and issues.
4. Do not record an unverified proposal as an accepted decision. Mark uncertain details **Open / verification required**.
5. Public documentation must not expose internal implementation repositories, issue IDs, priorities, credentials, private keys or customer data.

## Accepted decisions

| ID | Area | Accepted decision | Detailed reference |
|---|---|---|---|
| ADR-001 | Product independence | MECON is an optional, self-hostable/hosted layer over MeshCore. Native radio messaging continues without MECON; the public firmware is independently usable by other managers. | [Product target](https://github.com/hoejriis/MeshContinuum/blob/main/docs/PRODUCT_TARGET.md) |
| ADR-002 | Deployment | A Deployment is a long-lived administrator/trust domain with its own cryptographic authority. It can contain **multiple fleets, users and Backend instances**; a Deployment is **not** synonymous with one fleet. | [Target architecture](TARGET_ARCHITECTURE.md), [Product target](https://github.com/hoejriis/MeshContinuum/blob/main/docs/PRODUCT_TARGET.md) |
| ADR-003 | Roles | Instance Admin, Fleet Owner and Device User are composable capabilities, not mutually exclusive account types. Instance administration does not automatically confer fleet ownership or device-use rights. | [Roles](ROLES_AND_PERMISSIONS.md), [Access](ACCESS_MODEL.md) |
| ADR-004 | Device assignment | A device belongs to exactly one fleet and is assigned to **at most one Device User**; Companions are not concurrently shared. On enrollment, assignment defaults to a Fleet Owner unless explicitly assigned otherwise. A Device User can have **up to five assigned devices**. Fleet ownership, physical management and messaging access are distinct. | [Access](ACCESS_MODEL.md) |
| ADR-005 | Messaging privacy | Admins and Fleet Owners may inspect authorized operational metadata but cannot use those roles to read another Device User's private messages. Users read their own authorized identities, public channels and private channels for which they have membership/keys. Observation alone grants no decryption permission. | [Roles](ROLES_AND_PERMISSIONS.md), [Security](SECURITY_AND_PRIVACY.md) |
| ADR-006 | Key custody | Companion is canonical custodian of its MeshCore private key. An explicitly authorized Backend may hold delegated key material for online messaging. Application APIs enforce role isolation; this is **not** cryptographic protection against the operator of a Backend holding keys. Reader must not persist private keys. | [Target architecture](TARGET_ARCHITECTURE.md), [Trust](https://github.com/hoejriis/MeshContinuum/blob/main/docs/TRUST_AND_PRIVACY.md) |
| ADR-007 | Delegated receiving | A primary Companion may later receive/decrypt/native-ACK for up to four additional delegated identities, **without unrestricted send-as**. Capability is conditional on real hardware and Backend acceptance. | [Access](ACCESS_MODEL.md) |
| ADR-008 | Observation sources | Only an Instance Admin may add global observation sources. Observation/packet metadata can be shared under explicit permissions; private messages remain separately protected. Public live activity is an independently approved, privacy-filtered projection. | [Roles](ROLES_AND_PERMISSIONS.md), [Live API](LIVE_OBSERVATION_API_CONTRACT.md) |
| ADR-009 | Backend architecture | Public Backend target: Python/FastAPI modular monolith, TypeScript/React Reader, SQLite and Mosquitto, with separate transparent USB connector and independently implemented firmware contracts. | [Target architecture](TARGET_ARCHITECTURE.md) |
| ADR-010 | Federation | A Deployment may have multiple peer Backends. Federation synchronizes versioned authoritative application state; brokers are transport infrastructure, not databases or authorization authorities. Devices use prioritized broker connections; Backend instances can attach to multiple brokers. | [Target architecture](TARGET_ARCHITECTURE.md), [Product target](https://github.com/hoejriis/MeshContinuum/blob/main/docs/PRODUCT_TARGET.md) |
| ADR-011 | Reader MVP | Initial public Reader is Device User messaging, Bluefy-first on iPhone/iPad, with direct BLE where verified and a versioned Backend API for authorized online services. Fleet/Admin UI and public Backend replacement are later phases. | [Reader vision](PRODUCT_VISION.md), [Reader API](READER_API_CONTRACT.md) |
| ADR-012 | Send safety | BLE and Backend sends are explicit separate paths; never silently double-send or automatically retry an uncertain attempt. Distinguish queued, duty-held, transmitted, acknowledged, timed-out, failed and unknown using actual evidence. | [Reader API](READER_API_CONTRACT.md) |
| ADR-013 | Backend management | Device-management authority is authenticated independently from MQTT transport and device connectivity. Signed management, identity and capabilities must be validated at the appropriate boundary. | [Product target](https://github.com/hoejriis/MeshContinuum/blob/main/docs/PRODUCT_TARGET.md) |
| ADR-014 | Public live view | Anonymous map and authorized fleet/admin diagnostics are separate projections of normalized reception events. Public output is consent-gated and cannot expose raw packets, private content, private coordinates, observer identities or RF diagnostics. | [Live API](LIVE_OBSERVATION_API_CONTRACT.md) |
| ADR-015 | Availability | Public docs describe the target while availability pages distinguish beta, pre-release and verified features. Hosted mecon.cloud is invitation-only; public Reader/Backend features are not implied shipped. | [Capabilities](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md) |
| ADR-016 | User lifecycle | Disabling a user revokes application access immediately; their private data is recoverably retained for 30 days, then deleted; assigned devices become unassigned. Offline radio revocation is constrained by physical/cryptographic realities. | [Access](ACCESS_MODEL.md), [Security](SECURITY_AND_PRIVACY.md) |
| ADR-017 | Sessions | Email magic-link login establishes a device session targeting 30 days, with immediate revocation on explicit logout or disablement. | [Security](SECURITY_AND_PRIVACY.md) |
| ADR-018 | Backend pairing | One Backend creates a short-lived pairing code, the other redeems it; both retain mutually authenticated instance keys. | [Target architecture](TARGET_ARCHITECTURE.md) |

## Confirmed refinements — 17 November 2026

- **Fleet co-ownership (supersedes single-owner cardinality):** each fleet must have at least one owner and may have multiple equal co-owners (for example, two parents managing a family fleet). Existing single-owner storage must be migrated, not treated as the current target. The last owner cannot be removed without a replacement/ownership transfer. Co-ownership alone never grants another user's private-message access.
- **Companion assignment:** Companions are not shared between users. Each is attached to exactly one fleet and at most one active Device User, defaulting to a Fleet Owner. Reassignment requires a fresh MeshCore identity, retirement of the old identity, authorization revocation and cache lifecycle handling.
- **Cross-fleet observation sharing:** opt-in whole-fleet reciprocal sharing, off by default; non-sharing fleets cannot consume other fleets' shared observations, while approved public sources remain accessible. Withdrawal stops future contributions; legitimately shared history follows retention. Observation rights never imply decryption.
- **Public live-feed publication:** approved detailed specification (published with the MeshContinuum website): approved public coordinates only, 15-second live activity effects, 15-minute maximum public catalogue cache, approximately five-minute profile aggregates, 24-hour/seven-day packet counts, no raw packet or observer identity exposure, source-rights and privacy validation before production.
- **Cached Reader, not standalone:** Reader depends on a Backend for sustained operation. A bounded encrypted cache with trusted local unlock and a time-limited offline lease permits cached operation during disconnection; expired lease limits private data to read-only and prevents outbound actions. Reconnect must preserve drafts and avoid ambiguous duplicate sends.

## Primary fleet device profiles — 17 November 2026

These are **nonexclusive fleet-facing profiles**, not new firmware families or substitutes for reported capabilities. Backend connectivity and Backend manageability are distinct.

| Profile | Connectivity | Role and custody | Typical security posture |
|---|---|---|---|
| Personal Companion | BLE/USB by default; optional Wi-Fi/MQTT | Assigned to exactly one fleet and one Device User (default: a fleet owner); canonical primary user identity, potentially up to four delegated receive identities; may hold narrowly scoped Deployment continuity material | Normal |
| Repeater Gateway | Direct Backend transport via Wi-Fi/MQTT or transparent USB Connector | MeshCore repeater plus observation gateway and authorized RF transmit origin for Backend-constructed user messages. Does not need user private keys. Fleet infrastructure rather than personal Companion assignment | Hardened |
| RF-only Repeater | No direct Backend transport; reachable via LoRa through managed infrastructure | MeshCore repeater and fleet infrastructure; remotely manageable over authorized RF operations where firmware capabilities, routing and reachability permit | Hardened |

A stock-firmware Companion can be enrolled by authorized identity/key material with a reduced MECON feature set; managed telemetry/configuration requires demonstrated compatible device capabilities. The firmware supports additional configurations; these profiles are the primary defaults, not exhaustive or hardcoded device classes.
References: [component responsibilities](COMPONENTS.md), firmware conformance.

## Room Server scope — accepted 17 November 2026

**Decision:** The MeshCore Room Server remains supported for upstream/stock compatibility, but is **not a primary MECON fleet profile or a target for new Room Server-specific development**. The three default profiles remain Personal Companion, Repeater Gateway and RF-only Repeater. Existing generic firmware role support and already implemented operations are retained; do not remove or break stock-compatible behavior. Generic security/conformance work applies where relevant, but must not create a separate MECON Room Server product, special firmware edition, dedicated Reader workflow or Backend feature solely for this role.

**Rationale:** Backend-managed history, identities, delivery and future Backend store-and-forward cover normal MECON needs with a unified Reader experience. A stock Room Server remains useful as an independent RF-only service during total Backend absence, which is deliberately not MECON's primary operating model. Future store-and-forward is a Backend capability, not a Room Server firmware fork. This changes product scope, not a claim that Backend store-and-forward is implemented.

**Affected work:** Backend device inventory, firmware conformance. Earlier Room Server support work remains as implementation history, not a mandate for new product features.

## Automatic observation-driven send origins — accepted 17 November 2026

For Backend-path P2P/DM, public-channel and private-channel messages, the user selects the authorized sender identity and destination, **not the transmitting gateways**. Backend owns eligibility, reachability, origin selection and sequencing. If the user's Companion is connected and able to send, it transmits first; otherwise Backend randomly chooses an eligible connected Repeater Gateway. After **confirmed actual RF transmission**, wait a **10–15-second observation window**; gateways that have positively observed the same native packet are satisfied and must not be instructed to transmit it. Randomly choose one still-unheard eligible gateway as the next origin and repeat, until all eligible gateways have observed or transmitted, or authorization, expiry, duty/airtime or safety bounds end the attempt. Native repeater forwarding is unchanged. One logical message/native packet identity is preserved where routing permits; no gateway holds the user's key. Transmission evidence, observations and ACKs are distinct; lack of observation does not prove absence of transmission.

**Supersedes** the earlier manual multi-origin selection/default no-automatic-follow-up model, specifically for this authorized, bounded, single Backend-path coordinated send. The Reader's BLE-versus-Backend no-silent-double-send boundary remains: this is **not** permission to switch an uncertain BLE attempt to Backend. Pending technical contract details: exact window selection, route/scope packet equivalence, observation latency and race handling. A valid native P2P/DM ACK correlated to the logical message **immediately stops scheduling further gateway origins**, even if some gateways have not heard the original packet; cancel still-pending dispatches where safe, but do not claim to retract already-transmitted or irrevocably queued RF work. Public and private channel messages continue observation-driven propagation because no recipient-wide native ACK exists. Target behavior only, not verified implementation.

## Reader navigation and separate Admin GUI — revised 17 November 2026

**Supersedes the earlier approved three-tab Chats/Channels/Map navigation and capability-gated phone Fleet tab.** The Device User web Reader now follows [MeshCore One](https://github.com/Avi0n/MeshCoreOne) as closely as practicable in layout, navigation and workflows: **persistent Chats / Nodes / Map / Tools / Settings bottom tabs**, with channels accessible within Chats (as in MC1), and conversations, nodes, maps and tools presented in MC1-familiar flows. Use original React/TypeScript components and official MECON branding under Apache-2.0; do not copy MC1 GPLv3 source or protected artwork. Preserve authorized messaging, Backend/Companion transport clarity, live observation Map privacy, device assignment, key custody and offline policy. **Fleet Owner and Instance Admin management GUI is deferred and web-only**; do not add Fleet to Device User tabs or scope management UX into MVP1. Roles remain composable and Backend-enforced. Desktop/tablet web may adapt responsively without abandoning the MC1 interaction model. This is target UX, not implemented/verified.

**Affected:** Reader UX, MVP1 implementation design, vision, plan/architecture, visual examples, and the Reader MVP work. Earlier three-tab and phone Fleet decisions are superseded, not alternatives.

## First public Reader integration deployment — accepted 17 November 2026

The first deployed Reader MVP1 is an **independently deployed public-repository React/TypeScript Reader at `https://reader.mecon.cloud`**, connected through the versioned authorized Reader API to the **existing hosted MECON Backend (`mecon.cloud`)**. This is an **access-restricted integration deployment** for **exactly the existing `mecon.cloud` users**: reuse the existing Backend's identity, session and capability authority, with no independent Reader account database, self-signup, wider invite population or separate privileges. Fleet Owner/Admin management capabilities remain distinct from Device User messaging access. All Reader API and live-update endpoints enforce the same Backend permissions; access to the new hostname must not bypass authentication. Configure secure cross-origin session/CORS/CSRF/WebSocket handling and HTTPS; details of cookie/domain strategy remain an implementation/security contract, not a new identity provider. Existing `mecon.cloud` Reader, Backend, USB and MQTT functions stay in service; this is **not** a public beta, cutover, or public Backend replacement. Deploy incrementally after secure auth/API integration and minimum shell acceptance; BLE and advanced features may follow without delaying the first restricted integration deployment. Production RF writes and general public release still require their own separate approval.

**Supersedes** MVP1-plan language that a deployed Reader necessarily waits until all hardware/privacy final release gates or a separate public beta authorization; those gates still apply to **public beta/GA**, not this restricted integration environment. **Affected:** [MVP1 plan](MVP1_PLAN.md), [MVP1 architecture](MVP1_ARCHITECTURE.md), [Deployments](DEPLOYMENTS.md), the public Reader work. Target decision; no claim that DNS, TLS, SSO/session interoperability or deployment is currently implemented.

## Reader MVP1 implementation design baseline — confirmed 17 November 2026

[MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md) is the consolidated approved specification for MC1-familiar five-tab Chats/Nodes/Map/Tools/Settings navigation, Channels within Chats and deferred web-only Fleet/Admin management, MeshContinuum brand assets, live **observation** Map (not inferred RF routes), same-user restricted Reader deployment, explicit BLE-versus-Backend send path and safe delivery evidence. **First deployable milestone** is the authenticated Reader shell on `reader.mecon.cloud`; BLE hardware conformance and complete messaging are subsequent milestones, not blockers for the shell. Existing `mecon.cloud` services remain operational. Work that depends on hardware, API or integration evidence is gated on that evidence rather than on new UX decisions. This clarifies delivery sequencing, **not** authorization for public beta or any unverified hardware claim.

## Reader MVP2 offline BLE/USB and safe updates — accepted 17 November 2026

**Clarifies the existing cached-Reader decision** rather than superseding Backend authority: after the Reader MVP, the next prepared Reader increment comprises encrypted local cache/lease, safe updates/migration, and **direct laptop browser USB Companion access**. A previously authenticated Device User with trusted local unlock and an **unexpired, Backend-issued, identity/operation-scoped offline lease** may send and receive through a locally attached **BLE or USB Companion even while the Backend is unreachable**. No new identity authority, private key custody in Reader, offline Backend gateway operations, or automatic resend of uncertain attempts. Lease expiry blocks outbound local actions and permits only locally unlocked read-only private cache; unavailable trusted unlock exposes only account-independent shell. Exact lease security parameters and Web Serial/firmware interoperability require contract and hardware verification. Browser USB is **not** the separate headless USB-to-MQTT Connector #21. This programme precedes broad Fleet/Admin GUI design (#17/#18) and does **not** accelerate the public Backend replacement. Target, not implemented/verified.

[Normative MVP2 design](READER_MVP2_DESIGN.md).

## Standalone USB Connector implementation sequencing — confirmed 17 November 2026

The independent **public standalone USB serial-to-MQTT Connector** is the next implementation-ready connectivity slice. This **does not change** the already accepted transparent-transport architecture or move the public Backend rebuild forward. The public Connector owns native serial framing, transparent signed envelopes, MQTT transport, headless Linux/Pi Zero 2 W operation and benchmarks. The existing hosted Backend owns topic/auth mapping, enrollment, arbitration and signed result/job processing. A synthetic versioned USB↔MQTT contract and fake serial/broker harness are the first deliverables; production interoperability requires real hardware/Backend evidence. Browser Web Serial is a separate direct Reader transport. [Implementation design](USB_CONNECTOR_IMPLEMENTATION_DESIGN.md). This is target scope, not verified deployment.

## Dual Reader direction and MC1 GUI reference — accepted 17 November 2026

**Supersedes the earlier tentative native-fork investigation framing; preserves ADR-011.** The React/TypeScript **web Reader remains mandatory** and retains its **Apache-2.0 license**. [MeshCore One](https://github.com/Avi0n/MeshCoreOne) replaces the stock MeshCore app as primary **GUI inspiration**. Implement original React components with MECON branding; do not copy GPLv3 MC1 application source or protected artwork/assets into the web Reader without explicit licensing clearance. Approved navigation, roles, map privacy and API contracts remain settled.

A separate native Apple **mecon-app fork of MC1 is the accepted future direction**, reusing MC1 native features as much as practicable and integrating MECON Backend for authorized online use. MC1 application GPLv3 and Swift MeshCore library MIT licensing, dependency/assets, App Store distribution and upstream maintenance require verification. Native RF operation remains independently possible; MECON Backend permissions, key custody and bounded offline policy apply to MECON online integration. **Fleet Owner and Instance Admin GUI use cases remain web-only for now.** Native integration is not implemented/verified. tracks the design as long-term work.

## Open questions

Implementation-specific interfaces, test thresholds, migration and release gates are tracked in the project's issues. In particular:
- Co-owner invitation/removal/transfer transaction details and migration from single-owner storage require implementation specification.
- Reader offline lease parameters and trusted-unlock availability need implementation and hardware/browser verification; the bounded-cache principle is settled.
- Third-party public-feed redistribution rights and privacy/security validation are **release gates**, not reasons to reopen the approved publication model.
- Detailed cross-fleet authorization tests and integration are implementation work, not a new decision on whether reciprocal sharing is permitted.

## Superseded or rejected interpretations

- **One fleet must have exactly one owner:** superseded by the 17 November 2026 co-ownership decision; a fleet has one or more co-owners.
- **Companions are shared among users:** rejected; only one active user assignment per Companion.
- **Reader works indefinitely without a Backend:** rejected; bounded cached operation only.
- **One Deployment equals one fleet:** not accepted; the documented target explicitly allows multiple fleets per Deployment.
- **Admin/Fleet Owner as a private-message superuser:** rejected.
- **Delegated receive implies send-as:** rejected.
- **MECON or cloud service is necessary for ordinary MeshCore RF:** rejected.
- **An observed packet may automatically be exposed publicly or decrypted:** rejected.
- **BLE and Backend can both transmit the same draft automatically:** rejected.

## Maintaining decisions

When changing an accepted decision, record: ID, previous behavior, new behavior, reason, decision date, migration/compatibility implications, and links to the updated normative docs. Contributors should treat discrepancies as a design-blocking question, not infer a new policy from issue title prefixes or legacy notes.
