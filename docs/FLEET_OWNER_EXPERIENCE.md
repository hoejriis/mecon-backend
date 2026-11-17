# Fleet Owner — target product experience

**Post-MVP target, not an active development programme.**

A Fleet Owner operates one or more fleets, assigns Companions to people and maintains devices without automatically gaining access to anyone's private conversations. The same account may also be a Device User.

## Fleet workspace

- Fleet overview: devices, roles, availability, firmware, battery, last-heard and honest telemetry freshness.
- Device inventory, enrollment and assignment: one assigned user per device, including owner; maximum five assigned devices per user. Assignment, enrollment and management authority are distinct operations.
- Configuration, diagnostics, supported updates and managed actions through the firmware's capability-advertised interfaces, with signed authorization, audit and safe failure handling.
- Fleet map and observation analytics for the fleet's authorized operational data; distinguish an observer's location from a transmitter's location and do not invent RF coverage.
- Fleet settings: reciprocal observation sharing, anonymity and access management.

## Reciprocal observation sharing

The **fleet owner** controls one setting for the **whole fleet**, not per device or group. New fleets start **not sharing**. An owner may explicitly opt into sharing with other participating fleets, optionally anonymously. An owner who does **not** share cannot consume other owners' shared fleet observations, but can still consume administrator-added public observation sources. Withdrawal stops **new** contributions; previously shared historical observations remain available to currently participating fleets subject to retention. Anonymous sharing conceals owner attribution in ordinary views but retains protected provenance for dedup/abuse controls.

This sharing is about raw reception evidence and operational metadata; it **never grants decrypted private messages or private keys**.

## Security and user experience

Fleet ownership is not message-read authority. The owner may read messages for identities assigned **to themselves**, never another user's private messages. Device reassignment must revoke Backend authorization, handle delegated-key lifecycle and explain physical/offline limitations. Clear separation between Fleet and Messages navigation; no silent operator override.

## Later acceptance

Multi-fleet administration without enterprise complexity; role-safe device assignment and transfer; clear audit, telemetry provenance, privacy and consent; hardware-verified management on supported roles.
