# Anonymous public map feed fixtures

Synthetic examples for `../openapi.yaml`. Every key, name, coordinate, id and timestamp here is made up; none comes from a real Backend, node or place. `contracts/validate.mjs` checks each fixture against the schema the OpenAPI document links it from and fails on a fixture nothing references; `contracts/validate-public-map.mjs` checks that none carries a field the feed never publishes.

- `nodes.json`, `nodes-empty.json`: the catalogue, with and without nodes (one without an advertised name, one never heard through an eligible source recently).
- `events.json`, `events-empty.json`: an advert pulse with one line, a relay pulse with none, a withdrawal; an empty window.
- `error-404-feed-off.json`, `error-410-cursor-expired.json`, `error-429-throttled.json`: the standard error body for the off switch, a cursor that is old, unknown or forged, and the rate limit.
