# Observation API v1 conformance cases

Replayable cases for `../openapi.yaml`, the authorized observation projection. A Backend that claims to serve it replays every case and passes each one. Every name, address, position and id here is made up.

The format and the replay rules are the Reader API's, in [`../../../reader-api/v1/cases/README.md`](../../../reader-api/v1/cases/README.md): worlds, clients, requests, expectations, streams and captures work the same way. `contracts/validate.mjs` checks these cases against this document as it checks the Reader API's. A case cannot expect a status, schema or header the document does not declare, every required query parameter is given, and every operation has at least one case.

## Files

- `cases.schema.json`: the shape of a case file.
- `worlds.json`: the world the cases start from (fleets, users, observers, packets and receptions), and the runner actions a case may take.
- `observations.json`: the cases.

## What the world needs from a Backend

- **Observers.** An observer belongs to a fleet, or is an approved public source's. Its `location` is the position its owner shared, or null when none is shared.
- **Receptions.** A reception's `ago_s` places its receipt that many seconds before the case starts. Each reception's `rssi` is unique in the world, so a case tells receptions apart by it, never by comparing one caller's opaque ids with another's.
- **Packets.** Receptions of the same named packet are receptions of one packet. A Backend gives them one `packet_correlation_id` for a given caller.
- **Actions.** `add-reception` records a reception received now. `age-out-events` moves every cursor issued so far outside retention. `end-session` ends a client's session on the server while the client keeps its cookie.

## What the cases cover

- Every operation without a session.
- Fleet scope: own fleet and approved public sources visible, another fleet's observers and receptions absent.
- A withheld location read as null.
- Correlated receptions and the `provenance` of each.
- Cursors that are no cursor, `Last-Event-ID` winning over the query, and cursors moved out of retention.
- A stream continuing from a snapshot's cursor.
- A session ended on the server.

**Not covered yet:** a stream's `access_revoked` while open, `resync_required`, the heartbeat and freshness states. They need a runner that holds a stream open across an action, or a clock it controls.
