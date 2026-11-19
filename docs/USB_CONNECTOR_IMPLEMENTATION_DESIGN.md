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

Updated 19 November 2026. Nothing below has run against hardware, a Pi or the private Backend.

| Stage | State |
| --- | --- |
| C0 contract and fixtures | **Draft published** in `contracts/connector/v1` (mapping, schemas, synthetic fixtures, validator in the contracts CI). The Backend's topic mapping was added for C3 (see that row). Q1, Q2, Q3 and Q5 in `mapping.json` are answered; Q4 and Q6 are open. The fake serial device and fake and real-mosquitto broker harness are in `connector/tests`. |
| C1 transport | **Core implemented** in `connector/` (Python; see "Runtime choice" below): serial selection by stable id, bounded framing, transparent forwarding both ways, one broker session with fallback and backoff (the return to a higher-priority broker is make-before-break: the better broker is probed on a separate client id first, a failed probe is counted `broker_connect_attempts_total{result=probe}` and leaves the working session untouched, a successful one stops new upstream publishes and waits up to 5 s for in-flight ones before switching; Issue #79), bounded queues with counted drops, health and metrics, and the enrolment gate on downlink (below). Verified with unit tests, fakes and a real mosquitto in CI, plus a mutation check of the transport-safety rules. Not verified on a USB device, a Pi or against the Backend. |
| C2 local deployment | **Packaging implemented, not verified on a Pi.** `connector/deploy/` has a hardened systemd unit (dedicated user, `dialout` as supplementary group, strict sandbox, memory bounds, broker password through `LoadCredential=`), a udev template with no real ids, hash-pinned install and uninstall scripts for Debian and Raspberry Pi OS that never overwrite an existing config, a compose example (read-only root, non-root, device passthrough, healthcheck), and a measurement harness (`connector/scripts/measure.py`). CI runs shellcheck, `systemd-analyze verify` and `security`, the install test in a Debian bookworm container, a smoke test under real systemd on a CI VM (not a Pi), a mutation check of the packaging rules, and the harness for 60 s on GitHub's arm64 and amd64 runners (results labelled "runner, not a Pi"). **Open:** Pi Zero 2 W measurements (memory, CPU, reconnect, latency) and the systemd smoke test on a real Pi are a pooled owner step in the Connector README; a real serial device (`DeviceAllow`, `dialout`, hot-unplug codes) belongs to C3. |
| C3 interoperability | **Prepared, not run.** The Backend's topic and ACL mapping is in the contract (`mecon/<device_id>/{resp,ev/<ev>,status,req}`, a login with publish `resp`, `status`, `ev/+` and subscribe `req`), the Connector routes responses and events from the parsed `id` and `ev` with the bytes unchanged, the retained status and will are `{"online":...}`, and a port can be named explicitly (`device.select.path`, `--port`). A bench harness (`connector/scripts/c3_bench.md`: ACL'd local broker, reverse tunnel, bounded foreground run, content-free observer, a stand-in that can publish only `hello` and `deployment.get`) is proven end to end against the fake device. **Still open:** the hardware run itself, which needs a real public-firmware device (including the real `deployment.get`, `epoch` and `usig` behaviour the gate relies on), and a firmware answer on whether an enrolled device accepts any unsigned read of data only the Backend should see. |
| C4 acceptance | Not started. |

Related: [Reader MVP2 design](READER_MVP2_DESIGN.md), [components](COMPONENTS.md), [deployments](DEPLOYMENTS.md), [ADR](ARCHITECTURE_DECISIONS.md).

## Downlink enrolment gate

The firmware gives an unsigned USB cable caller local trust, and an unenrolled device accepts unsigned first provisioning and resets from it. The Connector would carry that trust onto the broker. Owner decision (18 November 2026): it relays broker messages to the device only while the device reports an enrolled Deployment record, learned from the device (`deployment.get`, `result.state` `provisioned`), never from configuration, and fails closed on anything else. It asks at attach, at each broker connection, on a new boot epoch and periodically; it closes at once on the first uplink interface message without `usig`; refused messages are counted, never held. Unsigned reads are relayed for an enrolled device, with no signature check on relayed content. Its own request and the answer are not published upstream. Detail: `enrolment_gate` in the contract and the Connector README.

## Runtime choice

An engineering choice, not an accepted product decision: the Connector is Python 3.11+ with hash-pinned dependencies (`paho-mqtt`, `pyserial`), a single-process bridge loop plus paho's network thread, and a non-root multi-arch container. Both dependencies are pure Python, so a Pi Zero 2 W needs no per-platform native serial module; the framing rules stay small, testable functions. Interpreter memory on a Pi Zero 2 W is not yet measured. It forwards device envelopes unchanged and never replays a device command: a publish with an unknown outcome is counted, not resent. Contract: `contracts/connector/v1` (draft, topic names provisional).
