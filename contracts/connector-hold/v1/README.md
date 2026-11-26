# WebSocket hold protocol, version 1 (draft)

How a **connector agent** holds one MECON device for a Backend over a WebSocket, so the Backend can reach a device that has no usable network path of its own (no Wi-Fi, no broker session, or a USB-only link), and the device's uplink can be carried back. The [USB Connector](../../../connector/README.md) implements this contract as its `hold` transport.

**Status: draft, version `1.0.0-draft.4`.** Draft 4 states how an agent that gates relaying on the device's own `deployment.get` reads its answer: a `busy` or `failed` answer is transient and does not release the hold (section 3.1, item 28); nothing changes for the Backend. Draft 3 lets an agent retry, a bounded number of times, a refusal that arrives within 30 s of its own socket closing (section 2.5, item 27, fixtures G and H); a refusal is otherwise a stop exactly as before. Draft 2 adds bootloader serial DFU through the hold (section 12: the `serial_dfu` declaration, `dfu_job`, the package route, `dfu_state`, and the offer gated on `ready`); nothing in draft 1 changes for an agent that does not declare it. The text is derived from a Backend's implementation and its reference agent (a browser application). Statements marked **(observed)** describe what that reference does and are not guaranteed by a written contract; such behaviour is a SHOULD here, and section 11 lists every gap. The fixtures are synthetic. No live Backend has been tested against this contract yet. Hex fields are case-insensitive.

Notation: `{base}` is the Backend's base URL. MUST and SHOULD describe what a conforming agent does to interoperate with a Backend that offers the hold.

| File | What it is |
| --- | --- |
| `README.md` | This protocol. |
| `schemas/iface_relay.schema.json`, `schemas/status.schema.json`, `schemas/iface_hello.schema.json`, `schemas/iface_result.schema.json`, `schemas/iface_event.schema.json` | JSON Schema for each frame an agent sends. |
| `schemas/dfu_state.schema.json` | JSON Schema for `dfu_state`, the agent's report on a bootloader DFU job (section 12). |
| `schemas/iface_req.schema.json`, `schemas/iface_ack.schema.json`, `schemas/refused.schema.json` | JSON Schema for each frame a Backend sends that an agent acts on. |
| `schemas/dfu_job.schema.json` | JSON Schema for `dfu_job`, which arms an agent for one bootloader DFU job (section 12). |
| `fixtures.schema.json` | JSON Schema for the fixtures. |
| `fixtures/A-companion-connect-hello-request-result.json` | Fixture A: connect, declare, hello, one request, one result (Companion). |
| `fixtures/B-refused-second-agent.json` | Fixture B: a second agent for the same device is refused. |
| `fixtures/C-companion-framing-400-bytes.json` | Fixture C: framing a 400-byte wire for a Companion (three frames). |
| `fixtures/D-console-request-and-result.json` | Fixture D: the console request and result lines. |
| `fixtures/E-event-forwarding-ack-outcomes.json` | Fixture E: event forwarding, an accepted event, a duplicate, a refusal, and a stream that is not forwarded. |
| `fixtures/F-serial-dfu.json` | Fixture F: a bootloader serial DFU on a held device, from `dfu_job` to the resume, with every byte sent to the bootloader. |
| `fixtures/G-refused-after-own-close-retried.json` | Fixture G: the network ends the hold (1006), the reconnect is refused because the Backend still sees the old socket, and the agent's retry is let in. |
| `fixtures/H-refused-after-own-close-three-retries-then-stop.json` | Fixture H: as G, but the refusals go on: three retries on the backoff, then the fourth refusal stops the agent. |
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

then closes with code **1008**. There is never a takeover. An agent that receives `refused` MUST stop and MUST NOT reconnect automatically; it reports the reason to its operator. The one exception is the bounded retry below.

An existing hold is released only when its socket closes, and the Backend notices a drop only when the TCP or WebSocket layer does. An agent whose socket was just lost may therefore be refused on its reconnect while the Backend still sees that old socket, although no other agent exists (open item 1).

**Retry after the agent's own close.** An agent MAY reconnect after a `refused` only when all of these hold:

- the reason is exactly `another agent holds this device`; any other reason (`connector token revoked`, for example) is a stop;
- the agent's own previous socket for this device closed, other than by `refused`, at most 30 s before the retry is due, and the agent remembers when. Such a close is a loss of the network (close 1006, or none), a close by the Backend other than 1008 (1000, 1001, 1011 and so on), or a close by the agent itself (section 6). An agent that has just started has no such close, so a refusal at its first start is a stop;
- the retry waits the normal backoff of section 6, counted afresh from the first refusal: 1 s, then 2 s, then 4 s;
- at most **3** retries follow one own close.

A refusal that does not meet all four (the fourth one after the same close, or one whose retry would fall more than 30 s after it) is a stop as above. A socket that is accepted and not refused was a successful connect: when it closes, that close starts a new window and the count starts again from 0. An agent logs and counts each retry. A Backend that replaces a stale link held with the same credential (open item 1) never sends this refusal to the agent that held the link, so the retry never happens there; a genuine second agent for the device is still refused, and if it had itself just lost a socket it stops after at most 3 retries within 30 s.

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

Send it on **every** socket, as soon as the socket is open and the agent can honour requests. An agent that runs bootloader serial DFU (section 12) adds `"serial_dfu": true`; any other agent sends the frame exactly as above. The Backend's record of the declaration ends with the socket. Sending it is idempotent. There is no acknowledgement and no way to withdraw it other than closing the socket. An agent SHOULD open the socket only when the device link is up and the device has answered, so the Backend never routes a request into a device that is still booting **(observed: the reference waits up to 30 s for the device to answer before opening the socket)**.

An agent that also gates relaying on the device's own `deployment.get` (the USB Connector's enrolment gate, `enrolment_gate.classification` in [`connector/v1`](../../connector/v1/mapping.json)) opens the socket only once the device says `provisioned`, and releases the hold (close 1000) only when the gate is closed by an answer that the device is not enrolled. It classifies each answer by its status. `ok` with `result.state` `provisioned` opens. `ok` with `none`, `corrupt` or an unreadable state, and any status other than `ok`, `busy` and `failed`, close at once and release the hold. `busy` (the device had no memory) changes nothing by itself: the hold, the gate and any request in flight stay as they are, and the agent asks again within a few seconds, backing off to the normal retry interval after a few `busy` answers in a row (the Connector: 3). If `busy` lasts longer than the agent's accepted window without a decided answer (the Connector: more than twice its recheck interval), each further `busy` counts as one `failed`. `failed` (the device could not read its storage) also changes nothing until a bounded number of `failed` answers come in a row (the Connector: 3), asked on the normal retry interval; only then does the gate close, and the hold is released, exactly as for a device that is not enrolled: a device whose storage keeps failing is handed back, not kept. Each answer whose status is not `ok` is logged with its status and error code, never its signature or result.

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

`dfu_job` is sent only on a socket that declared `serial_dfu` (section 12). A Backend may send other message types; an agent MUST ignore unknown types without closing. The Backend sends no ping messages and no heartbeat.

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
  - On `refused`, do not reconnect, except the bounded retry of section 2.5 after the agent's own close.
  - On an upgrade answered with HTTP 403 (a token the Backend does not reject by close but by refusing the upgrade), an agent MUST stop and surface it to its operator. It SHOULD do the same for HTTP 401 and for a close 1008 with no `refused` frame. **(observed: the reference retries such a failure like any other, at the 15 s cap; a new agent SHOULD stop instead)**. Retrying cannot help, and a loop only adds load.
  - When the operator stops the agent, do not reconnect.
- **Agent stop.** Close with code 1000 and a short reason (the reference sends `stopped`).
- **Subscriptions.** An agent that starts event subscriptions on the device itself (with its own `sub.start` requests) ends those, and only those, with `sub.stop` when it stops. Streams the Backend started belong to the Backend.
- **Device link drop.** An agent closes the socket when the device link drops, so the Backend does not route requests to a dead link. The one exception is a device resetting into its bootloader for a job the Backend armed on that socket (section 12.4). A cable cannot tell the device it was unplugged, so a device may keep streaming events to the dead link until its subscription lifetime ends.

## 7. Errors and close codes

| where | condition | signal |
|---|---|---|
| handshake | token missing, unknown or expired; or `bearer.<token>` without `mecon-bridge` | the upgrade is answered with HTTP 403 before accept; no WebSocket frame, no 1008 |
| after accept | another agent already holds this device (or the Backend has not yet noticed the agent's own previous socket close) | text frame `{"type":"refused","reason":"another agent holds this device"}`, then close 1008; a stop, except the bounded retry of section 2.5 within 30 s of the agent's own close |
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
15. When the device link drops, the agent closes the socket (the only exception is item 21).
16. The agent ignores unknown `type`s from the Backend and does not close the socket for them.
17. The agent sends only JSON text frames, each an object with a string `type`.
18. After the device's `hello` is read, the agent sends `iface_hello` with the hello result object, after `iface_relay` on every connect and before any result or event; its own `hello` request and the answer to it are not uploaded as a result.

Items 19 to 26 apply to an agent that runs bootloader serial DFU (section 12). An agent that does not, sends `iface_relay` without `serial_dfu` and ignores `dfu_job` (item 19).

19. The agent sends `"serial_dfu": true` in `iface_relay` only when it is configured to run serial DFU; otherwise the frame is exactly `{"type":"iface_relay"}`, and a `dfu_job` is ignored: nothing is fetched and nothing is armed.
20. On `dfu_job` the agent sends `dfu_state` `fetching`, fetches `GET {base}/gateway/dfu-package/{job}` with its per-device token as `Authorization: Bearer`, and checks the length against `size` and the SHA-256 against `sha256` before it uses a byte. A package that is fetched, checked and read is `dfu_state` `ready`; a refusal, a mismatch or a package over its limit is `dfu_state` `failed` (stage `fetch` or `verify`), and the device is not touched. The Backend relays the offer only after `ready`.
21. Only when a `dfu_job` armed this socket, the agent has sent `ready` for it, and the device link drops within 60 s of `ready` does the agent keep the socket open; any other link drop, a drop before `ready` included, closes it (item 15). The agent never opens the bootloader port without an armed job.
22. From the link drop until the resume the agent writes no request anywhere: an `iface_req` that arrives is dropped as with a closed gate, and the bootloader port receives only the DFU transfer.
23. The agent reports `ready`, `waiting-bootloader`, `transferring`, `rebooting` and `installed-pending-hello` in that order; when the application port returns it sends `iface_relay` (with `serial_dfu`) and then `iface_hello` on the same socket.
24. A transfer that fails is retried, up to 3 attempts in all, then reported as `dfu_state` `failed` with the stage and the error; the agent keeps the socket without relaying, resumes when the application port returns, and runs again on a new `dfu_job` for the same job.
25. When a new socket opens while a DFU is under way or has failed (no device link), the agent sends `iface_relay` (with `serial_dfu`) and then the current `dfu_state` once more, `failed` with its stage and error.
26. A job that has stayed `failed` with no device link and no new `dfu_job` for the agent's cap (30 minutes by default) is dropped, and the hold is released as on any device link drop.

Item 27 applies to every agent; item 28 to an agent that gates relaying on `deployment.get` (section 3.1).

27. A `refused` with the reason exactly `another agent holds this device`, arriving within 30 s of the agent's own socket closing other than by `refused`, is retried at most 3 times after that close, on the 1, 2, 4 s backoff, each retry due within 30 s of the close; the agent logs and counts each one. Any other reason, a refusal at first start, a retry that would fall later than 30 s after the close, or the fourth refusal after one close stops the agent as in item 5. A socket that is accepted and not refused starts the count again when it closes.
28. A `busy` answer to the agent's own `deployment.get` neither closes its gate nor releases the hold by itself, and is asked again within a few seconds (after a bounded number in a row, on the normal retry interval), unless it lasts past the agent's accepted window without a decided answer, when each further `busy` counts as one `failed`; a `failed` answer closes the gate and releases the hold, as "not enrolled" does, only after a bounded number in a row, a run that any decided answer ends; any other status that is not `ok`, and `ok` with `none` or `corrupt`, closes the gate and releases the hold as before.

## 10. Fixtures

JSON files, one scenario each, validated by `contracts/validate.mjs` against `fixtures.schema.json` and the frame schemas. A scenario is an ordered list of steps: `handshake`, `send` (agent to Backend, a frame), `recv` (Backend to agent), `device_write`, `device_read`, `device_line`, `close` (by the `agent`, the `backend`, or the `network`, which is a lost connection with no close frame). A `handshake` or `close` step may carry `t`, the seconds since the scenario started, which the section 2.5 rules need. `<token>`, `<issuer>`, `<sig>`, `<pubkey>` redact secrets and identifiers; every value is synthetic.

- **A** (Companion): the handshake (subprotocol form, `mecon-bridge` selected); `iface_relay`; `iface_hello`; its `iface_ack`; an `iface_req`; the device frames written; the device's result; `iface_result`; its `iface_ack`.
- **B**: a second agent: `refused`, then close 1008; no reconnect.
- **C**: framing a 400-byte wire for a Companion: three frames of 168, 168 and 64 bytes with the same `xid` (the value in the fixture is an example; any single byte, the same for all three frames).
- **D** (console): the bare CR, then `mecon> ` + wire + CR; the echoed prefix skipped; the result line; `iface_result`.
- **E**: an event uploaded and accepted; the same event again acknowledged `duplicate` (success); an altered event acknowledged `refused` (not resent); an event whose stream is `result` that is never sent.
- **G**: the hold is up; at 60 s the network ends it (1006); the reconnect at 61 s (the 1 s backoff) is refused, `another agent holds this device`, then close 1008; the retry at 62 s (1 s after the refusal) is let in, and the agent sends `iface_relay` and `iface_hello` again. The validator checks that a reconnect after a refusal is allowed by section 2.5: the reason, an own close before it, at most 3 retries, the backoff, and the 30 s window.
- **H**: as G, but every reconnect is refused: retries at 62, 64 and 68 s (1, 2 and 4 s after each refusal), and the fourth refusal, at 68 s, ends the scenario: the agent stops.
- **F** (serial DFU): `iface_relay` with `serial_dfu`; `dfu_job`; `fetching`; the package fetch (`package_get`: the path, the token presentation, the size, the SHA-256 and the synthetic package itself); `ready`; only then the offer relayed and its answer uploaded; the application port lost (`device_link`); `waiting-bootloader`; the bootloader port opened; `transferring`; every packet written to the bootloader (`bootloader_write`: the packet, its sequence number, the exact bytes on the wire and the bootloader's acknowledgement); `rebooting`; the application port back; `installed-pending-hello`; `iface_relay` and `iface_hello` again on the same socket. The validator decodes each packet (SLIP, header checksum, CRC, opcode, order) and checks that the init packet and the image are the package's own.

## 11. Not specified / open

1. **Stale-socket refusal.** An agent can be refused while the Backend has not yet noticed that the agent's previous socket closed. Section 2.5 lets an agent that remembers its own close retry such a refusal up to 3 times within 30 s; an agent process that restarted has no such record and still stops on it. No takeover and no timeout for a half-open socket is described here; a Backend that replaces a stale link held with the same credential removes the cause.
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
12. **Serial DFU on hardware.** Section 12 has run only against a fake bootloader written from the legacy serial DFU protocol as `adafruit-nrfutil` sends it. The bootloader's real acknowledgements, its timing, and the USB identity it enumerates with are unverified until a bench run on a real board.
13. **Offer arguments.** Fixture F's `update.offer` arguments are illustrative; the firmware's update contract defines the offer and its answer. The agent never reads them.

## 12. Bootloader serial DFU through the hold (optional)

A device whose update is installed by its bootloader (a `bootloader-dfu` job) answers the update offer with `{"job":...,"state":"awaiting-confirm","dfu":"serial"}` and, about 1.5 s later, resets into its bootloader, which takes the package over USB serial. A held device has no browser beside it, so the agent that holds it runs the transfer. The Backend releases such an offer to a held device **only** when the socket that holds it made the declaration in 12.1, and never from a stored flag. Everything here is optional for an agent; one that does not declare `serial_dfu` is never sent `dfu_job`.

### 12.1 Declaration, per socket

```json
{"type":"iface_relay","serial_dfu":true}
```

Sent only by an agent configured to run serial DFU, on every connect, as `iface_relay` itself. Like the declaration, it lives and ends with the socket; the Backend never stores it. `serial_dfu` is `true` or absent.

### 12.2 `dfu_job` (Backend to agent)

```json
{"type":"dfu_job","job":"fw-7","sha256":"<64 lower-case hex>","size":1234}
```

| field | type | note |
|---|---|---|
| `job` | string | the update job id: 1 to 64 characters of `[0-9A-Za-z._:-]`, not starting with `.`, `_`, `:` or `-` (one URL path segment) |
| `sha256` | string | SHA-256 of the package bytes the package route serves for this job, 64 lower-case hex |
| `size` | integer | the package's length in bytes, at least 1 |

Sent on the socket that holds the device **before** the offer is relayed. The Backend **MUST** relay the `update.offer` for the job only after this socket has answered `dfu_state` `ready` for it, and **SHOULD** give up the job without offering when `failed` arrives instead, or when no `ready` arrives within a bound of its own choosing. It arms the agent for that one job on that one socket: a new socket starts unarmed. A `dfu_job` for a different job while one is only armed replaces it; one that arrives while a transfer is under way is ignored (the agent logs it). An agent ignores a `dfu_job` that does not match the schema.

### 12.3 The package

```
GET {base}/gateway/dfu-package/{job}
Authorization: Bearer <token>
```

`{job}` is the job id, percent-encoded as a path segment. The token is the hold's own per-device token (section 2.2), always in the header form, whichever form the socket used. The Backend serves the package (the release's DFU zip, byte for byte) **only** when the job is an update job of the device that token opens and the job is still open; it refuses otherwise, and does not tell the refusals apart (the reference answers 404). The agent does not follow a redirect, uses the same TLS rules as the socket, and treats any status but 200 as a refusal.

Before it uses a byte, the agent checks that the length equals `size` and the SHA-256 equals `sha256`, and that the package is within its own limit. It keeps the package in memory only, and only until the transfer ends. The package's `manifest.json` names the application image (`manifest.application.bin_file`) and its init packet (`dat_file`); a package without an application, or with anything besides it, is refused. A package that is missing, refused or does not match aborts the job before the device is touched (`failed`, stage `fetch` or `verify`). If the device has already reset, it stays recoverable in its bootloader.

The agent fetches and checks the package as soon as it is armed, while the device is still up, and then sends `ready`. A package that fails never becomes `ready`: the agent drops the job (the device is still up and was never offered the update), and a reset is an ordinary link drop.

### 12.4 The device resets (the one exception to closing on link drop)

When the device's application port drops while the agent is armed, has sent `ready`, and is within **60 s** of `ready`, the agent keeps the socket open. This is the only case in which a socket stays open without a device link. Without an armed job, before `ready`, or after the window, a link drop closes the socket as in section 6. From this moment until 12.6 the agent writes **no request**: an `iface_req` that arrives is dropped as with a closed gate, never held, and never written to the bootloader.

The agent then looks for the bootloader's own port (a different USB device from the application's, chosen by the agent's configuration, never guessed) for up to 30 s, and runs the transfer with that port opened exclusively. Without an armed job the agent never opens the bootloader port.

### 12.5 The transfer

Legacy Nordic serial DFU, as `adafruit-nrfutil` sends it: HCI packets in SLIP frames at 115200 baud.

- **Packet.** A 4-byte header, the payload, and a CRC-16/CCITT (polynomial 0x1021, initial 0xFFFF) over header and payload, little-endian. Header byte 0: sequence number (bits 0-2), acknowledgement number = sequence + 1 mod 8 (bits 3-5), data integrity flag 1 (bit 6), reliable flag 1 (bit 7). Byte 1: packet type 14 (bits 0-3) and the low 4 bits of the payload length (bits 4-7). Byte 2: the length's bits 4-11. Byte 3: the two's complement of the sum of bytes 0-2, so the four sum to 0 mod 256. The whole is SLIP-escaped (`C0` as `DB DC`, `DB` as `DB DD`) and framed by `C0` on both sides. The first packet of a transfer has sequence number 1.
- **Payloads**, each beginning with a 32-bit little-endian opcode: start `3`, then the mode `4` (application), SoftDevice size `0`, bootloader size `0` and the image size, all 32-bit little-endian; init `1`, then the init packet, then two zero bytes; data `4`, then up to 512 bytes of the image; stop `5`.
- **Order and timing.** Start, then a wait for the flash erase of at least 0.5 s, else 89.7 ms per 4096-byte page plus one page; init, then 1 s; the data packets, with a 102.4 ms wait after data packets 0, 8, 16 and so on, counted from 0 (a flash page is 8 packets); a final 102.4 ms; stop.
- **Acknowledgement.** After each packet the agent waits up to 1 s for a frame from the bootloader whose header acknowledgement number is the packet's sequence + 1 mod 8. An acknowledgement with another number is a repeat of an earlier one and is ignored. Without the right one the same packet is written again, up to 4 writes in all; then the attempt fails.

A failed attempt is retried with a fresh start (the bootloader takes one at any time), up to **3 attempts** in all. The bootloader checks the image; the agent neither signs nor alters a byte.

### 12.6 The resume

After stop the bootloader starts the new application, which comes back as the application port. The agent waits for it for up to 120 s, then takes the normal path on the **same socket**: it opens the port, reads the device's hello, asks the enrolment gate, and sends `iface_relay` (with `serial_dfu`) and `iface_hello`. The device's hello carries the update attestation, and the Backend confirms the job from it, as it does for any update. A device that is not enrolled after the update releases the hold as in section 3.1. If the socket dropped during the DFU, the agent finishes the transfer, reconnects (12.7), and the resume follows on the new socket.

### 12.7 `dfu_state` (agent to Backend)

```json
{"type":"dfu_state","job":"fw-7","state":"transferring"}
{"type":"dfu_state","job":"fw-7","state":"failed","stage":"transfer","error":"no-ack"}
```

| `state` | when |
|---|---|
| `fetching` | on `dfu_job` |
| `ready` | the package was fetched, checked and read; the Backend may now relay the offer, and the 60 s window starts |
| `waiting-bootloader` | the application port dropped within the window; looking for the bootloader port |
| `transferring` | the bootloader port is open and an attempt starts (sent again for each attempt) |
| `rebooting` | the stop packet was acknowledged |
| `installed-pending-hello` | the application port returned after the transfer |
| `failed` | with `stage` (`fetch`, `verify`, `bootloader`, `transfer` or `app-return`) and `error`, a short lower-case code such as `http-404`, `sha256-mismatch`, `not-found` or `no-ack` |

`dfu_state` is not acknowledged. The Backend records each state on the job, so a failure is reported, never silent. It is sent only while the socket is open. While a DFU is under way or has failed, the agent reconnects a lost socket as in section 6 even though it has no device link, and on the new socket sends `iface_relay` (with `serial_dfu`) and then the current state once more (`failed` with its stage and error); states passed through while it was down are not sent.

### 12.8 Failure

- **Package**: missing, refused, a mismatch or over the limit: `failed` (`fetch` or `verify`) at once, before the device is touched.
- **Bootloader port** not found within 30 s: `failed` (`bootloader`, `not-found`).
- **Transfer**: 3 failed attempts: `failed` (`transfer`, the last error).
- **Application port** not back within 120 s after the transfer: `failed` (`app-return`, `not-found`).

After `failed` the agent keeps the socket, does not relay, and waits. It resumes (12.6) when the application port returns, for example after a manual recovery, and it runs the job again when the Backend sends a new `dfu_job` for the same job: it fetches and checks the package again and sends it to the bootloader, which is still waiting. A `dfu_job` for a different job is ignored while one has failed this way. The agent holds a failed job only up to a cap of its own (the USB Connector: 30 minutes by default); then it drops the job and releases the hold as on any device link drop. The Backend ends the job on its own deadline regardless of what the agent does.
