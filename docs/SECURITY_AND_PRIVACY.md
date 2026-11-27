# Security, privacy and authorization — target

**Public product contract.** No implementation or audit is claimed by this document.

## Three independent authorities

1. **Deployment Admin** manages accounts, brokers, sources, infrastructure and operational metadata.
2. **Fleet Owner** manages owned devices and their assignment/configuration/telemetry/sharing.
3. **Device User** may read and send messages for assigned identities and authorized channels.

They are composable, not mutually exclusive. Neither Admin nor Fleet Owner inherits private message access to identities assigned to other users. Backend authorization is enforced server-side. A user can have at most five assigned devices; each device has at most one assigned user.

## Key and message custody

Companion is canonical holder of MeshCore identity keys. A Backend may hold an explicitly delegated copy for authorized online messaging. Reader never stores private keys. Delegated receive identities are receive/decrypt/ACK, not send-as. Device management authority, MQTT transport credentials and message decryption permissions remain separate.

**Hosting limitation:** application isolation prevents administrator **APIs** from reading private user content, but an operator controlling the running Backend and storage is not cryptographically blind. Do not claim end-to-end operator-proof secrecy for hosted Backend decryption.

## Observations

Raw packets and public metadata may be exposed only by source/owner policy; decryption requires separate authorization. Administrator-managed public sources are available to deployment members. Reciprocal fleet sharing is whole-fleet, off by default, optional anonymous, with non-sharing owners unable to consume other fleets' contributions. Withdrawal stops new sharing; historical legitimate contributions persist under retention.

## Sessions, revocation and offline

Invitation-only multi-user service; passkeys and magic links (when email configured), 30-day device sessions with immediate revocation. Disabled users lose access immediately; recoverable data retention 30 days before deletion, devices unassigned. Offline Reader later requires trustworthy local unlock and encrypted cache; otherwise account-independent public shell only. Offline authorization leases expire into read-only private cache; queued drafts require explicit confirmation after reauthentication. Browser storage eviction cannot be guaranteed; never silently delete unique drafts.

## Transport and recovery

HTTPS for Reader APIs (REST, with server-sent events for updates), signed device authority separate from broker auth, mutual authenticated Backend federation, protected continuity packages and separately controlled cold Recovery. The internal contract routes between a Reader facade and a core (session lookup and reader-core, gated by a per-deployment service token) belong on a private network only and must never be reachable through a public reverse proxy; the facade reads that token from a mode-600 file. No public secrets, private instance addresses, production messages or credentials in public docs/issues.

## Reader MVP2 offline continuity and desktop USB (approved target)

After the P3 Reader MVP, the Reader supports encrypted bounded offline cache, trusted local unlock, Backend-issued scoped offline leases, and **direct desktop Chromium Web Serial** to a Companion. With a valid lease, an authenticated and locally unlocked user may send/receive through authorized **BLE or USB** while the Backend is unreachable. Lease expiry blocks outbound local actions; locally unlocked private cache becomes read-only. Browser USB is separate from the headless USB-to-MQTT Connector. Updates require user-confirmed activation and safe draft/attempt-preserving migration. The private Backend remains online authority; no functionality or hardware support is claimed verified. See [Reader MVP2 design](READER_MVP2_DESIGN.md) and [ADR](ARCHITECTURE_DECISIONS.md).
