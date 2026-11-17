# Deployment models and lifecycle — target

**Post-MVP architecture.** MVP1 reuses an existing MECON Backend; these models describe the eventual public application, not a released installer.

## Vocabulary

**Deployment:** one administrator/trust domain with long-lived cryptographic identity, users, fleets and authority. **Backend instance:** one independently authenticated server in that Deployment. **Fleet:** devices owned by one Fleet Owner. **Site:** physical/network location hosting components. **Broker:** MQTT transport, not application storage or authority.

## 1. Single-site self-hosted

One Raspberry Pi or other host runs Backend+served Reader, SQLite, Mosquitto and optional USB Connector. Browser clients connect over HTTPS; direct BLE/USB Companion access depends on platform support. No public cloud is mandatory for local operation. Devices retain independent MeshCore RF operation if MECON is down.

## 2. Distributed or hybrid

Backend+Reader and broker can run on different hosts/sites; a USB Connector may be near a radio. MECON Backend can be reachable over VPN while only an MQTT rendezvous is Internet-facing. Backend attaches to configured local and public brokers; a device chooses one active broker profile, preferring verified LAN when available, then public primary and secondary. Broker credentials and topic ACLs are not application user grants.

## 3. Multiple Backends in one Deployment

Peer Backends reconcile authorized Deployment state via versioned events/snapshots, with direct authenticated HTTPS preferred and MQTT fallback. Instances have their own keys; the Deployment is one trust domain. This is not a feature for merging independently administered Deployments.

## Enrollment and continuity

When an existing trusted Backend survives, a new instance joins through an approved, authenticated continuity flow using protected canonical continuity material from an eligible Normal-posture Companion via USB and an owner-approved peer/admin authorization; a pairing-code fallback exists. If no trusted Backend survives, use **separate cold Recovery**, not ordinary Join. Continuity material restores authority/rendezvous, **not** complete message history or SQLite database. Never publish secrets or private deployment exports.

## Public installation acceptance (later)

Reproducible images, secrets separation, TLS, local CA/mDNS guidance, backup/restore, migrations, independent new-operator setup, health monitoring and no forced fleet migration. All remain target design until evidenced.
