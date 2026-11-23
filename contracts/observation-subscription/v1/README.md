# Receive-only observation subscription profile, version 1 (draft)

How an **observation ingester** subscribes to MQTT brokers to capture MeshCore observation traffic: what a source profile names, what the ingester does on the wire, and what it reports. The ingester only reads. Parsing, deduplication and everything downstream are outside this contract; what it captures is handed on by the [raw capture append](../../raw-capture/v1/README.md) contract.

**Status: draft, version `1.0.0-draft.2`.** The text is derived from a Backend's ingester. Statements marked **(observed)** describe what that implementation does today and are SHOULD here; section 8 lists where it falls short of the contract. The fixtures are synthetic: no real hosts, users, keys or device ids.

| File | What it is |
| --- | --- |
| `README.md` | This profile. |
| `schemas/profile.schema.json` | JSON Schema for one source profile. |
| `schemas/status.schema.json` | JSON Schema for the status an ingester reports per profile. |
| `schemas/ingester.schema.json` | JSON Schema for the ingester's own counters (section 5a). |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-valid-profiles.json` | Fixture A: profiles a conforming ingester accepts. |
| `fixtures/B-invalid-profiles.json` | Fixture B: profiles the schema rejects (verification off, a credential value, no topic, a WebSocket path on TCP, QoS above 0, a publish topic). |
| `fixtures/C-connect-refuse-reconnect.json` | Fixture C: connect, a topic the broker refuses, an authorisation error, a reconnect. |
| `fixtures/D-ingester-buffer.json` | Fixture D: the receive bound, a full buffer and an unavailable archive, counted. |

`npm test` in `contracts/` validates every schema and fixture, replays the rules of fixture C, and fails on a schema or fixture file this README does not reference.

---

## 1. Roles

- **The broker** routes MQTT messages and owns transport authentication and topic ACLs.
- **The observation ingester** connects to one broker per profile, subscribes, and hands every message it receives, unchanged, to the raw capture append. It holds no device identity and sends nothing to devices.

A profile is one source. Its `name` is the **source identity** carried by every capture from it.

## 2. The profile

`schemas/profile.schema.json` is normative.

- `host`, `port`, `transport` (`tcp` or `websockets`; `ws_path`, default `/mqtt`, only for `websockets`).
- `tls`: `enabled`, and `verify`, which is always `true`. A profile cannot turn certificate verification off.
- `topics`: one or more topic filters to subscribe to. MQTT wildcards are allowed.
- `qos`: `0`, the only value. An absent field means 0.
- `credential`: optional, and only **references** (environment variable names) for a username and a password, never their values. A profile document never contains a secret.
- `adapter`: the name of the payload format, used downstream. Capture never parses with it.
- A profile has **no field for a topic to publish to**.

## 3. On the wire

1. The ingester MUST connect with a client id unique per ingester instance and source, so two ingesters (two Backends) reading the same broker never take over each other's session. **(observed: the id is a fixed prefix, the source name, and a short tag of the Backend's instance id.)**
2. It MUST NOT request a persistent session. **(observed: no session is requested.)**
3. On **every** successful connect, including each reconnect, it MUST subscribe to every topic of the profile at QoS 0.
4. It MUST NOT publish. A conforming ingester has no publish path. The broker account it uses SHOULD be subscribe-only (an ACL that allows `subscribePattern` on the profile's topics and nothing else), so a fault cannot write either.
5. A topic the broker refuses in its SUBACK is reported in the status `refused` list. The ingester does not substitute another topic.
6. On a failed connect or a disconnect it reconnects with exponential backoff, starting at about 1 s and capped at about 2 minutes. **(observed: the MQTT client library's default.)**

## 4. Messages

- Every message received is captured as it arrived: the payload bytes unchanged, the topic, the source identity, the receive time, and the **retained** flag.
- A **retained** message (the broker's stored copy, delivered at subscribe time) is captured and flagged `retained`, never dropped at capture. It may be old, so downstream MUST NOT treat it as a live observation. **(observed: stored flagged, then skipped by normalization.)**
- The ingester does not inspect, parse or validate payloads.

**The receive bound.** An ingester MUST bound what one message can make it hold, because a broker may send any size MQTT allows (256 MB in MQTT 3.1.1):
- Over MQTT 5, it SHOULD set the CONNECT property Maximum Packet Size, so the broker never sends it a larger packet.
- In any case it measures each payload on receipt. One over its bound, `max_receive_bytes` (strictly greater: a payload of exactly the bound is kept whole, as with the archive's own limit), is handed on as a stub, with its size and content hash only (the [raw capture append](../../raw-capture/v1/README.md), section 2), and counted `oversize`. Its bytes are not held past the hash.

**The buffer.** Captures wait for the archive in a buffer of a fixed bound. One that arrives while the buffer is full is lost and counted `shed`, never by the archive; an oversize one lost that way counts in both `oversize` and `shed`. The network thread never waits on the archive.

## 5. Status

`schemas/status.schema.json`: per profile, `state` is `unknown`, `connecting`, `connected`, `disconnected` or `error`.

- `last_error` is set (non-empty) exactly in `error`, and null in every other state.
- `last_connected_at` changes only on a successful connect.
- `subscribed` and `refused` are the SUBACK's outcome.
- A failed authorisation is an `error` with the broker's reason. **(observed: it arrives as a nonzero CONNACK code.)**

## 5a. The ingester's counters

`schemas/ingester.schema.json`, across all profiles: `received` (every message, counted on arrival), `handed_on` (captures the archive answered `available` for), `buffered` and `oldest_buffered_ms` (levels), `bound`, `shed` and `oversize`. At every instant `received` = `handed_on` + `buffered` + `shed`. This is where the lag before the archive shows; an archive that accepts at its commit reports `buffered` 0.

## 6. Fixture C's rules

The validator replays fixture C and checks:
- every successful `connack` (code 0) is followed by one QoS 0 subscribe per profile topic, in that step;
- no step has any action other than subscribe;
- each step's status satisfies section 5;
- `last_connected_at` moves only on a successful connect;
- `subscribed` and `refused` equal the SUBACK's `granted` and `refused`.

And it replays fixture D's events, a message of a given size or an append's answer, against section 4's receive bound and buffer, and checks the counters after each, with the identity of section 5a.

## 7. Out of scope

Device-control traffic and the Connector transport each have their own profiles. Payload formats, normalization, deduplication and decryption are downstream.

## 8. Gaps in the observed implementation

- No receive bound (section 4): a message of any size is held and stored whole.
- No reconnect counter.
- No buffer of its own with a bound and a `shed` count: a full in-memory buffer writes through on the receiving thread.
- Topics a broker refuses are not reported per topic.
- Certificate verification has no override (as the contract wants), but there is also no per-profile CA file.
