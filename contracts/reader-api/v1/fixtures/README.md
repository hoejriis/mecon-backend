# Reader API v1 fixtures

Synthetic examples for `../openapi.yaml`. Every id, name, token, commit and
timestamp here is made up; none comes from a real Backend, user or device.
`contracts/validate.mjs` checks each fixture against the schema the
OpenAPI document links it from.

`lease-issued.json` and `lease-keys.json` are signed with a TEST-ONLY Ed25519
keypair kept in `../test-only/lease-test-keypair.json`. It was generated for
these fixtures and tests, protects nothing, and must never be trusted by a real
Reader or Backend. `node scripts/gen-lease-fixtures.mjs` regenerates them.
