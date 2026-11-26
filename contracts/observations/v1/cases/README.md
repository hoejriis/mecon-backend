# Observation API v1 conformance cases

Replayable cases for `../openapi.yaml`, the authorized observation projection. A Backend that claims to serve it replays every case and passes each one. Every name, address, position and id here is made up.

The format and the replay rules are the Reader API's, in [`../../../reader-api/v1/cases/README.md`](../../../reader-api/v1/cases/README.md): worlds, clients, requests, expectations, streams and captures work the same way. `contracts/validate.mjs` checks these cases against this document as it checks the Reader API's. A case cannot expect a status, schema or header the document does not declare, every required query parameter is given, and every operation has at least one case.

## Files

- `cases.schema.json`: the shape of a case file.
- `worlds.json`: the worlds the cases start from (fleets, users, observers, packets and receptions), and the runner actions a case may take. `two-fleets-observed` is the main one; `unobserved` has nothing anyone may observe, not even an approved public source, which every member may otherwise see.
- `observations.json`: the cases.

## Id form checks

The observation cases add one expectation to the Reader API's format: `ids`, a list of checks on opaque ids in the response body. Each check reads the value at `field` (a JSON pointer relative to each item) of every item of the array at `at`; the array must hold at least one item with that field, or the check fails.

- `unsequenced: true`: the distinct values number at least two, and once the longest prefix common to all of them is removed, not every remainder is empty or made of decimal digits only. Ids that differ only by a counter (`x_7`, `x_8`, `x_12`) fail. The check is a floor, not a proof that an id reveals no order: a keyed hash passes it, and so would a counter in another alphabet, which the document forbids all the same.
- `unlike`: a list of JSON pointers relative to the same item. In every item, the value at `field` must not share a form with the value at any of them. Two ids share a form when they have the same prefix (the leading characters up to and including the first `_` or `-`, or nothing when there is neither) and the same length.

## What the world needs from a Backend

- **Observers.** An observer belongs to a fleet, or is an approved public source's. Its `location` is the position its owner shared, or null when none is shared.
- **Receptions.** A reception's `ago_s` places its receipt that many seconds before the case starts. Each reception's `rssi` is unique in the world, so a case tells receptions apart by it, never by comparing one caller's opaque ids with another's.
- **Packets.** Receptions of the same named packet are receptions of one packet. A Backend gives them one `packet_correlation_id` for a given caller.
- **Observer ids.** A Backend gives each observer one `observer_id` per caller (per user, whichever session the user signs in with), different for every caller who may see it. Cases compare one caller's observer ids only with that caller's own, or check that another caller's are absent.
- **Grants.** A user's `observations` is the grant `GET /session` reports as `capabilities.observations`. It is `available` unless the world says otherwise.
- **Actions.** `add-reception` records a reception received now. `age-out-events` moves every cursor issued so far outside retention. `end-session` ends a client's session on the server while the client keeps its cookie.

## What the cases cover

- Every operation without a session.
- Fleet scope: own fleet and approved public sources visible, another fleet's observers and receptions absent.
- A withheld location read as null.
- Correlated receptions and the `provenance` of each.
- Cursors that are no cursor, `Last-Event-ID` winning over the query, and cursors moved out of retention.
- A stream continuing from a snapshot's cursor.
- A session ended on the server.
- A user without the grant: 403 from every operation. A user with the grant and nothing to see: 200 and empty, never 403.
- Observer ids scoped to the caller: two fleets' members get different ids for one public observer; one member's ids agree across the list, the snapshot, the stream and a second session; ids show no counter and do not share a form with a reception's `event_id`, `reception_id` or `packet_correlation_id`.

**Not covered yet:** a stream's `access_revoked` while open, `resync_required`, the heartbeat and freshness states. They need a runner that holds a stream open across an action, or a clock it controls.
