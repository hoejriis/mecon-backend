# MECON architecture decision register

**Authority:** accepted product and architecture decisions, as reflected in the linked public specifications and explicitly agreed project discussions. This is durable cross-chat and cross-coder context. **Target**, not a statement that every capability is shipped. For implementation availability see [capabilities](https://github.com/hoejriis/MeshContinuum/blob/main/docs/CAPABILITIES.md).

## How to use this register

1. Read this register before reopening architectural questions. Accepted decisions are defaults unless explicitly superseded by the product owner.
2. Detailed normative specifications and API contracts remain authoritative for field-level behavior; reconcile contradictions rather than silently picking one.
3. When a decision changes, record the old and new decision, rationale and affected specifications; update all affected documents and issues.
4. Do not promote an assistant's proposal to an accepted decision without evidence. Mark uncertain details **Open / verification required**.
5. Public documentation must not expose internal implementation repositories, issue IDs, priorities, private credentials or customer data.

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

- **Fleet co-ownership (supersedes single-owner P3 cardinality):** each fleet must have at least one owner and may have multiple equal co-owners (for example, two parents managing a family fleet). The older single-owner model in [private Backend #658](https://github.com/hoejriis/deimos-mesh/issues/658) must be migrated, not treated as current target. The last owner cannot be removed without a replacement/ownership transfer. Co-ownership alone never grants another user's private-message access.
- **Companion assignment:** Companions are not shared between users. Each is attached to exactly one fleet and at most one active Device User, defaulting to a Fleet Owner. Reassignment requires a fresh MeshCore identity, retirement of the old identity, authorization revocation and cache lifecycle handling per [private Backend #845](https://github.com/hoejriis/deimos-mesh/issues/845).
- **Cross-fleet observation sharing:** opt-in whole-fleet reciprocal sharing, off by default; non-sharing fleets cannot consume other fleets' shared observations, while approved public sources remain accessible. Withdrawal stops future contributions; legitimately shared history follows retention. Observation rights never imply decryption. [Public Backend #15](https://github.com/hoejriis/mecon-backend/issues/15).
- **Public live-feed publication:** owner-approved detailed specification in [private Backend #1795](https://github.com/hoejriis/deimos-mesh/issues/1795) and [website #22](https://github.com/hoejriis/MeshContinuum/issues/22): approved public coordinates only, 15-second live activity effects, 15-minute maximum public catalogue cache, approximately five-minute profile aggregates, 24-hour/seven-day packet counts, no raw packet or observer identity exposure, source-rights and privacy validation before production.
- **Cached Reader, not standalone:** Reader depends on a Backend for sustained operation. A bounded encrypted cache with trusted local unlock and a time-limited offline lease permits cached operation during disconnection; expired lease limits private data to read-only and prevents outbound actions. Reconnect must preserve drafts and avoid ambiguous duplicate sends. [Public Backend #24](https://github.com/hoejriis/mecon-backend/issues/24).

## Primary fleet device profiles — 17 November 2026

These are **nonexclusive fleet-facing profiles**, not new firmware families or substitutes for reported capabilities. Backend connectivity and Backend manageability are distinct.

| Profile | Connectivity | Role and custody | Typical security posture |
|---|---|---|---|
| Personal Companion | BLE/USB by default; optional Wi-Fi/MQTT | Assigned to exactly one fleet and one Device User (default: a fleet owner); canonical primary user identity, potentially up to four delegated receive identities; may hold narrowly scoped Deployment continuity material | Normal |
| Repeater Gateway | Direct Backend transport via Wi-Fi/MQTT or transparent USB Connector | MeshCore repeater plus observation gateway and authorized RF transmit origin for Backend-constructed user messages. Does not need user private keys. Fleet infrastructure rather than personal Companion assignment | Hardened |
| RF-only Repeater | No direct Backend transport; reachable via LoRa through managed infrastructure | MeshCore repeater and fleet infrastructure; remotely manageable over authorized RF operations where firmware capabilities, routing and reachability permit | Hardened |

A stock-firmware Companion can be enrolled by authorized identity/key material with a reduced MECON feature set; managed telemetry/configuration requires demonstrated compatible device capabilities. The firmware supports additional configurations; these profiles are the primary defaults, not exhaustive or hardcoded device classes.

References: [public component responsibilities](COMPONENTS.md), [authorized Repeater-origin transmission](https://github.com/hoejriis/deimos-mesh/issues/1746), [firmware conformance](https://github.com/hoejriis/mecon-firmware/issues/117), [RF repeater management](https://github.com/hoejriis/deimos-mesh/issues/1280).

## Open / verification required

The five topics previously listed here have been reconciled with owner decisions and existing issues; none remains a **fundamental unanswered product-architecture question**. Implementation-specific interfaces, test thresholds, migration and release gates remain tracked in their issues. In particular:
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

When changing an accepted decision, record: ID, previous behavior, new behavior, reason, decision date, migration/compatibility implications, and links to the updated normative docs. Coders should treat discrepancies as a design-blocking question, not infer a new policy from issue title prefixes or legacy notes.
