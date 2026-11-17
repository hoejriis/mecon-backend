# Instance Administrator — target product experience

**Post-MVP target, not an active development programme.**

The administrator operates one MECON Deployment (one trust domain) and its infrastructure, accounts and public observation sources. This is **operational authority, not access to users' private messages or keys**. Admin and Fleet Owner / Device User are independent capabilities and may coexist on an account.

## Deployment workspace

- Dashboard: Backend instances, broker connections, USB Connectors, observation source health, ingest lag, storage, jobs, security alerts and explicit unknown/stale states.
- Users: invitation-only enrollment, passkeys/WebAuthn and email magic links where SMTP is configured, session revocation, role grants and account lifecycle. Sessions default to 30 days subject to revocation.
- Fleets: oversight, lifecycle and ownership transfer without a message-content bypass. Device management only where a separate Fleet Owner authority is granted.
- Public observation sources: administrator adds and manages sources such as MeshAt; their public observations are available independently of reciprocal fleet sharing.
- Infrastructure: brokers, local discovery and trust, Backend Join/continuity, transport credentials, operational audit, backup/recovery and retention.
- Governance: revoke disabled users immediately, retain recoverably for 30 days then delete as specified by policy; devices become unassigned.

## Privacy boundary

Admin APIs may inspect operational metadata and manage accounts/deployments but **cannot retrieve decrypted private messages or private keys belonging to other users**. Backend application-enforced isolation is the product boundary. A hosting operator with control over server/runtime is not cryptographically blind; describe this honestly to hosted users. Public observation feeds never imply private decryption authority.

## Later acceptance

Simple single-site setup and multi-user operations; safe fleet ownership transitions; auditable administration; join/recovery paths; no privileged private-message browsing.
