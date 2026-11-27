# Deployment models and lifecycle — target

**Post-MVP architecture.** MVP1 reuses the existing MECON Backend; these models describe the eventual public application, not a released installer. The only current deployment of this repository is the restricted Reader described at the end of this document; there is no public production service. A bounded capture shadow trial is recorded in [migration status](MIGRATION_STATUS.md).

## Vocabulary

**Deployment:** one administrator/trust domain with long-lived cryptographic identity, users, fleets and authority. **Backend instance:** one independently authenticated server in that Deployment. **Fleet:** devices owned by one Fleet Owner. **Site:** physical/network location hosting components. **Broker:** MQTT transport, not application storage or authority.

## 1. Single-site self-hosted

One Raspberry Pi or other host runs Backend+served Reader, SQLite, Mosquitto and optional USB Connector. Browser clients connect over HTTPS; direct BLE/USB Companion access depends on platform support. No public cloud is mandatory for local operation. Devices retain independent MeshCore RF operation if MECON is down.

## 2. Distributed or hybrid

Backend+Reader and broker can run on different hosts/sites; a USB Connector may be near a radio. MECON Backend can be reachable over VPN while only an MQTT rendezvous is Internet-facing. Backend attaches to configured local and public brokers; a device chooses one active broker profile, preferring verified LAN when available, then public primary and secondary. Broker credentials and topic ACLs are not application user grants.

## 3. Multiple Backends in one Deployment

Peer Backends reconcile authorized Deployment state via versioned events/snapshots, with direct authenticated HTTPS preferred and MQTT fallback. Instances have their own keys; the Deployment is one trust domain. This is not a feature for merging independently administered Deployments.

## Enrollment and continuity

When an existing trusted Backend survives, a new instance joins through an approved, authenticated continuity flow using protected canonical continuity material from an eligible Normal-posture Companion via USB and an approved peer/admin authorization; a pairing-code fallback exists. If no trusted Backend survives, use **separate cold Recovery**, not ordinary Join. Continuity material restores authority/rendezvous, **not** complete message history or SQLite database. Never publish secrets or private deployment exports.

## Public installation acceptance (later)

Reproducible images, secrets separation, TLS, local CA/mDNS guidance, backup/restore, migrations, independent new-operator setup, health monitoring and no forced fleet migration. All remain target design until evidenced.

## Restricted Reader deployment and availability

**Approved 17 November 2026; availability as of 27 November 2026 (previous statement: 25 November 2026).** The first Reader deployment is an access-restricted integration environment on its own origin, independently deployed from the public Reader code and connected to the existing hosted Backend. It is **not** a public beta, a cutover or a public Backend replacement.

- **Access:** exactly the existing hosted-Backend users, through the Backend's own login, session and per-user capability checks. No independent user store, self-signup, extra grants or bypass through the API or live updates. Administrators and Fleet Owners do not gain other users' private messages.
- **Integration:** the versioned Reader API ([contract](READER_API_CONTRACT.md), [OpenAPI](../contracts/reader-api/v1/openapi.yaml)), HTTPS, a secure cross-origin session/CSRF/live-update arrangement, sanitized fixtures and auditable configuration. No private credentials in public client code.
- **Coexistence:** the existing hosted UI, Backend, MQTT and USB agent stay in service.
- **Separate gates:** public beta/GA and production RF writes each need their own acceptance and approval. Nothing in the restricted deployment waits for, or is blocked by, those gates or by real-hardware Bluefy results.

| Status | What |
|---|---|
| **Deployed (restricted, existing hosted-Backend users only)** | Reader release v0.9.2: the five-tab shell (Chats / Nodes / Map / Tools / Settings), the login client, the design system and a read-only Bluetooth diagnostics page. The Reader API is routed to the existing Backend. Later tags exist (v0.9.3 was build-only; v0.9.4 to v0.9.6 are released) but this table does not record them as deployed. Live signed-in acceptance with test users passed (33 passed, 1 manual row skipped), as the [acceptance evidence](MVP1_ACCEPTANCE.md) records. |
| **Implemented and deployed in the restricted Reader, awaiting acceptance** | Offline cache and leases (checked with a virtual authenticator; a real passkey on a phone is not yet verified); safe updates (checked live across five updates, v0.5.0 to v0.9.1; the case of an update banner with an unsent draft is not yet verified); USB access (the hardware acceptance session is still open). None is described as available. |
| **Implemented, not verified live** | The Backend-path messaging client, written against a draft contract. |
| **Simulated only** | The BLE Companion adapter, exercised through an Android Chrome profile simulation; not verified on hardware. Bluefy on iPhone/iPad still awaits real-hardware testing. |
| **Merged, not deployed** | The public Reader facade (`reader-backend/`), which serves REST and SSE and reaches a core through the session-lookup and reader-core contracts (`HttpSessionLookup` and `HttpReaderCore`), run only against fakes and a stub. No public core implementation exists, and an interop run against the reference Backend's reader-core is pending. Also observation processing. |
| **Test bench only** | The USB Connector: an older build runs as a service on a test bench against the hosted Backend. The releases since (the enrolment-gate probe classification in v0.9.5, the clean serial DFU stop in v0.9.6) are not claimed to run anywhere. No user deployment. |
| **Shadow trial (bounded)** | The public capture service, release v0.9.2, since 2026-11-25 for 7 days, subscribe-only beside the hosted Backend. As last recorded: connected and subscribed, no observation traffic received, so no parity evidence. Not a cutover. |
| **Planned** | Live observation Map (its anonymous feed is specified by `contracts/public-map/v1`; no public implementation serves it), contacts and the staged public Backend. It does not replace the hosted Backend. |

Evidence is recorded in the [acceptance matrix](MVP1_ACCEPTANCE.md); the normative design is [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md). Nothing here implies public availability or verified full messaging.

## Reverse proxy and internal routes

When a Reader facade and a core run as separate services, the calls between them (the session-lookup and reader-core contracts) are internal routes: plain HTTP on the deployment's private network, gated by a per-deployment service token. A public reverse proxy must route only the Reader API and the observation paths to the facade, and must never route the internal routes: they are never reachable from a browser. The deployer chooses the internal base path, so configure the proxy by an explicit allow-list of public paths, not by excluding a prefix.

## Known limitation: interrupted serial DFU needs UF2 recovery

A serial DFU of an nRF52 device that is interrupted after data writing has begun (past the erase) can only be recovered by a UF2 copy. This holds whatever the host and however cleanly the transfer stops. A later serial DFU may report success while the application never starts. UF2 is the accepted field recovery, and firmware releases from v0.3.22 (a pre-release at the time of writing) carry a `recovery_uf2` asset for each nRF52 variant. The Connector detecting and reporting that a device needs UF2 recovery is planned, not shipped. See [migration status](MIGRATION_STATUS.md#known-limitation-serial-dfu-recovery).
