# Session lookup v1 conformance cases

Replayable cases for `../openapi.yaml`. A core that claims to serve it replays every case and passes each one; a facade replays them against its fake or real core. Every name, origin and id here is made up.

The format and the replay rules are the Reader API's, in [`../../../reader-api/v1/cases/README.md`](../../../reader-api/v1/cases/README.md): worlds, requests, expectations, streams and captures work the same way. `contracts/validate.mjs` checks these cases against this document as it checks the Reader API's.

## Differences from the Reader API's format

- There are no clients and no cookie jars. A session's credential is captured from the `issue-session` action and put in the request body as `${cookie}`; no case assumes a credential or an id.
- A request has no `origin` or `csrf` field. Origin, `sec_fetch_site` and `csrf_token` are body fields of the lookup, written out in each case. `csrf-for` captures the token the core derives for a session.
- `service_token` on a request is `valid` (default: the deployment's token), `absent` (no `Authorization` header) or `wrong` (a different string).
- A stream read is bounded as in the other cases: read what the core sends first (`subscribed`), then stop.

## Files

- `cases.schema.json`: the shape of a case file.
- `worlds.json`: the `basic` world (one allow-listed origin, an instance admin and a user) and the runner actions.
- `lookup.json`: the cases.

## What the cases cover

- A live session gives a Caller with exactly the documented fields (the schema allows no others, so no resource scope) and the expected role.
- `expired`, `revoked` and `unknown`.
- A write without a CSRF token and with a wrong one gives `csrf_failed`.
- Origin: the allow-listed origin with and without a trailing slash; same-origin with an absent or foreign Origin; refusals for a foreign origin and for no origin with `cross-site` or no `sec_fetch_site`; reads and streams are not subject to the rule.
- A missing or wrong service token gives 401 `service_unauthorized`, on `/lookup` and on `/revocations`.
- `core_unavailable` while the core cannot answer, and recovery.
- A revocations subscription starts with `subscribed`, every time.

## Not replayable yet

The runner reads a stream until it is caught up and has no clock it controls, so these behaviours are proved by each implementation's own tests, not by these cases:

- **Cache timing:** a Caller cached for at most 5 s, never past `expires_at`, never across a revocation item for its `session_ref`, and only while the feed has said `subscribed` (nothing cached before it or after the feed ends).
- **Stream close on revocation:** a revocation item for a session holding an open stream makes the facade send that API's frame (`session_revoked` on the Reader API, `access_revoked` on the observations API) and close the stream.
- **Feed down:** the facade closes every open stream after its bound, and every reconnect looks the session up again.
- **Facade mapping of Denied reasons:** the browser status and cookie handling in the table of `../openapi.yaml`, including `core_unavailable` for a core timeout, a malformed answer or a refused service token, are the facade's tests.
- **Login start's Origin check:** done by the core in its own login-start call, not through `/lookup`, so no case here covers it.
