# MVP1 acceptance test matrix

**Version:** v1, dated 2026-11-18. **Scope:** the M1 to M4 gates of [the implementation design](MVP1_IMPLEMENTATION_DESIGN.md#acceptance-criteria) (restricted shell, UX, Map, Messaging, Hardware, Security).

This matrix records what has and has not been checked. A row is **Passed** only when the check ran against the real target on the stated date. A pass against a mock Backend or a simulated Bluetooth device is **Simulated**, never Passed. Nothing here claims verified Android, iOS or live Backend behaviour unless the row says so.

## Evidence status values

| Status | Meaning |
| --- | --- |
| Not run | No evidence yet. Includes checks skipped because their prerequisite is not live. |
| Simulated | Passed against a mock Backend, fixtures or a simulated Web Bluetooth device. Not a real-target result. |
| Passed on DATE | Ran against the real target on DATE and met the criterion. |
| Failed | Ran and did not meet the criterion. |

## Run summary, 2026-11-18

- Unit tests (`cd reader && npm test`): 171 passed of 171. Mock-based, so it supports Simulated rows only.
- Mock-Backend and simulated-BLE e2e (`npm run e2e`): 38 passed of 38. Simulated rows only.
- Live acceptance, unauthenticated part against https://reader.mecon.cloud (`npm run acceptance`), re-run after the Reader API route went live on 2026-11-18: 16 passed, 0 failed, 5 skipped (the signed-in suite: no test sessions yet).
- Live acceptance, signed-in part: not run.

## Matrix

Methods: **Auto** = automated suite, **Manual** = manual (hardware or live account), **Review** = document or code review. Automated paths are under `reader/`; `live` means `acceptance/public.spec.ts` or `acceptance/authenticated.spec.ts`.

### M1: restricted shell

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| M1-01 | `reader.mecon.cloud` is reachable over TLS and serves the shell | Auto | live: "shell answers 200 with security headers" | Passed on 2026-11-18 | HTTP/2 over TLS, 200. |
| M1-02 | Security headers: CSP, nosniff, Referrer-Policy, HSTS | Auto | live: "shell answers 200 with security headers" | Passed on 2026-11-18 | Also frame-ancestors none in the CSP. |
| M1-03 | SPA routes fall back to the shell and revalidate; hashed assets are immutable | Auto | live: "SPA fallback serves the shell at ..." (6 routes), "hashed assets are immutable" | Passed on 2026-11-18 | |
| M1-04 | Served build identifies its commit | Auto | live: "/version.json carries a 40-hex commit" | Passed on 2026-11-18 | Stale-shell repair logic itself: `src/staleShell.test.ts`, Simulated. |
| M1-05 | Non-allowlisted `/api` paths answer 404 | Auto | live: "non-allowlisted /api paths answer 404" | Passed on 2026-11-18 | Checked `/api/admin`, `/api/reader/v2/session`, an unknown v1 path and `/api/`. |
| M1-06 | `GET /api/reader/v1/health` answers 200 `{status, commit}` | Auto | live: "GET /health answers 200" | Passed on 2026-11-18 | Run after the API route went live. |
| M1-07 | `GET /session` signed out answers 401 | Auto | live: "GET /session signed out answers 401" | Passed on 2026-11-18 | Run after the API route went live. |
| M1-08 | Only existing users authenticate; no Reader-side user store, signup or role expansion | Review | Review `src/auth/` and the API contract: no signup operation, identity comes only from the Backend session | Not run | |
| M1-09 | Login through the Backend sign-in flow, request-id polling, session set | Manual | Sign in as a test user on the live host | Not run | Needs the API routed and a test user. Mock flow: `e2e/auth.spec.ts` "login -> signed in -> sign out", `src/test/auth.test.tsx` "walks email -> pending -> approved", both Simulated. |
| M1-10 | Cookie is `__Host-mecon_session`: host-only, no `Domain` | Manual | After a real login, inspect the cookie in browser devtools; the live suite also checks `Domain` on the logout `Set-Cookie` when one is sent | Not run | |
| M1-11 | A Reader session is not accepted on mecon.cloud | Manual | Present the Reader session cookie to the mecon.cloud signed-in surface and confirm it is refused | Not run | Cookie is host-only, so it should never be sent there; the check confirms the server also refuses it. |
| M1-12 | Logout returns 204, then the session is 401 and the login screen shows | Auto | live: "logout answers 204 ..." (signed-in) | Not run | Skipped: no test sessions. Mock: `src/test/auth.test.tsx` "logout sends the CSRF token, then clears everything" and `e2e/auth.spec.ts`, Simulated. |
| M1-13 | Session expiry fails closed | Manual | Let a test session expire, reload, expect the login screen | Not run | Mock: `src/test/auth.test.tsx` "a 401 from any call clears the session and cached data and shows login", Simulated. |
| M1-14 | Server-side revocation: the next Reader call after revocation is 401 and shows login | Manual | Revoke a test user's session elsewhere, then use the Reader | Not run | |
| M1-15 | Cross-origin and CSRF protection on writes | Auto | `src/test/auth.test.tsx` "csrf_failed" group; `src/api/m2client.test.ts` csrf retry cases | Simulated | Server-side enforcement is a Backend check: Not run live. |
| M1-16 | Separate deployment and rollback exist | Review | Review the deployment doc and the image build | Not run | |
| M1-17 | Existing mecon.cloud and MQTT unchanged by the Reader's rollout | Manual | Smoke-test mecon.cloud and an MQTT client before and after | Not run | |
| M1-18 | No production RF action is needed or performed | Review | Review the M1 scope: no send path is reachable without the messaging capability | Not run | |
| M1-19 | No CSP violations on the shell | Auto | live: "signed-out screen renders, passes axe, and raises no CSP violation" | Passed on 2026-11-18 | |

### UX

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| UX-01 | Bottom tabs Chats, Nodes, Map, Tools, Settings at phone, tablet and desktop | Auto | `e2e/tabs.spec.ts` "five tabs at WxH" (3 viewports); `src/components/TabBar.test.tsx` "is a labelled nav landmark with exactly five tabs in order" | Simulated | Mock Backend, signed in. |
| UX-02 | Signed out, only the login form shows (no tab navigation); signed in, the five tabs show | Auto | live: "signed out shows only the login form" (signed out); "Settings shows the signed-in name and every capability" (signed in, also checks the five tabs) | Not run | Signed-out half passed on 2026-11-18; signed-in half skipped: no test sessions. Corrected 2026-11-18: an earlier version expected tabs on the login screen, but access is restricted to signed-in users by design. |
| UX-03 | Login screen has no serious or critical axe violations (live) | Auto | live: "signed-out screen renders, passes axe, and raises no CSP violation" | Passed on 2026-11-18 | Re-run on the real login form after the API route went live: 0 serious or critical. |
| UX-04 | Signed-in screens, light and dark, three viewports, 0 serious or critical axe violations | Auto | `e2e/a11y.spec.ts` "axe + screenshots: SCHEME VIEWPORT"; `e2e/a11y.spec.ts` "axe on the signed-out login screen, both schemes" | Simulated | |
| UX-05 | Keyboard operation: skip link, tab bar arrow keys | Auto | `e2e/a11y.spec.ts` "skip link moves focus to main; tab bar arrow keys move focus"; `src/components/TabBar.test.tsx` "is keyboard operable" | Simulated | |
| UX-06 | MC1-like Chats filters (All, Unread, DMs, Channels); Rooms absent where unsupported | Auto | `src/components/States.test.tsx` "has the four filter chips and no Rooms" | Simulated | |
| UX-07 | Node list and details, Tools and Settings entry points; Settings shows name and capabilities | Auto | `e2e/messaging.spec.ts`; live signed-in: "Settings shows the signed-in name and every capability" | Simulated | Live signed-in part: Not run (no test sessions). |
| UX-08 | Unavailable, forbidden, offline and unknown states are shown as such, never simulated | Auto | `src/components/TabBar.test.tsx` "shows an honest unavailable state for a capability the Backend lacks"; `src/components/States.test.tsx`; `src/test/chats.test.tsx` "makes no messaging request when the capability is unavailable, and says so" | Simulated | |
| UX-09 | Official MeshContinuum brand assets used unmodified | Review | Compare `reader/public/brand/` with the brand source files | Not run | |
| UX-10 | No Fleet or Admin management GUI in the Device User Reader | Auto | `src/components/TabBar.test.tsx` (exactly five tabs) | Simulated | Review of routes also needed: Not run. |
| UX-11 | Stock-user familiarity review against the reference app's flows | Manual | A reviewer who knows the stock app completes: open a chat, find a node, open Settings; record friction | Not run | |
| UX-12 | Contrast and accessible controls on real phone, tablet and desktop | Manual | Walk the five tabs on each device class in light and dark | Not run | Automated axe is a floor, not a replacement. |

### Map

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| MAP-01 | Map shows a safe unavailable state when observations are not available | Auto | `src/components/TabBar.test.tsx` "shows an honest unavailable state ..."; `e2e/tabs.spec.ts` | Simulated | |
| MAP-02 | Live observation source is authorized per user | Manual | With two test users, confirm each sees only permitted observations | Not run | Map feed not implemented yet; depends on the Backend observation contract. |
| MAP-03 | Only real observer locations; no inferred transmitter positions or RF routes | Review | Review the Map code and data mapping | Not run | Map feed not implemented yet. |
| MAP-04 | No private message content in the observation projection | Review | Review the observation contract and a captured sample | Not run | |
| MAP-05 | Freshness, empty, offline and denied states | Auto | To be added with the Map feed | Not run | |

### Messaging

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| MSG-01 | Browse conversations and history with paging | Auto | `src/test/chats.test.tsx` "lists real conversations, filters them, and pages with next_cursor"; `e2e/messaging.spec.ts` "browse, open a channel, send a DM ..." | Simulated | |
| MSG-02 | Authorized direct message sent through the Backend | Manual | See "Manual send journeys" below; needs explicit approval because it transmits over radio | Not run | The live suite sends nothing. |
| MSG-03 | Authorized channel message sent through the Backend | Manual | See "Manual send journeys" below | Not run | |
| MSG-04 | Sender identity: only identities with `can_send` are offered | Auto | `src/test/chats.test.tsx` "offers only identities with can_send, and sends with the chosen one" | Simulated | |
| MSG-05 | Contacts | Manual | To be defined when Contacts is in scope | Not run | Not implemented. |
| MSG-06 | Backend picks the origin automatically; Reader shows no gateway chooser | Manual | Observe a live send and the server-reported origin | Not run | |
| MSG-07 | An attempt is sent at most once; double tap makes one attempt; same request re-posted only with the same key | Auto | `src/test/chats.test.tsx` "double-tapping Send creates one attempt"; `src/api/m2client.test.ts` "sends the Idempotency-Key equal to client_attempt_id ..."; `src/messaging/sendFlow.test.ts` "postAttempt" group | Simulated | |
| MSG-08 | An uncertain outcome is shown as unknown, never as failed, and is not resent automatically | Auto | `src/messaging/attemptStatus.test.ts` "shows unknown as unknown, never as failed ..."; `e2e/messaging.spec.ts` "an ambiguous POST failure shows unknown and posts exactly one attempt id ..." | Simulated | |
| MSG-09 | Retry is a new user action with a new attempt id | Auto | `src/test/chats.test.tsx` "\"Send again\" asks first, then uses a NEW attempt id for the same draft" | Simulated | |
| MSG-10 | Acknowledged means delivered to device, never read | Auto | `src/messaging/attemptStatus.test.ts` "labels acked as delivered to device, never as read"; `src/test/chats.test.tsx` "follows queued -> transmitted -> acked ..." | Simulated | |
| MSG-11 | No unsafe BLE to Backend duplicate | Auto | `src/ble/adapter.test.ts` "link lost mid-send ... no Backend call"; "notification never arrives: ... nothing is resent or sent to the Backend" | Simulated | The BLE path is not wired into Chats yet, so there is no user-facing path choice to verify. |
| MSG-12 | Live updates over SSE resume with the last event id; polling fallback | Auto | `src/api/sse.test.ts` "after two missed heartbeat intervals ... reconnects with Last-Event-ID"; "a 410 drops the cursor ..." | Simulated | Live stream: Not run. |
| MSG-13 | Message text is not kept in web storage | Auto | `src/test/chats.test.tsx` "keeps message text out of web storage" | Simulated | |
| MSG-14 | No cross-user message history | Manual | Two test users; confirm A never sees B's conversations or messages | Not run | See SEC-02. |

#### Manual send journeys (not automated, need explicit approval)

Sends transmit over radio, so the automated suites never send. Before running any of these, get explicit approval for the specific test, use test users and bench radios only, never a public channel, and keep to normal usage rates.

1. Sign in as test user A. Open a direct conversation with a bench contact. Send one short message.
2. Record the displayed status progression (queued, transmitted, acked) and the attempt count in the Backend's own record. Expect exactly one attempt.
3. Repeat on a private test channel with one short message.
4. With the network briefly interrupted after pressing Send, confirm the Reader shows "outcome unknown" and does not resend until the user chooses to.
5. Sign in as test user B and confirm none of A's messages are visible.

### Hardware

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| HW-01 | Bluefy on a real iPhone or iPad: connect, hello, read-only probe against an accepted Companion | Manual | [BLE probe steps](BLE_PROBE.md) | Not run (awaiting tester) | Probe page is live at `/probe/ble`. |
| HW-02 | Bluefy: PIN or permission prompts, reconnect, screen lock and background limits | Manual | [BLE probe steps](BLE_PROBE.md), then lock the screen and reconnect; record each outcome | Not run (awaiting tester) | |
| HW-03 | Bluefy: send and receive over BLE, native outcomes | Manual | To be defined once the BLE path is wired into Chats | Not run (awaiting tester) | |
| HW-04 | Android Chrome BLE, simulated: 12 cases on a Pixel 7 profile with a mock Companion | Auto | `e2e/ble.spec.ts` ("Android Chrome profile", 12 cases) | Simulated (not hardware verified) | Android hardware compatibility is not claimed. |
| HW-05 | Android hardware: physical device, background, lock and reconnect | Manual | Run the probe steps on an Android phone with Chrome | Not run | No Android device available. |
| HW-06 | Probe is read-only: only the two hello commands can be written | Auto | `src/ble/probe/probeCore.test.ts` "refuses every non-allowlisted frame before the transport sees it"; "a full probe run writes only allowlisted codes and causes no RF" | Simulated | |
| HW-07 | Probe page is reachable without sign-in on the live host and renders | Auto | live: "/probe/ble renders without sign-in" | Passed on 2026-11-18 | Renders only; no Bluetooth device was used. |
| HW-08 | Main entry chunk has no BLE UUID or `requestDevice` on the live host | Auto | live: "main entry chunk has no BLE UUID and no requestDevice" | Passed on 2026-11-18 | Build-side check: `e2e/ble-prod.spec.ts`, Simulated. |
| HW-09 | Desktop Chromium: real Companion over Web Bluetooth | Manual | Run the probe steps on desktop Chromium | Not run | |
| HW-10 | Unsupported browser shows an explicit fallback and Backend-only use remains | Auto | `e2e/ble.spec.ts` "unsupported browser shows an explicit unsupported state ..."; `e2e/ble-probe.spec.ts` "browser without Web Bluetooth: unsupported, nothing crashes" | Simulated | |
| HW-11 | BLE protocol encoders and decoders match the firmware's documented frames | Auto | `src/ble/protocol.test.ts` (fixture groups) | Simulated | Fixtures follow the firmware maintainers' written answers, not captured traffic from real hardware. |

### Security

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | `/devices` for A never includes B's devices, and the reverse | Auto | live: "/devices of A never includes a device of B, and the reverse" | Not run | Skipped: no test sessions. |
| SEC-02 | Cross-user message isolation | Manual | Two test users; compare conversation ids and message ids visible to each, count only | Not run | |
| SEC-03 | Fleet owner and instance admin roles do not read another user's private messages | Manual | Sign in as a fleet owner test user; confirm another user's messages are not shown | Not run | |
| SEC-04 | Revocation and expiry fail closed | Manual | See M1-13 and M1-14 | Not run | |
| SEC-05 | The Reader never stores or exports MeshCore private keys | Auto | `src/ble/adapter.test.ts` "persists nothing: no localStorage, sessionStorage or IndexedDB use across a full session"; `src/ble/probe/probeCore.test.ts` "removes keys, names, ids, coordinates and PINs and keeps presence and lengths" | Simulated | Code review of key handling also needed: Not run. |
| SEC-06 | Strict CSP: no inline script or style | Auto | live: "shell answers 200 with security headers" and the CSP console check | Passed on 2026-11-18 | |
| SEC-07 | Source and provenance integrity of observations | Review | Review the observation contract and its signature or provenance fields | Not run | Map feed not implemented yet. |
| SEC-08 | Security-sensitive tests fail when the logic is broken | Review | Re-run the break-the-code check for send safety, CSRF, the probe allowlist | Not run | Earlier mutation results are reported in the Issues; they are not re-run here. |
| SEC-09 | No secrets, personal data or real device identifiers in the repository or evidence | Review | Scan the repository and the evidence reports before publishing | Not run | |

## How evidence is recorded

- Each run produces a short report: the matrix version, run date, Reader commit (from `/version.json`), the list of rows run with their status, and the exact pass, fail and skip counts.
- Reports contain no personal data: no email addresses, display names, session values, device ids, node keys, contact names, coordinates or message text. Use counts and synthetic labels (user A, user B).
- Automated live runs print only test names and results. The signed-in suite takes session values from the environment, never prints them, and disables trace, video and screenshots.
- BLE probe reports are pasted as comments on the hardware Issue in the form the probe's "Copy report" button produces, which sanitizes keys, names, ids, coordinates and PINs.
- A row changes from Not run only when evidence exists. When a prerequisite is missing the row stays Not run and the note says what is missing.

## Go / no-go

**Current state: no-go for any claim beyond the restricted shell.** The static shell, headers and BLE-free entry chunk pass live. The Backend API is not yet reachable through the Reader host, so login, sessions, isolation, messaging and Map are Not run live. Android Bluetooth is simulated only, and Bluefy on iPhone or iPad has not been run.

MVP1 acceptance is complete only when every row above is Passed or has a recorded, accepted limitation. **Public beta needs separate owner approval** and is not implied by this matrix, by a green run, or by completing MVP1 acceptance.
