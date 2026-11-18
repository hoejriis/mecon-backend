# USB Connector contract v1 (draft)

The versioned interface between a MECON USB device and an MQTT broker, as carried by the standalone [USB Connector](../../../connector/README.md). Version `1.0.0-draft.1`. **Draft and synthetic:** topic names are provisional, and nothing here has been verified against hardware or the Backend.

| File | What it is |
| --- | --- |
| `mapping.json` | The contract: serial frame classification, topics, QoS and retain, client id, last will, reconnect, brokers, delivery and retry rules, queue bounds, metrics, errors, open questions. |
| `mapping.schema.json` | JSON Schema for `mapping.json`. |
| `fixtures/upstream.json` | Serial bytes from a device and the MQTT publishes they must produce (24 cases, each replayed at several chunkings). |
| `fixtures/downlink.json` | A broker message and the exact serial bytes it becomes, or the reason it is dropped (7 cases). |
| `fixtures.schema.json` | JSON Schema for the fixtures. |

All fixture data is synthetic: no real device id, key, signature or credential. Regenerate with `python3 connector/scripts/gen_fixtures.py`; the generator builds the bytes from the documented layout without importing the Connector, and one case reproduces the public firmware's own framing fixture (`docs/contract/fixtures/framing.json`) as an independent check.

`npm test` in `contracts/` validates `mapping.json` and every fixture, and checks that fixtures only name metrics and drop reasons the contract defines. The Connector's tests check the code against the same files.

## The mapping in short

| Serial side | MQTT side (provisional) |
| --- | --- |
| Companion: `>` wrapper frame whose payload starts `0x7F`, reassembled by (xid, index, count) | publish the message bytes to `{topic_root}/up`, QoS 1, not retained |
| Companion: any other `>` frame | dropped and counted (`serial_frames_total{kind="native"}`) |
| Repeater or Room server: line `mecon> {...}` + CR or LF, at most 1600 bytes | publish the bytes after `mecon> ` to `{topic_root}/up`, QoS 1, not retained |
| Companion: `<` wrapper with `0x7F` frames, one write | from `{topic_root}/down` (subscribed at QoS 0; retained refused) |
| Repeater or Room server: `mecon> ` + message + CR, one write | from `{topic_root}/down` |
| Connector's own state | retained `{topic_root}/connector/status`, last will `offline` |

Rules that matter:

- Byte for byte. The Connector reads only the transport header (marker and length, `0x7F`, xid, index, count) or the console prefix. It does not parse, validate or rewrite the envelope.
- The topic root, client id and credentials are provisioned configuration. The Connector never takes an identity from the device.
- `up` and `down` carry no transport metadata in the payload. The topic itself says the message came over USB; direct Wi-Fi uses the device's own topics.
- Retry: a publish whose outcome is unknown at a disconnect is counted and never resent; a command is written to the device at most once, and is dropped rather than held across an unplug or 5 s. The full table is in `delivery.retry_rules`.
- Every drop has a counter. `upstream_envelopes_total = upstream_published_total + sum(upstream_dropped_total) + upstream_queue_depth`.

## Sources

Cited with commit sha in `mapping.json`: the public firmware's `DEVICE_INTERFACE.md`, `OPERATIONS.md`, `AUTHORITY.md`, `MQTT.md` and `fixtures/framing.json`, and this repository's `reader/src/ble/serialFraming.ts` and `reader/src/device/meconIface.ts` for the wrapper rules already established.

## Open questions for the Backend and firmware owners

See `open_questions` in `mapping.json`: real topic names and ACL (Q1), the unsigned cable principal and downlink for unenrolled devices (Q2), dual-transport arbitration and duplicate events (Q3), whether `0x7F` is accepted before the app handshake (Q4), whether native frames are ever forwarded (Q5), and whether the Connector status topic is wanted (Q6).
