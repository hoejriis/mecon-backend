# Session lookup fixtures

Synthetic examples for `../openapi.yaml`. Every id, name, token and origin here is made up (origins and addresses use `.example.test`); none comes from a real core, user or session. `contracts/validate.mjs` checks each fixture against the schema the OpenAPI document links it from, and fails on a fixture nothing references.

Covered: a read and a write lookup request, a Caller with and without `csrf_token`, each Denied reason, `service_unauthorized`, and the `subscribed` and `revocation` feed items.
