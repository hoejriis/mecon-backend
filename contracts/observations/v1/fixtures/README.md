# Live observation API (authorized projection) fixtures

Synthetic examples for `../openapi.yaml`. Every id, label, coordinate and
timestamp here is made up; none comes from a real Backend, observer, user or
place. `contracts/validate.mjs` checks each fixture against the schema the
OpenAPI document links it from, and fails on a fixture nothing references.

Covered states: empty, single observer, multi-observer correlated receptions,
location withheld, delayed and duplicate delivery, the 401, 403 and
`410 cursor_expired` error bodies, and the `access_revoked` and
`resync_required` stream events.
