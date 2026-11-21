# WebSocket hold protocol, version 1 (draft)

How a **connector agent** holds one MECON device for a Backend over a WebSocket, so the Backend can reach a device that has no usable network path of its own (no Wi-Fi, no broker session, or a USB-only link), and the device's uplink can be carried back. The [USB Connector](../../../connector/README.md) implements this contract as its `hold` transport.

**Status: draft, version `1.0.0-draft.1`.** The text is derived from a Backend's implementation and its reference agent (a browser application). Statements marked **(observed)** describe what that reference does and are not guaranteed by a written contract; such behaviour is a SHOULD here, and section 11 lists every gap. The fixtures are synthetic. No live Backend has been tested against this contract yet. Hex fields are case-insensitive.

Notation: `{base}` is the Backend's base URL. MUST and SHOULD describe what a conforming agent does to interoperate with a Backend that offers the hold.

| File | What it is |
| --- | --- |
| `README.md` | This protocol. |
| `schemas/iface_relay.schema.json`, `schemas/status.schema.json`, `schemas/iface_hello.schema.json`, `schemas/iface_result.schema.json`, `schemas/iface_event.schema.json` | JSON Schema for each frame an agent sends. |
| `schemas/iface_req.schema.json`, `schemas/iface_ack.schema.json`, `schemas/refused.schema.json` | JSON Schema for each frame a Backend sends that an agent acts on. |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-companion-connect-hello-request-result.json` | Fixture A: connect, declare, hello, one request, one result (Companion). |
| `fixtures/B-refused-second-agent.json` | Fixture B: a second agent for the same device is refused. |
| `fixtures/C-companion-framing-400-bytes.json` | Fixture C: framing a 400-byte wire for a Companion (three frames). |
| `fixtures/D-console-request-and-result.json` | Fixture D: the console request and result lines. |
| `fixtures/E-event-forwarding-ack-outcomes.json` | Fixture E: event forwarding, an accepted event, a duplicate, a refusal, and a stream that is not forwarded. |
| `fixtures/invalid-frames.json` | Frames the schemas must reject. |

`npm test` in `contracts/` validates every schema and fixture, replays the framing and exactness rules of each fixture, and fails on a schema or fixture file this README does not reference.

---

## 1. Purpose and roles

A **hold** is one long-lived WebSocket on which a connector agent tells the Backend "I am physically attached to this one device, and I will carry requests to it".

- **The Backend** is the server. It owns the device's enrolled identity, signs every request it sends, and verifies every answer.
- **The connector agent** holds the socket and the device link (USB serial). It speaks this protocol on the socket and the device interface on the link.
- **The device** is a public-firmware MeshCore device speaking the MECON device interface v1 (its public contract: the cable framing, the interface message section, and the Repeater/Room-server console). It is either a Companion (binary frames over serial) or a Repeater/Room server (a text console).

**Trust model.** The device signs its answers and events, and the Backend signs its requests, so the agent relays bytes unchanged and is not trusted for content: the Backend refuses any result or event whose device signature does not verify, whoever posts it. An agent that alters, fabricates or replays bytes gets them refused; the worst it can do by itself is withhold or delay.

A hold is bound to exactly one device. The credential in section 2.2 opens exactly one device's hold.

## 2. Connect

### 2.1 URL

```
GET {base}/gateway/ws        (WebSocket upgrade; wss:// for an https:// base)
```

An agent MUST use TLS (`wss`) for any Backend that is not on loopback.

### 2.2 Credential

A **per-device token**: an opaque secret bound to one device. It opens only that device's hold and cannot mint other credentials. A token may be short-lived or long-lived and revocable; a long-lived one suits a standing agent. Revoking a token closes an open socket at once (a `refused` frame with the reason `connector token revoked`, then close 1008), and revoking the device's enrolment revokes every token for it. How tokens are minted is outside this protocol.

Present the token in one of two ways.

**A. Header** (for clients that can set handshake headers):

```
Authorization: Bearer <token>
```

**B. Subprotocol** (for clients that cannot set headers; valid for any client):

```
Sec-WebSocket-Protocol: mecon-bridge, bearer.<token>
```

Both entries MUST be offered. `bearer.<token>` without `mecon-bridge` is not a credential. If the `Authorization: Bearer` header is present it is used and the subprotocol is not consulted. Do not put the token in the query string. An agent MUST NOT write the token to a log, a metric or an error message.

### 2.3 What the server selects

If the client offered `mecon-bridge`, the server selects (echoes) `mecon-bridge` in `Sec-WebSocket-Protocol`. It never echoes the `bearer.<token>` entry. A client that offered subprotocols MUST therefore accept `mecon-bridge` as the negotiated one and MUST NOT expect the token entry back. If `mecon-bridge` was not offered (the header form without it), no subprotocol is selected.

### 2.4 Handshake failure

A token that is unknown, expired or missing is not told apart, and is rejected **before** the upgrade is accepted: the client sees the upgrade answered with **HTTP 403** and never receives a WebSocket frame, so no 1008 close arrives for a bad token. (A token revoked while a socket is open is different: it arrives after accept, as a `refused` frame then close 1008; see 2.5 and section 7.) An agent MUST NOT retry a rejected upgrade with the same token: it stops and tells its operator (section 6). An agent SHOULD treat HTTP 401 the same as 403, and a close 1008 with no `refused` frame the same way, in case a Backend or an intermediary signals a rejection differently.

### 2.5 One agent per device

If a socket is already held for that device (by any agent), a new socket is accepted and immediately refused. The server sends one text frame

```json
{"type":"refused","reason":"another agent holds this device"}
```

then closes with code **1008**. There is never a takeover. An agent that receives `refused` MUST stop and MUST NOT reconnect automatically; it reports the reason to its operator.

An existing hold is released only when its socket closes, and the Backend notices a drop only when the TCP or WebSocket layer does. A restarting agent may therefore be briefly refused while the Backend still sees its old socket (open item 1).

### 2.6 Encoding

All frames are WebSocket **text** frames, each carrying one JSON object with a string `type`. An agent MUST send only such frames. A Backend logs and skips a frame that is not valid JSON, and ignores one whose `type` is unknown; the socket stays open. There is no frame-level versioning and no sequence number.

**A Backend may send other message types; an agent MUST ignore unknown types without closing.** A frame that is not JSON, is not an object, or has no string `type` is ignored the same way.

## 3. Messages agent to Backend

On connect the Backend marks the device online at once. The minimum is: send `iface_relay` after every connect, then answer `iface_req` frames per section 4, uploading what the device answers per section 3.3. An agent need not send any member not listed below.

### 3.1 `iface_relay` (declaration; required)

Declares "I carry the Backend's v1 requests over the device link I hold". Until it is sent, the Backend never sends `iface_req` on this socket (the request falls back to other paths).

```json
{"type":"iface_relay"}
```

Send it on **every** socket, as soon as the socket is open and the agent can honour requests. The Backend's record of the declaration ends with the socket. Sending it is idempotent. There is no acknowledgement and no way to withdraw it other than closing the socket. An agent SHOULD open the socket only when the device link is up and the device has answered, so the Backend never routes a request into a device that is still booting **(observed: the reference waits up to 30 s for the device to answer before opening the socket)**.

### 3.2 `status` (presence and identity; optional)

For a v1 device the Backend learns identity and state from the device's signed results, so `status` is optional. The Backend reads these fields, all optional except `type`; other members are carried to the same handler. A `reported_gateway_id` that differs from the id the Backend holds for this device drops the whole status silently.

| field | type | note |
|---|---|---|
| `type` | string, required | `"status"` |
| `online` | boolean | default true |
| `role` | string | free text; the reference sends `companion_gateway` or `repeater_observer` |
| `transport` | string | free text; the reference sends `browser` |
| `hardware_target`, `mecon_firmware_version`, `companion_name` | string | |
| `companion_public_key_hex`, `node_public_key_hex` | string | 64 hex |
| `capabilities` | string array | for example `["repeater_cli"]`; empty or absent for a v1 Companion |
| `health` | object | for example `{"battery_mv":3900}`; may be `{}` |
| `reported_gateway_id` | string | the device's own id |

```json
{"type":"status","online":true,"role":"repeater_observer","transport":"usb","node_public_key_hex":"<pubkey>","capabilities":["repeater_cli"],"health":{}}
```

A `status` is not a keepalive requirement (section 6).

### 3.3 Uploads: `iface_hello`, `iface_result`, `iface_event`

An agent sends the device's hello, results and events **on the socket**. The socket already names the device, so no device id and no second credential are needed. Each frame is checked on the Backend exactly as a signed device message is: the device's signature over the exact bytes, and the replay and duplicate rules. The Backend answers each with one `iface_ack` (section 4.3).

```
{"type":"iface_hello",  "ref": <any JSON value, echoed>, "hello": { ...the device's v1 hello result object... }}
{"type":"iface_result", "ref": <echoed>, "message": "<the result text exactly as the device sent it>"}
{"type":"iface_event",  "ref": <echoed>, "stream": "<ev value>", "message": "<the event text exactly as sent>"}
```

- `ref`: any JSON value; an agent SHOULD use an integer that grows for the life of the process so a late acknowledgement is never mistaken for a newer frame's.
- `message`: a non-empty string of at most **8,192** characters: the device's exact text, not parsed and re-serialised, not trimmed. The device's signature is checked over those exact characters. (JSON string encoding of the text is lossless; the Backend decodes it before checking.) A device message that is not valid UTF-8, or longer than the limit, is not sent.
- `stream`: the event's `ev` value. It MUST match `^[a-z][a-z_]{0,31}$` and MUST NOT be `result`. An event whose `ev` does not match is dropped by the agent, not sent.
- `iface_hello`: send it after reading the device's `hello` (the agent sends the plain, unsigned `hello` read to the device itself, with an id of its own; section 4.2 explains how its answer is told from a relayed request's). The frame carries the hello **result object**. A device pages its `hello` capability list (`cursor` in, `next` out). The agent reads every page itself, asking `hello` again with `args {"cursor": <next>}` as its own request, one at a time, until `next` is null (**observed**: the reference stops after 40 pages, or at a page that fails or times out). The frame then carries the merged result object: the first page's members with the capabilities of all pages, in order and without duplicates, and **no `next`**. A hello of one page is sent exactly as the device gave it. It records the device's id once the device's node key matches the one enrolled for this hold, and it is required before results and events are accepted on a device the Backend has no v1 id for. Send it after `iface_relay` on every connect, and again when the device has rebooted **(observed)**.
- A device result is uploaded only when it answers a request the agent relayed (section 4.1), and an event when the device sends one. The agent's own request and the device's answer to it (the hello) are the agent's traffic and are never uploaded as results.

An agent MUST NOT send `register`, `heartbeat`, `job_status` or `channels`: those belong to a different agent kind and are ignored here as unknown types.

## 4. Messages Backend to agent

### 4.1 `iface_req` (the v1 request)

Sent only after `iface_relay`, one at a time per device: the Backend does not send the next request to a device until the previous one is answered or about 8 s have passed, and then sends the next regardless, so late results are possible **(observed)**.

| field | type | note |
|---|---|---|
| `type` | string | `"iface_req"` |
| `id` | string | the request id, 1 to 32 characters of `[0-9A-Za-z._:-]`; identical to the `id` inside the signed body; the device's result names it |
| `wire` | string | the exact request text to send to the device: a JSON object, the signed wrapper, UTF-8, at most 4,096 bytes |

```json
{"type":"iface_req","id":"j7","wire":"{\"mecon_auth\":1,\"issuer\":\"<issuer>\",\"sig\":\"<sig>\",\"body\":\"{\\\"v\\\":1,\\\"id\\\":\\\"j7\\\",\\\"op\\\":\\\"status.get\\\"}\"}"}
```

`wire` is already a JSON **string value**: JSON-decode the frame once, take `wire` as a string, and write its UTF-8 bytes to the device **unchanged**: no trimming, re-serialising, re-escaping, key reordering or adding `auth`. The agent MUST NOT interpret `wire` (it may read `id`). An agent MUST ignore a frame lacking a string `id` or `wire`.

The Backend treats the send as delivered once the frame is queued on the socket; it does not wait for the agent. **No result for a request is not an error to the Backend**: its own sweeps retry later, possibly with the same `id` and bytes, so the same `id` can arrive again, including while the first is still waiting (section 5.2).

### 4.2 Device framing of `wire`

Check size first: at most **4,096** bytes for a Companion link; at most **1,600** bytes for a console link (the device's bound on the envelope after `mecon> `, not counting the ending CR or LF; open item 6). A `wire` over the bound for its link cannot be sent: the agent drops it silently (no failure message exists; the Backend sweeps).

**Companion (USB serial), device interface v1 message frames.** Split the UTF-8 bytes into chunks of at most 168 bytes; every chunk but the last carries exactly 168 bytes. Count = ceil(len / 168), 1 to 25. Each frame is the Companion command code `0x7F` followed by a 3-byte header and the chunk:

```
byte 0   0x7F            (the interface command code)
byte 1   xid             one byte; the same for all frames of one message; use a new value per message
byte 2   index           0-based
byte 3   count           total frames in this message
bytes 4..  chunk (1 to 168 bytes)
```

These are Companion Radio Protocol frames: on USB serial each is wrapped in that protocol's own serial framing (outside this document). Send all frames of one message contiguously: never interleave another message's frames on the link, and never send a second request before the first is answered or abandoned (the device reassembles one message at a time). **(observed)** The reference waits for the result with a **15 s** timeout and on timeout abandons the request. A frame with a new `xid` while one message is incomplete discards the incomplete one; the device drops an incomplete message after 5 s. Frames before the last get no device reply; the last frame's reply is the result frames. If, while sending the last frame, the device answers with the Companion error code (a native error frame, code 1) it has no v1 interface, which is not a result.

Result frames from the device use the same `0x7F` framing in the opposite direction. Reassemble by `xid`, `index` and `count` (frames may arrive out of order; duplicates are ignored), then UTF-8 decode the message: that text is the result. Frames not starting with `0x7F` are native Companion frames, not part of this protocol.

**Repeater / Room server (text console).** The request goes as one line:

1. Before the first request on a link, write a **bare CR** (one `\r`, no text), which ends whatever partial line the device's buffer holds. Without it, stray bytes already buffered turn the next request into typed text that the console echoes and runs as a CLI command. Do this once per link, then write the request immediately after, without waiting.
2. Write `mecon> ` (the seven characters, ending in one space), then `wire`, then `\r` (CR) to end the line.

`wire` MUST NOT contain CR or LF. A wire that does is not sent. This holds for the Backend's signed wrapper, which is single-line JSON, so a conforming Backend never sends one.

The device echoes only the prefix, and then answers on a line of its own, `mecon> {...}` **(observed: the line is terminated by CR and/or LF)**. Every other line (echoed text, firmware logs, stock CLI replies) is not part of the interface and MUST be skipped. A line is a result or event only if it starts, after optional leading CRs, with `mecon> {`; the message is everything after `mecon> `. Strip nothing else.

**The agent's own requests.** An agent that sends the device a request of its own (the hello above) MUST give it an id it can tell from a relayed one, keep it to one request on the link at a time like any other, and consume the answer itself: it is not an `iface_result`.

### 4.3 `iface_ack`

The Backend answers each upload with one acknowledgement:

```json
{"type":"iface_ack","of":"iface_result","ref":3,"outcome":"<string>"}
```

- `of` is the type of the frame acknowledged and `ref` is the value the agent sent.
- An `outcome` starting with `refused` means nothing was recorded: an unsigned, forged or replayed message, an invalid frame or stream, a device not enrolled, or no v1 device on record. The agent MUST NOT resend the same bytes.
- `outcome` is an informational string. Success is anything that does not start with `refused`. Only `iface_hello` is answered with a fixed word (`recorded`); for `iface_result` and `iface_event` the outcome is whatever the Backend's handler returns (for example `hello: confirmed` or `config.get: ...`), so an agent MUST NOT depend on a particular success text.
- `duplicate` (events) means the event was already received, from another transport or earlier. It counts as success.

An acknowledgement is not a delivery receipt for the radio or an answer from the device. An agent MUST NOT fabricate one.

### 4.4 `refused`

See section 2.5. The frame is `{"type":"refused","reason":"<string>"}`. The reason is the Backend's text: an agent shows it to its operator and treats it as data, never as markup.

### 4.5 Other messages

A Backend may send other message types; an agent MUST ignore unknown types without closing. The Backend sends no ping messages and no heartbeat.

## 5. Results, events and duplicates

### 5.1 Unsolicited device events

A device sends **events** (envelopes with a string `ev`, `"v":1`, also signed) on the link that received a subscription, without a request. The Backend or the agent creates subscriptions through ordinary requests. The agent forwards each event it receives as `iface_event` (section 3.3), best effort: the event is dropped and counted, not queued for later, when the socket is down. A refused or failed upload is not retried, and `duplicate` is success.

### 5.2 A request abandoned; duplicate ids

If the device does not answer within the agent's wait **(observed: 15 s; not a protocol constant)**, or the link closes, the agent uploads nothing and writes nothing again. The Backend resends unanswered requests from its own sweeps (same `id`, same bytes).

The Backend can resend an `iface_req` with an `id` already in flight. An agent SHOULD refuse a second request while one with that `id` is waiting (it does nothing, and the first one's result still goes). Results and events may be uploaded in any order across ids; the Backend orders by the device's own counters.

A result that arrives after its request was abandoned is still the device's own signed answer. An agent MAY upload it; the Backend accepts or refuses it on its signature and counters.

## 6. Liveness and reconnect

- **No application ping.** Neither side sends heartbeat, ping or pong messages on this socket. The Backend does not time out an idle socket in this code; whether the WebSocket layer sends control-frame pings, or an intermediary idles the connection out, is not stated (open item 2). An agent SHOULD send WebSocket control pings, or a periodic `status`, if its network path needs it.
- **Presence.** The Backend marks the device online when the socket is accepted. For a v1 device a signed result is itself proof of presence. It also pings a v1 device on its own with a signed `status.get` after about 240 s of silence, through the normal request path.
- **Socket drop.** When the socket closes for any reason the Backend releases the hold at once (a new socket is then accepted), marks the device offline (a device with an independent broker session keeps its own presence), and forgets `iface_relay`. Requests then go to the broker if the device has one. Requests already sent as `iface_req` and unanswered are not cancelled; its sweeps resend them to the broker or to a new hold after a new `iface_relay`.
- **Reconnect.** On any close other than `refused`, an agent reconnects with delays of **1, 2, 4, 8, then 15 s** (it stays at 15 s); the attempt counter resets when a socket opens. After reconnecting it sends `iface_relay` again (and `iface_hello`).
- **Stop, do not retry.**
  - On `refused`, do not reconnect.
  - On an upgrade answered with HTTP 403 (a token the Backend does not reject by close but by refusing the upgrade), an agent MUST stop and surface it to its operator. It SHOULD do the same for HTTP 401 and for a close 1008 with no `refused` frame. **(observed: the reference retries such a failure like any other, at the 15 s cap; a new agent SHOULD stop instead)**. Retrying cannot help, and a loop only adds load.
  - When the operator stops the agent, do not reconnect.
- **Agent stop.** Close with code 1000 and a short reason (the reference sends `stopped`).
- **Subscriptions.** An agent that starts event subscriptions on the device itself (with its own `sub.start` requests) ends those, and only those, with `sub.stop` when it stops. Streams the Backend started belong to the Backend.
- **Device link drop.** An agent closes the socket when the device link drops, so the Backend does not route requests to a dead link. A cable cannot tell the device it was unplugged, so a device may keep streaming events to the dead link until its subscription lifetime ends.

## 7. Errors and close codes

| where | condition | signal |
|---|---|---|
| handshake | token missing, unknown or expired; or `bearer.<token>` without `mecon-bridge` | the upgrade is answered with HTTP 403 before accept; no WebSocket frame, no 1008 |
| after accept | another agent already holds this device | text frame `{"type":"refused","reason":"another agent holds this device"}`, then close 1008 |
| after accept | the token was revoked while the socket was open | text frame `{"type":"refused","reason":"connector token revoked"}`, then close 1008 |
| agent close | normal stop, or the device link dropped | close 1000 (reason free text, for example `stopped`) |
| any | malformed JSON frame from the agent | logged by the Backend, frame skipped, socket stays |
| any | unknown `type` from the agent | logged, ignored, socket stays |
| any | handler error on a known type | logged, socket stays |
| `iface_req` | too large for the device link, or the agent cannot send | agent-side only; no message to the Backend; the Backend resends later |
| upload | the Backend refuses it | `iface_ack` whose `outcome` starts with `refused`; the socket stays |
| transport | network loss | close 1006 or none (the client's runtime reports it); reconnect per section 6 |

## 8. Optional schema notes

The JSON Schemas check the shape of each frame. They cannot express the byte limits on `wire` (bytes, not characters) or the exactness of `message`; the fixtures and the conformance list do. A frame an agent sends is validated with `additionalProperties: false`, so a typo is caught; the Backend's frames allow extra members, because an agent ignores what it does not know.

## 9. Conformance checklist

1. The agent connects to `{base}/gateway/ws` and offers either `Authorization: Bearer <token>` or exactly the subprotocols `mecon-bridge` and `bearer.<token>`.
2. With the subprotocol form, the agent accepts `mecon-bridge` as the negotiated subprotocol and never expects the token entry to be echoed.
3. With a missing, unknown or expired token the upgrade is answered with HTTP 403; the agent stops, surfaces it to its operator and does not enter a reconnect loop. (A token revoked while the socket is open arrives as a `refused` frame then close 1008, which also stops it.)
4. The agent sends the text frame `{"type":"iface_relay"}` after every successful connect, before it expects any `iface_req`.
5. A second agent for the same device receives `{"type":"refused","reason":"another agent holds this device"}` followed by close 1008; the first agent's socket is unaffected; the second agent does not auto-reconnect.
6. On `{"type":"iface_req","id":I,"wire":W}` the agent writes exactly the UTF-8 bytes of W to the device (never re-serialised), and sends nothing to the device for a frame missing a string `id` or `wire`.
7. For a Companion link, W is split into 168-byte chunks (last chunk 1 to 168 bytes), each frame `0x7F xid index count chunk`, all frames contiguous, the same `xid`, count 1 to 25, message at most 4,096 bytes; a larger W is not sent.
8. For a console link, before the first request the agent writes one bare CR; each request is written as `mecon> ` + W + CR; W containing CR or LF, or longer than 1,600 bytes, is not sent.
9. For a console link, the agent treats only lines starting with `mecon> {` as interface messages and discards every other line.
10. The agent carries one request at a time per device: it does not start a new request until the previous one is answered, timed out (the reference waits 15 s) or abandoned.
11. The agent sends each device result that answers a relayed request as `{"type":"iface_result","ref":R,"message":M}` on the socket, M being the device's exact text (byte for byte after JSON decoding), at most 8,192 characters. It reads the `iface_ack` for R: an outcome starting with `refused` is counted and not resent; any other outcome is accepted.
12. The agent forwards each device event as `{"type":"iface_event","ref":R,"stream":S,"message":M}`, S being the event's `ev` and matching `^[a-z][a-z_]{0,31}$` and not `result` (an event whose `ev` does not is not sent). The `iface_ack` outcome `duplicate` is success; an outcome starting with `refused` is not resent.
13. The agent never modifies, signs or adds fields (`auth`) to a Backend request, and never fabricates a result or an acknowledgement.
14. When the socket closes other than by `refused` or an operator stop, the agent reconnects with the 1, 2, 4, 8, 15 s (capped) backoff and sends `iface_relay` again on the new socket.
15. When the device link drops, the agent closes the socket.
16. The agent ignores unknown `type`s from the Backend and does not close the socket for them.
17. The agent sends only JSON text frames, each an object with a string `type`.
18. After the device's `hello` is read, the agent sends `iface_hello` with the hello result object, after `iface_relay` on every connect and before any result or event; its own `hello` request and the answer to it are not uploaded as a result.

## 10. Fixtures

JSON files, one scenario each, validated by `contracts/validate.mjs` against `fixtures.schema.json` and the frame schemas. A scenario is an ordered list of steps: `handshake`, `send` (agent to Backend, a frame), `recv` (Backend to agent), `device_write`, `device_read`, `device_line`, `close`. `<token>`, `<issuer>`, `<sig>`, `<pubkey>` redact secrets and identifiers; every value is synthetic.

- **A** (Companion): the handshake (subprotocol form, `mecon-bridge` selected); `iface_relay`; `iface_hello`; its `iface_ack`; an `iface_req`; the device frames written; the device's result; `iface_result`; its `iface_ack`.
- **B**: a second agent: `refused`, then close 1008; no reconnect.
- **C**: framing a 400-byte wire for a Companion: three frames of 168, 168 and 64 bytes with the same `xid` (the value in the fixture is an example; any single byte, the same for all three frames).
- **D** (console): the bare CR, then `mecon> ` + wire + CR; the echoed prefix skipped; the result line; `iface_result`.
- **E**: an event uploaded and accepted; the same event again acknowledged `duplicate` (success); an altered event acknowledged `refused` (not resent); an event whose stream is `result` that is never sent.

## 11. Not specified / open

1. **Stale-socket refusal.** A restarting agent can be refused while the Backend has not yet noticed that its previous socket closed. No takeover and no timeout for a half-open socket is described.
2. **Idle timeouts and WebSocket pings.** No application keepalive exists; whether the server stack or an intermediary sends or enforces control-frame pings or an idle limit is not stated.
3. *(Resolved.)* A bad, unknown or expired token is rejected before accept: the upgrade is answered with HTTP 403 and no 1008 frame is ever seen. Only the one-agent refusal and a token revoke arrive after accept, as a `refused` frame then close 1008.
4. **Backend-side request timeout.** The pacing wait (about 8 s) and the resend sweeps are Backend internals; the agent's 15 s device wait is the reference's choice, not a protocol constant.
5. **Frame ordering on the console.** The terminator the device uses on result lines (CR, LF or CRLF) and the echo details are observed behaviour of the reference reader (it strips leading CRs only); the firmware's console section is authoritative.
6. *(Resolved.)* The console bound is 1,600 bytes of envelope after `mecon> `, not counting the ending CR or LF. A request line may carry 1,600 bytes of `wire`, and a reply line is up to 1,609 bytes with the prefix and a CRLF ending.
7. **No-answer feedback.** There is no message to tell the Backend "this request cannot be carried" (too large, no link, device silent); the Backend learns only by its own timeout and resend.
8. **Status field semantics.** The content of `health` and the effect of `capabilities` on the Backend's later behaviour are not exhaustively specified; only the fields the reference sends are listed.
9. **Result size mismatch.** An upload's `message` may be up to 8,192 characters; the device interface limits one message to 4,096 bytes on a cable. The effect of a larger one is a refusal (upload) or a drop (device).
10. *(Resolved.)* An agent sends `sub.stop` only for event streams it started itself, when it stops. Streams the Backend started are the Backend's to end; the device also ends any subscription when its lifetime runs out. The USB Connector starts no subscription of its own, so it sends no `sub.stop`.
11. **No live test.** Nothing in this contract has been run against a live Backend; section 9 is a specification, not a test result.
