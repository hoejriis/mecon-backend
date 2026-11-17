# Roles, capabilities and GUI boundaries

**Full product target; MVP1 implements Device User Reader GUI only.**

Roles are **composable capabilities**, not three separate account types. A Fleet Owner may also be a Device User; an Admin may also own fleets. Screens follow actual permissions, not a single exclusive persona switch.

| Feature | Admin | Fleet Owner | Device User |
|---|---|---|---|
| Accounts, Backend/broker, public sources | Yes | No | No |
| Fleet ownership, device assignment/configuration | Only through separate Fleet Owner grant | Owned fleets | No |
| Raw observation diagnostics | Authorized operational metadata | Owned fleet and reciprocal sources | No |
| Public channel messages | As authorized participant | As authorized participant | Yes, if available |
| Private channel messages | Only with authorized key/membership | Only with authorized key/membership | Only with authorized key/membership |
| Direct private messages | Own assigned identities only | Own assigned identities only | Own assigned identities only |
| BLE Companion messaging | As assigned Device User | As assigned Device User | Assigned device |

## Assignment

One assigned user per device; up to five devices per user. Assignment is not ownership and ownership is not a private-message grant. The primary Companion may later receive for up to four additional identities with explicitly delegated receive/decrypt/ACK only, never unrestricted send-as. On reassignment revoke Backend rights, handle key/delegation lifecycle and explain limitations for offline radios.

## GUI

- **Device User:** Chats, Channels, Contacts, Companion, Settings; sees messages, not observation stream.
- **Fleet Owner:** Fleet overview, Devices, Assignments, Diagnostics/Map, Sharing, Fleet Settings, plus User features only for assigned identities.
- **Admin:** Deployment, Accounts, Infrastructure, Public Sources, Health, Security/Audit, plus other features only when separately authorized.

**Security boundary:** no Fleet Owner/Admin private-message bypass, even when they administer the radio or Backend. See [security](SECURITY_AND_PRIVACY.md) and persona documents.
