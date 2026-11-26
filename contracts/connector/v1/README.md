# USB Connector contract v1 (draft)

The versioned interface between a MECON USB device and an MQTT broker, as carried by the standalone [USB Connector](../../../connector/README.md). Version `1.0.0-draft.2`. Draft 2 classifies the device's answer to the gate's `deployment.get`: `busy` and `failed` no longer read as not provisioned (see the enrolment gate below). **Draft:** the topic and ACL mapping is the Backend's (relayed for stage C3); nothing here has been verified against hardware or the real Backend yet. Fixtures are synthetic.

| File | What it is |
| --- | --- |
| `mapping.json` | The contract: serial frame classification, topics, QoS and retain, client id, last will, reconnect, brokers, delivery and retry rules, queue bounds, metrics, errors, open questions. |
| `mapping.schema.json` | JSON Schema for `mapping.json`. |
| `fixtures/upstream.json` | Serial bytes from a device and the MQTT publishes they must produce, with the topic each goes to (28 cases, each replayed at several chunkings). |
| `fixtures/downlink.json` | A broker message on `req` and the exact serial bytes it becomes, or the reason it is dropped (7 cases, run with the gate open). |
| `fixtures/gate.json` | The enrolment gate: how each device answer to `deployment.get` opens or keeps closed downlink, and how an unsigned uplink or a new epoch closes it, and how `busy`, `failed` and other statuses are treated on a recheck (16 cases). |
| `fixtures.schema.json` | JSON Schema for the fixtures. |

All fixture data is synthetic: no real device id, key, signature or credential. Regenerate with `python3 connector/scripts/gen_fixtures.py`; the generator builds the bytes from the documented layout without importing the Connector, and one case reproduces the public firmware's own framing fixture (`docs/contract/fixtures/framing.json`) as an independent check.

`npm test` in `contracts/` validates `mapping.json` and every fixture, and checks that fixtures only name metrics and drop reasons the contract defines. The Connector's tests check the code against the same files.

## The mapping in short

| Serial side | MQTT side |
| --- | --- |
| Companion: `>` wrapper frame whose payload starts `0x7F`, reassembled by (xid, index, count) | publish the message bytes, QoS 1, not retained, to the topic its envelope routes to (below) |
| Companion: any other `>` frame | dropped and counted (`serial_frames_total{kind="native"}`) |
| Repeater or Room server: line `mecon> {...}` + CR or LF, at most 1600 bytes after the prefix (1607 with it) | publish the bytes after `mecon> `, same routing |
| Uplink envelope with an `ev` member (a safe name) | `{topic_root}/ev/<ev>` |
| Uplink envelope with an `id` and no `ev` | `{topic_root}/resp` |
| Uplink envelope with neither, an unsafe `ev`, or not JSON | dropped and counted (`upstream_dropped_total{reason="unroutable"}`) |
| Companion: `<` wrapper with `0x7F` frames, one write | from `{topic_root}/req` (subscribed at QoS 0; retained refused), **only while the enrolment gate is open** |
| Repeater or Room server: `mecon> ` + message + CR, one write | from `{topic_root}/req`, only while the gate is open |
| `deployment.get` request and its answer (the Connector's own) | never published upstream |
| Connector's own state | retained `{topic_root}/status`, QoS 0, exactly `{"online":true}` or `{"online":false}`; last will `{"online":false}` |

Rules that matter:

- Byte for byte. The Connector reads the transport header (marker and length, `0x7F`, xid, index, count) or the console prefix, and parses an uplink envelope only for `ev`, `id`, `epoch` and `usig` (the topic, and the enrolment gate). It never validates, rewrites, re-serialises or signs it.
- The topic root (`mecon/<device_id>`), client id (the login `dev-<gateway_id>-g<generation>`) and credentials are provisioned configuration. The Connector never takes an identity from the device. The login's ACL is: publish `resp`, `status` and `ev/+`; subscribe `req`; nothing else.
- Payloads carry no transport metadata and nothing is added: answers and events carry the device's own `usig`, requests are the Backend's signed envelope, passed through unchanged.
- Enrolment gate: downlink opens only after the device answers `deployment.get` with `result.state` `provisioned`; anything else, silence included, is closed. The answer is classified by its status (`classification` in `mapping.json`): `ok` with `none` or `corrupt`, an unreadable state, or a status other than `ok`, `busy` and `failed` closes at once; `busy` (the firmware had no memory) changes nothing and is asked again after `busy_retry_s` (default 3 s), keeping queued downlink and a hold as they are; `failed` (storage) is asked again after `retry_s` and closes only at `failed_threshold` (default 3) `failed` answers in a row, a run that any decided answer or a new serial port starts again. Each answer whose status is not `ok` is logged as a warning with its status and error code, never its `usig` or result. The first uplink interface message without `usig`, a new `epoch`, a broker reconnect or a lost serial port closes it at once, and a closed gate refuses and counts messages (never holds or replays them). See `enrolment_gate` in `mapping.json`.
- Retry: a publish whose outcome is unknown at a disconnect is counted and never resent; a command is written to the device at most once, and is dropped rather than held across an unplug or 5 s. The full table is in `delivery.retry_rules`.
- Every drop has a counter. `upstream_envelopes_total = upstream_published_total + sum(upstream_dropped_total) + upstream_queue_depth`.

## Sources

Cited with commit sha in `mapping.json`: the public firmware's `DEVICE_INTERFACE.md`, `OPERATIONS.md`, `AUTHORITY.md`, `MQTT.md` and `fixtures/framing.json`, and this repository's `reader/src/ble/serialFraming.ts` and `reader/src/device/meconIface.ts` for the wrapper rules already established.

## Questions

In `open_questions` of `mapping.json`. Answered: Q1 (2026-11-18, superseded by routing into `resp` and `ev/<ev>`); Q2 the owner's enrolment gate, replacing the opt-in switch; Q3 the Backend de-duplicates by (device, stream, epoch, seq) and the Connector releases explicitly on shutdown; Q5 native frames stay dropped. Q6 (the status topic, 2026-11-19): `{topic_root}/status`, retained, QoS 0, with the will `{"online":false}`; the Backend's `{"online":...}` shape replaces the Connector's earlier `connector` and `serial` payload. Open: Q4 (is `0x7F` accepted before the app handshake, does boot text precede frames), which only the C3 hardware run can answer.
