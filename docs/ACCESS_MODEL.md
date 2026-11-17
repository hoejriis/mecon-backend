# Reader access and identity model

**Status:**  product contract. Normative ownership basis: [public roles and permissions](ROLES_AND_PERMISSIONS.md), [target architecture](TARGET_ARCHITECTURE.md).

## Separate three concerns

**Administration** is authority to operate an instance; **fleet ownership** is authority to manage devices; **device use** is authority to communicate using an assigned Companion/identity. These do not imply each other. An Admin or Fleet Owner may additionally be a Device User through their own assignment.

| Action | Instance Admin | Fleet Owner | Device User |
|---|---|---|---|
| Infrastructure/accounts/public observation sources | Yes | No | No |
| Owned fleet device configuration/assignment | Only if separately authorized as Fleet Owner | Yes | No |
| Raw fleet observations | Authorized operational scope | Own and reciprocal authorized fleet scope | No observation browser |
| Public channel messages | As authorized channel participant | As authorized channel participant | As authorized channel participant |
| Private messages | Own authorized identities only | Own authorized identities only | Assigned identities only |

Device Users receive **messages**, not raw observations: messages to public channels or to their authorized identities, plus authorized private-key channels. Backend access checks must enforce this even if a UI pane is hidden.

## Assignment

- Each device belongs to one fleet and may be assigned to **one Device User**, including its Fleet Owner.
- Each Device User may be assigned **up to five devices**.
- A user's primary Companion may receive for **up to four additional delegated identities**, when supported. Delegation is receive/decrypt/native-ACK only, **not send-as**. Do not promise this until compatible firmware and the planned Backend delegated-receive integration have real-hardware acceptance.
- Device assignment, ownership transfer and delegated-key provisioning are different audited operations.
- Reassignment revokes the former user's Backend authorization and requires safe key/delegation lifecycle handling. Offline device revocation has physical/cryptographic limitations.

## BLE security boundary

A direct BLE pairing is **not** proof of Backend account authorization or ownership. The Reader must not merge another person's device-local messages into the signed-in user's Backend account. Backend remains authoritative for online user/assignment access. Direct local Companion use is gated by supported firmware and explicit pairing/identity authority; device-only use without Backend authentication requires a separately defined security/UX policy before implementation.

Never expose private keys to the Reader application merely to implement delegated receive identities. The Companion remains canonical custodian; delegated Backend key custody is governed by the target security architecture, not a UI shortcut.
