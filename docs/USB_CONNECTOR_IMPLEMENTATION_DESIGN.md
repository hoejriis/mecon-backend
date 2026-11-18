# Standalone USB Connector — implementation design

**Approved architecture, implementation design for the public USB Connector.** This is an independent headless bridge, **not** Reader browser Web Serial, and **not** the private legacy Pi agent. Existing private Backend stays in service. Hardware, broker interoperability and protocol fixtures are verification gates, not claims of completion.

## Topology and ownership

```
Public-firmware USB Companion/Repeater
   ↕ native serial framing / signed device envelopes
Standalone public USB Connector (Pi Zero 2 W or generic Linux)
   ↕ authenticated device-scoped MQTT / TLS
Broker (Mosquitto, independently operated)
   ↕ private Backend MQTT integration
Existing private Backend (enrollment, auth, jobs, result validation)
```

**Public Connector:** USB enumeration/port selection, serial framing and bounded buffering, transparent envelope forwarding, MQTT client/TLS, reconnect/backoff, health/logging, local service/container packaging, synthetic tests and Pi Zero 2 W benchmarks. **Private Backend:** topic mapping/ACL provisioning, enrollment, device-control-link arbitration, signature/authority checks, management job correlation, E2E acceptance. **Firmware:** canonical native serial framing and signed public-firmware v1 envelope behavior. **Broker:** transport and ACL only, no decryption or business logic.

## Contract-first first deliverable

Publish a versioned **USB↔MQTT interoperability contract** and synthetic serial-device + fake-broker harness before connecting production devices. Contract must specify from verified firmware/Backend references:
- Serial device discovery, framing, message size, device capabilities and handshake, frame classification, malformed frame behavior.
- Exactly which native signed envelopes are forwarded byte-for-byte; correlation and transport metadata separately and without inventing device identity or ACKs.
- Topic direction/namespaces, device-scoped broker credentials/ACL, QoS/retained/expiry and reconnect semantics, envelope encoding and ordering constraints.
- Single device-control-link ownership when Wi-Fi and USB are both possible, and how Backend decides active transport. Connector must never make its own management authority decisions.
- Loss, overflow, duplicate, disconnect, reconnect and ambiguous-delivery handling. MQTT acknowledgement is **not** RF acknowledgement; no implicit replay of RF commands.

**Do not invent** field names, MQTT topic strings, cryptographic signatures or firmware capabilities. Freeze them against public firmware and private Backend contract owners, then publish sanitized fixtures.

## Runtime and security

- One USB-attached device per Connector instance as the minimal baseline; more instances may run on a host with explicit stable port mapping, isolated credentials and resource bounds. No automatic cross-device identity reassignment.
- Headless service for **Pi Zero 2 W (512 MB), USB-only** and generic Linux; no local Backend, archive or application database required. Resource, CPU/memory and reconnection benchmarks must be measured on physical Pi.
- TLS peer verification and least-privilege broker credentials; secrets provisioned outside images/source; safe logging with no private keys, plaintext, secret credentials or full sensitive packet dumps.
- Bounded queues with documented overflow/drop accounting and observability. Distinguish serial connected, broker connected, forwarded, transport accepted and end-to-end Backend processing; never manufacture ACKs.
- Fail closed on invalid broker trust, unrecognized firmware framing or authorization. Explicit shutdown and recovery, no uncontrolled command replay.
- MQTT broker choice/failover behavior must follow approved trusted LAN/public broker policy where implemented; **broker policy is not a blocker** for initial single configured trusted broker.
- No direct Reader/browser serial access while this service owns the port. Browser Web Serial is a separate alternative connection mode.

## Implementation stages

1. **C0 — contract and fixtures:** firmware USB frame references, private Backend topic/auth/envelope and control-link agreement; fake serial and fake broker test harness, negative cases. Public coder can begin independently with synthetic contract.
2. **C1 — transport:** minimal transparent serial↔MQTT process, configuration validation, bounded queue, structured redacted logs and service health; fake endpoints pass.
3. **C2 — local deployment:** Linux and Pi Zero 2 W startup/restart, USB permissions, stable port selection, TLS secrets, broker outage/reconnect, metrics, bounded resources.
4. **C3 — interoperability:** real public-firmware device ↔ Connector ↔ broker ↔ private Backend, authorized observation and signed management round-trip, disconnect/reconnect and dual-transport arbitration.
5. **C4 — acceptance:** no fabricated device identity, no key custody/decryption, no duplicate business action, accurate transport vs RF outcomes, sustained Pi load/recovery and documented operator setup.

## Dependencies and remaining technical verification

Private Backend topic/ACL/envelope mapping and device-control-link arbitration; public firmware native USB framing and capability matrix; Pi Zero 2 W actual resource measurements; broker TLS credentials and test environment. These are **contract/verification dependencies**, not new product decisions. No public Backend rewrite, Reader UI or full broker deployment required to implement C0/C1.

## Status

Updated 18 November 2026. Nothing below has run against hardware or the private Backend.

| Stage | State |
| --- | --- |
| C0 contract and fixtures | **Draft published** in `contracts/connector/v1` (mapping, schemas, synthetic fixtures, validator in the contracts CI). Topic names are provisional and open questions Q1 to Q6 in `mapping.json` are for the Backend and firmware owners. The fake serial device and fake and real-mosquitto broker harness are in `connector/tests`. |
| C1 transport | **Core implemented** in `connector/` (Python; see "Runtime choice" below): serial selection by stable id, bounded framing, transparent forwarding both ways, one broker session with fallback and backoff, bounded queues with counted drops, health and metrics. Verified with unit tests, fakes and a real mosquitto in CI, plus a mutation check of the transport-safety rules. Not verified on a USB device, a Pi or against the Backend. |
| C2 local deployment | Not started. A container image exists; systemd packaging, USB permissions on a real Pi, TLS secret handling and Pi Zero 2 W measurements are open. |
| C3 interoperability | Not started. Needs the Backend's topic and ACL mapping, a real public-firmware device, and the dual-transport decision. |
| C4 acceptance | Not started. |

Related: [Reader MVP2 design](READER_MVP2_DESIGN.md), [components](COMPONENTS.md), [deployments](DEPLOYMENTS.md), [ADR](ARCHITECTURE_DECISIONS.md).

## Runtime choice

An engineering choice, not an accepted product decision: the Connector is Python 3.11+ with hash-pinned dependencies (`paho-mqtt`, `pyserial`), a single-process bridge loop plus paho's network thread, and a non-root multi-arch container. Both dependencies are pure Python, so a Pi Zero 2 W needs no per-platform native serial module; the framing rules stay small, testable functions. Interpreter memory on a Pi Zero 2 W is not yet measured. It forwards device envelopes unchanged and never replays a device command: a publish with an unknown outcome is counted, not resent. Contract: `contracts/connector/v1` (draft, topic names provisional).
