# Live acceptance suite

Playwright checks against a deployed Reader, for the [MVP1 acceptance matrix](../../docs/MVP1_ACCEPTANCE.md). It is separate from the mock-Backend `e2e/` suite: `npm run e2e` and CI never run it.

## Run

```sh
cd reader
npm ci
npx playwright install chromium
npm run acceptance
```

Bound a run so a hung network cannot linger: `perl -e 'alarm shift; exec @ARGV' 300 npm run acceptance`.

## Environment

| Variable | Meaning |
| --- | --- |
| `ACCEPTANCE_BASE_URL` | Reader to test. The default is set in `acceptance/api.ts`. |
| `ACCEPTANCE_SESSION_A` | Value of the `__Host-mecon_session` cookie of test user A. |
| `ACCEPTANCE_SESSION_B` | The same for test user B. |

Without the two session variables the signed-in suite (`authenticated.spec.ts`) is skipped; `offline.spec.ts` needs only `ACCEPTANCE_SESSION_A`. Use dedicated test users only, never a real person's session.

## What runs

- `public.spec.ts`: read-only GETs and page loads, no sign-in, including the service worker, the signed-out Map and device-chunk boundaries, and the probes. Checks that depend on the Reader API are skipped with the note "API not routed yet" while `/api/reader/v1/health` still answers 404.
- `offline.spec.ts`: the encrypted offline cache with a Backend-issued lease, signed in as test user A with a Chromium virtual WebAuthn authenticator (PRF, over CDP): setup in Settings, `POST /leases` answers 200, offline reload and passkey unlock show the cached conversations and the lease state with no `/api/` response, and a removed credential never unlocks. Skips when messaging is not `available`, when the Chromium has no `hasPrf`, or when user A has no conversation. Sends nothing; clears the origin's site data and signs out at the end, which ends session A, so mint a fresh session and run it alone: `npm run acceptance -- offline.spec.ts`.
- `authenticated.spec.ts`: Settings, device isolation between A and B, Chats lists, mark-read (the only write: the test user's own read mark), the send path with no device connected, Map capability gating, and logout. Logout ends session A, so mint a fresh one for each run. The suite sends no message; send journeys are manual rows in the matrix.

## No secrets in output

- Session values come only from the environment. Never put them in a command line that is logged, a file, an Issue or a pull request.
- The suite never prints them, and its assertions compare counts, not values. Keep it that way when editing.
- `playwright.acceptance.config.ts` turns trace, video and screenshots off so no cookie can reach an artifact. Do not enable them for this project.
- Record results as counts and test names, as described in the matrix.
