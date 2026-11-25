# Reader core fixtures

Synthetic examples for `../openapi.yaml`. Every id, name, token, credential and origin here is made up (origins and addresses use `.example.test`); none comes from a real core, user or session. `contracts/validate.mjs` checks each fixture against the schema the OpenAPI document links it from, and fails on a fixture nothing references.

`health.json`, `login-started.json`, `devices-one.json`, `lease-issued.json` and `lease-keys.json` are copies of the Reader API's fixtures of the same name: the core answers with the Reader API's shapes, which the facade relays unchanged. The lease payload in `lease-issued.json` is decoded and checked against `LeasePayload` and its 7-day bound.

Covered: a caller-only, a page, a login start, a send and an events request; a login poll (pending, approved); a new send attempt and an event batch; and each refusal: `service_unauthorized`, `malformed_request`, `core_unavailable`, `session_ended`, `not_found`, `origin_rejected`, `sending_disabled`, `conflict`, `invalid` (a cursor the core cannot decode for that list, and refused send content), `cursor_expired`, `throttled`, `rate_limited` (login, per client address) and `lease_signing_unavailable`.
