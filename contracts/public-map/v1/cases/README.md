# Public map feed v1 conformance cases

Replayable cases for `../openapi.yaml`, the anonymous public map feed. A Backend that serves the feed replays every case and passes each one. Every key, name, position, marker and address here is made up.

The format and the replay rules are the Reader API's, in [`../../../reader-api/v1/cases/README.md`](../../../reader-api/v1/cases/README.md): worlds, clients, requests, expectations and captures work the same way. `contracts/validate.mjs` checks these cases against the document as it checks the others: a case cannot expect a status, schema or header the document does not declare (a header expected `absent` need not be declared), and every operation has a case. Nothing in the feed needs a session, so a step without `as` is a fresh anonymous client.

## Files

- `cases.schema.json`: the shape of a case file.
- `worlds.json`: the one world the cases start from (nodes, observers, sources, markers) and the runner actions a case may take.
- `nodes.json`, `events.json`, `access.json`: the cases.

## Two expectations added to the Reader API's format

- `absent`: what the response body must never carry. `keys` are object keys, compared case-insensitively and exactly, at any depth. `values` are markers of the world (a private observer's key, name and position, a signal strength, a topic, a source name, a gateway label, a fleet name, a packet hash, a label an operator typed): none may appear, in any case, in any key or value of the serialized body. A replay fails the case when either is found. The validator refuses an `absent` that could pass without proving anything: a key the response schema allows (or any key when the schema is open), a marker the world does not contain, and an `absent` with no positive match or body check beside it, since an empty body passes every absence. The world's markers are present in every reception the cases record, so a Backend that copied a stored field into a payload would show one.
- `spans`: for every item of the array at `at`, the time at `to` is exactly `seconds` after the time at `from` (pointers relative to the item). The 45 second lifetime is checked this way.

## What the world needs from a Backend

- **Nodes.** `listed` in `worlds.json` says whether the contract lists the node. A position is `advertised` when the node's own advertisement carried it; an operator-set or inferred position is not.
- **Receivers.** Every reception carries the world's signal values, topic, source name, gateway label, fleet name and packet hash, so any of them reaching a payload is caught by `absent`.
- **Clock.** The runner controls the Backend's clock: `advance-clock` moves it, and a reception's `ago_s` is relative to it. A pulse is published a few seconds after its first reception, so `transmit` uses at least 3 seconds. The Backend's periodic work (its refresh and its re-read of who is eligible) runs when the clock moves and when a request arrives.
- **Cursors.** A cursor is accepted for at least 45 and at most 60 seconds, so the cases read one at 30 and refuse one at 61 seconds. `forge-cursor` builds a cursor the Backend never signed; the runner knows the Backend's cursor format, a Backend that signs differently implements the action its own way.
- **Rate limit.** The limit and its window are the Backend's own; `lower-rate-limit` lets a case reach it with a few requests.

## What the cases cover

- The catalogue: only nodes that advertise their own position and were heard through an eligible source; nothing for a node near (0, 0), with the one degree boundary; no ineligible source, no other party's device, no unmarked position; an advertised name or a key fingerprint, never an operator's label.
- What no payload carries: observer identity and keys, signal strength and ratio, packet id and hash, source, gateway, fleet and topic, as keys or values; manual contact names; unmarked positions; positions of observers that are not listed nodes.
- Pulses and lines: only eligible transmitters; lines only to listed public observers; the 45 second lifetime; the window without a cursor; receptions older than a pulse never replayed; a cursor returning only newer events; relay pulses from multi-byte paths only.
- Cursors: fresh, old, unknown and forged all behave as the contract says, and a 410 carries no events.
- Line references: reused within 45 seconds of first use, new after; event ids and references show no counter.
- Withdrawal: a node that stops advertising its position is revoked in the event list, leaves the catalogue and gives no pulse.
- Limits and switches: capped responses with a continuing cursor; 404 on both operations with the feed off, whatever the cursor; 429 with `Retry-After` per client address; a session cookie, a valid bearer and a bearer never issued all get exactly the anonymous answer, with no cookie set.

**Not covered yet:** a relay named by a hash two nodes share (an ambiguous hop), a direct-routed packet's path, and a restart of the Backend making every cursor unknown. Each needs a world action the runners do not have yet.
