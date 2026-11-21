# Reader API v1 conformance cases

Replayable cases for `../openapi.yaml`. A Backend that claims to serve the Reader API replays every case and passes each one. Every name, address, key prefix and id here is made up.

`contracts/validate.mjs` checks the cases against the document, so a case cannot expect a status, schema or header the document does not declare. Every operation has at least one case. The replay itself belongs to each implementation's own test suite.

## Files

- `cases.schema.json`: the shape of a case file.
- `worlds.json`: the precondition worlds the cases start from (users, fleets, devices, identities, contacts, channels, messages, switches), and the runner actions a case may take.
- `session.json`, `devices.json`, `messaging.json`, `send.json`, `events.json`, `leases.json`: one file of cases per group.

## Replaying a case

1. **World.** Build the case's `world` from `worlds.json` in a fresh state, with both switches on. Map each symbolic name to whatever the implementation stores. Ids are the implementation's own: cases never assume one, and read them from responses instead.
2. **Clients.** `as` names a client: a cookie jar that persists for the whole case. A step without `as` uses a fresh anonymous client. The `sign-in` action gives a client a session by the implementation's own means, since the magic link is out of band.
3. **Requests.** Send the `operation` with its `path`, `query`, `headers` and `body`. `${name}` is replaced by an earlier capture: a whole-string value becomes the captured JSON value; inside a path it is the string.
   - **Origin.** `same` sends the Reader's own origin, `foreign` a different one, and `absent` none.
   - **CSRF.** On operations with an `X-CSRF-Token` parameter, `valid` sends the client's token from `GET /session`, `wrong` a different string of the same length, and `absent` none. A client without a session sends none.
4. **Expectations.**
   - `status` must equal.
   - The body must validate against the component `schema` (none for `null`).
   - Each `headers` entry is `present`, `absent` or an exact value; names are case-insensitive.
   - Each `body` pointer must equal its value.
   - Each `match` counts the items of the array at `at` whose pointers all equal the `where` values, and needs `count` exactly or `at_least`.
5. **Streams.** For an event stream, read the frames the Backend holds for that cursor and stop once caught up (at the first heartbeat, or after a short bound). Every `data:` frame must validate against `schema`, and `stream.match` counts frames (`at: ""`).
6. **Leases.**
   - `lease` decodes `token`, finds its `key_id` in `keys` (a pointer into this response or a capture), and verifies the Ed25519 signature as `LeaseToken` describes.
   - It checks `user_id`, that the lifetime is at most `max_lifetime_s`, and that every identity's operations include or exclude the listed ones.
7. **Captures.** `capture` stores a value from the response for later steps: a JSON pointer, or `{at, where, field}` for the first matching array item. A capturing action (`events-checkpoint`) stores its result under its `capture` name.

A case fails at its first unmet expectation. Order within a case matters; cases are independent of each other.

## Adding a case

Each case needs a new id within its group (`<group>-NN`). A request that deliberately breaks the request schema sets `invalid: true` and expects 422; the validator checks that the body really fails. An implementation's runner maps new actions or worlds, so add those sparingly and describe them in `worlds.json`.
