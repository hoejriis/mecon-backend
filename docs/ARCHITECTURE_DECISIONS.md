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
| ADR-004 | Device assignment | A device belongs to one fleet and is assigned to **at most one Device User**. A Device User can have **up to five assigned devices**. Fleet ownership, physical management and messaging access are distinct. | [Access](ACCESS_MODEL.md) |
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

## Open / verification required

These are **not** settled merely by discussion or assistant suggestion.

- **Fleet collaboration:** whether multiple Fleet Owners may be delegated partial management rights to one fleet, and the exact invitation/transfer semantics. The existing role model establishes that a Fleet Owner can manage owned fleets, but not a full delegation matrix.
- **Shared Companion use:** one *simultaneous* assigned Device User is settled; whether sequential shift handovers need dedicated UX, key rotation and history clearing is a separate lifecycle design question, not permission for concurrent assignment.
- **Cross-fleet RF and sharing:** physical RF forwarding can occur irrespective of fleet membership; exact reciprocal visibility/management grants and boundaries need verification against fleet-sharing specifications. RF reception must not grant management authority.
- **Public live-feed operational thresholds:** consent/deny-by-default and field exclusions are settled; retention, aggregation, rate limits and anti-tracking thresholds require evidence before publication.
- **Reader direct-device-only mode:** BLE hardware path is planned; use without Backend login and secure offline history require a separate security/UX policy.

## Superseded or rejected interpretations

- **One Deployment equals one fleet:** not accepted; the documented target explicitly allows multiple fleets per Deployment.
- **Admin/Fleet Owner as a private-message superuser:** rejected.
- **Delegated receive implies send-as:** rejected.
- **MECON or cloud service is necessary for ordinary MeshCore RF:** rejected.
- **An observed packet may automatically be exposed publicly or decrypted:** rejected.
- **BLE and Backend can both transmit the same draft automatically:** rejected.

## Maintaining decisions

When changing an accepted decision, record: ID, previous behavior, new behavior, reason, decision date, migration/compatibility implications, and links to the updated normative docs. Coders should treat discrepancies as a design-blocking question, not infer a new policy from issue title prefixes or legacy notes.
