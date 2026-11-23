# MVP1 acceptance test matrix

**Version:** v2, dated 2026-11-19. **Scope:** the M1 to M4 gates of [the implementation design](MVP1_IMPLEMENTATION_DESIGN.md#acceptance-criteria) (restricted shell, UX, Map, Messaging, Hardware, Security), plus what has shipped since v1: safe updates, the offline cache, the send path, device mapping, the Map, device detection and the Connector.

This matrix records what has and has not been checked. A row is **Passed** only when the check ran against the real target on the stated date. A pass against a mock Backend or a simulated Bluetooth device is **Simulated**, never Passed. Nothing here claims verified Android, iOS or live Backend behaviour unless the row says so.

## Evidence status values

| Status | Meaning |
| --- | --- |
| Not run | No evidence yet. Includes checks skipped because their prerequisite is not live. |
| Simulated | Passed against a mock Backend, fixtures or a simulated Web Bluetooth device. Not a real-target result. |
| Passed on DATE | Ran against the real target on DATE and met the criterion. |
| Failed | Ran and did not meet the criterion. |

## Run summary, 2026-11-19

Reader build under test: commit `b3f63c54c7888b99ecb48983d7a8e9fd7867cf80`, as `/version.json` reported on the live host at the time of both live runs.

- Unit tests (`cd reader && npm test`): 612 passed of 612 (47 files). Mock-based, so they support Simulated rows only.
- Mock-Backend and simulated-device e2e (`npm run e2e`): 114 passed of 114 in CI for the same commit; not re-run locally for this matrix. Simulated rows only.
- Live acceptance, unauthenticated part against https://reader.mecon.cloud (`npm run acceptance`): **24 passed, 0 failed, 9 skipped.** The 9 skipped are the signed-in suite (no test sessions yet). An earlier run the same day had 23 passed and 1 failed: the new service-worker registration check read the worker while it was still activating. That was a flaw in the check, not in the host; it now waits for the activated state.
- Live acceptance, signed-in part, with two test users (Backend releases of the same day): **33 passed, 0 failed, 1 skipped.** The skipped one is the cross-site check, a manual row. The run needed one readable conversation, so a bench Companion was assigned to a test user for the run with sending off, then unassigned. The live offline-cache test (passkey, Backend lease, offline unlock, removed credential) passed 1 of 1 in the same window.
- Live send, two bounded attempts with explicit owner approval, one direct message each between bench radios. The first was refused by the device as a replay (a Backend sequence lag, since fixed). The second was queued, transmitted and received by the recipient; the sender heard no ACK, so the Reader showed it truthfully as timed out.
- Connector tests, contract validation and the Connector mutation check: not re-run for this matrix.

## Matrix

Methods: **Auto** = automated suite, **Manual** = manual (hardware or live account), **Review** = document or code review. Automated paths are under `reader/`; `live` means `acceptance/public.spec.ts` or `acceptance/authenticated.spec.ts`.

### M1: restricted shell

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| M1-01 | `reader.mecon.cloud` is reachable over TLS and serves the shell | Auto | live: "shell answers 200 with security headers" | Passed on 2026-11-19 | HTTP/2 over TLS, 200. |
| M1-02 | Security headers: CSP, nosniff, Referrer-Policy, HSTS | Auto | live: "shell answers 200 with security headers" | Passed on 2026-11-19 | Also frame-ancestors none in the CSP. |
| M1-03 | SPA routes fall back to the shell and revalidate; hashed assets are immutable | Auto | live: "SPA fallback serves the shell at ..." (6 routes), "hashed assets are immutable" | Passed on 2026-11-19 |  |
| M1-04 | Served build identifies its commit | Auto | live: "/version.json carries a 40-hex commit" | Passed on 2026-11-19 | Stale-shell repair logic itself: `src/staleShell.test.ts`, Simulated. |
| M1-05 | Non-allowlisted `/api` paths answer 404 | Auto | live: "non-allowlisted /api paths answer 404" | Passed on 2026-11-19 | Checked `/api/admin`, `/api/reader/v2/session`, an unknown v1 path and `/api/`. |
| M1-06 | `GET /api/reader/v1/health` answers 200 `{status, commit}` | Auto | live: "GET /health answers 200" | Passed on 2026-11-19 | Against the build at commit `b3f63c5`. |
| M1-07 | `GET /session` signed out answers 401 | Auto | live: "GET /session signed out answers 401" | Passed on 2026-11-19 | Against the build at commit `b3f63c5`. |
| M1-08 | Only existing users authenticate; no Reader-side user store, signup or role expansion | Review | Review `src/auth/` and the API contract: no signup operation, identity comes only from the Backend session | Passed on 2026-11-23 | Review of `reader/src/auth/` and the OpenAPI contract: 18 paths, none a signup, invite or role operation; identity comes only from `GET /session`; `POST /login` answers the same for an unknown address. That the Backend refuses an unknown address is Backend behaviour, outside this repository. |
| M1-09 | Login through the Backend sign-in flow, request-id polling, session set | Manual | Sign in as a test user on the live host | Not run | Needs the API routed and a test user. Mock flow: `e2e/auth.spec.ts` "login -> signed in -> sign out", `src/test/auth.test.tsx` "walks email -> pending -> approved", both Simulated. |
| M1-10 | Cookie is `__Host-mecon_session`: host-only, no `Domain` | Manual | After a real login, inspect the cookie in browser devtools; the live suite also checks `Domain` on the logout `Set-Cookie` when one is sent | Passed on 2026-11-19 | Live: the test-user cookie is host-only on reader.mecon.cloud, and the logout `Set-Cookie` carries no `Domain`. |
| M1-11 | A Reader session is not accepted on mecon.cloud | Manual | Present the Reader session cookie to the mecon.cloud signed-in surface and confirm it is refused | Passed on 2026-11-19 | Live: the test-user session cookie was refused on mecon.cloud (independent check). Cookie is host-only, so it should never be sent there; the check confirms the server also refuses it. |
| M1-12 | Logout returns 204, then the session is 401 and the login screen shows | Auto | live: "logout answers 204 ..." (signed-in) | Passed on 2026-11-19 | Live signed-in: logout 204, cookie clear without `Domain`, then `/session` 401. |
| M1-13 | Session expiry fails closed | Manual | Let a test session expire, reload, expect the login screen | Not run | Mock: `src/test/auth.test.tsx` "a 401 from any call clears the session and cached data and shows login", Simulated. |
| M1-14 | Server-side revocation: the next Reader call after revocation is 401 and shows login | Manual | Revoke a test user's session elsewhere, then use the Reader | Not run | |
| M1-15 | Cross-origin and CSRF protection on writes | Auto | `src/test/auth.test.tsx` "csrf_failed" group; `src/api/m2client.test.ts` csrf retry cases | Simulated | Server-side enforcement is a Backend check: Not run live. |
| M1-16 | Separate deployment and rollback exist | Review | Review the deployment doc and the image build | Passed on 2026-11-23 | Separate deployment: the Reader's own image (`reader/Dockerfile`) and a tagged release tarball with its checksum (`release.yml`). Rollback: the policy in `docs/DEVELOPMENT.md` ("Version compatibility and rollback policy": the host points back at an earlier release directory) and the client side in `reader/e2e/rollback.spec.ts`, with a kill switch. A rollback on the real host has not been exercised. |
| M1-17 | Existing mecon.cloud and MQTT unchanged by the Reader's rollout | Manual | Smoke-test mecon.cloud and an MQTT client before and after | Not run | |
| M1-18 | No production RF action is needed or performed | Review | Review the M1 scope: no send path is reachable without the messaging capability | Passed on 2026-11-23 | The Backend send path throws `CapabilityError` unless `messaging` and `send` are available (`reader/src/api/client.ts`, `need`), and `MessagingContext` refuses both send and send-again otherwise. Local Bluetooth or USB sending is gated on the device, identity ownership, the destination mapping and the offline guard, and needs `messaging` for identities and contacts, but not `send`. Development pages are built only in development mode. Real sends were made only with the owner's explicit approval (MSG-02). |
| M1-19 | No CSP violations on the shell | Auto | live: "signed-out screen renders, passes axe, and raises no CSP violation" | Passed on 2026-11-19 |  |

### UX

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| UX-01 | Bottom tabs Chats, Nodes, Map, Tools, Settings at phone, tablet and desktop | Auto | `e2e/tabs.spec.ts` "five tabs at WxH" (3 viewports); `src/components/TabBar.test.tsx` "is a labelled nav landmark with exactly five tabs in order" | Simulated | Mock Backend, signed in. |
| UX-02 | Signed out, only the login form shows (no tab navigation); signed in, the five tabs show | Auto | live: "signed out shows only the login form" (signed out); "Settings shows the signed-in name and every capability" (signed in, also checks the five tabs) | Passed on 2026-11-19 | Both halves pass live: signed out shows the login form only; signed in shows exactly the five tabs. Signed-out half passed on 2026-11-19; signed-in half skipped: no test sessions. Access is restricted to signed-in users by design, so the login screen shows no tabs. |
| UX-03 | Login screen has no serious or critical axe violations (live) | Auto | live: "signed-out screen renders, passes axe, and raises no CSP violation" | Passed on 2026-11-19 | Re-run on the real login form after the API route went live: 0 serious or critical. |
| UX-04 | Signed-in screens, light and dark, three viewports, 0 serious or critical axe violations | Auto | `e2e/a11y.spec.ts` "axe + screenshots: SCHEME VIEWPORT"; `e2e/a11y.spec.ts` "axe on the signed-out login screen, both schemes" | Simulated | |
| UX-05 | Keyboard operation: skip link, tab bar arrow keys | Auto | `e2e/a11y.spec.ts` "skip link moves focus to main; tab bar arrow keys move focus"; `src/components/TabBar.test.tsx` "is keyboard operable" | Simulated | |
| UX-06 | MC1-like Chats filters (All, Unread, DMs, Channels); Rooms absent where unsupported | Auto | `src/components/States.test.tsx` "has the four filter chips and no Rooms" | Simulated | |
| UX-07 | Node list and details, Tools and Settings entry points; Settings shows name and capabilities | Auto | `e2e/messaging.spec.ts`; live signed-in: "Settings shows the signed-in name and every capability" | Passed on 2026-11-19 | Live signed-in: Settings shows the name and every capability. |
| UX-08 | Unavailable, forbidden, offline and unknown states are shown as such, never simulated | Auto | `src/components/TabBar.test.tsx` "shows an honest unavailable state for a capability the Backend lacks"; `src/components/States.test.tsx`; `src/test/chats.test.tsx` "makes no messaging request when the capability is unavailable, and says so" | Simulated | |
| UX-09 | Official MeshContinuum brand assets used unmodified | Review | Compare `reader/public/brand/` with the brand source files | Passed on 2026-11-23 | All 4 files in `reader/public/brand/` match the MeshContinuum brand sources by sha256 (compared with that repository's current `main`), and are used unmodified in `Header.tsx` and `index.html`. |
| UX-10 | No Fleet or Admin management GUI in the Device User Reader | Auto | `src/components/TabBar.test.tsx` (exactly five tabs) | Simulated | Review of routes also needed: Not run. |
| UX-11 | Stock-user familiarity review against the reference app's flows | Manual | A reviewer who knows the stock app completes: open a chat, find a node, open Settings; record friction | Not run | |
| UX-12 | Contrast and accessible controls on real phone, tablet and desktop | Manual | Walk the five tabs on each device class in light and dark | Not run | Automated floor passes live: five signed-in tabs in light and dark at 390 and 1280 px, 20 screens, no serious or critical axe violation and no CSP violation. Real devices not yet walked. Automated axe is a floor, not a replacement. |

### Map

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| MAP-01 | Map shows a safe unavailable state when observations are not available | Auto | `src/map/map.test.tsx` "makes no observation request while observations is ..." and "does not call the API client at all while unavailable"; `e2e/observations.spec.ts` "keeps an honest unavailable state and makes no observation request"; `src/components/TabBar.test.tsx` | Simulated | Mock Backend, signed in. Signed-out reachability is MAP-06. |
| MAP-02 | Live observation source is authorized per user | Manual | With two test users, confirm each sees only permitted observations | Not run | Live as one test user: `scope=self` only; 241 observers, 150 of the first 200 located at 111 m; no transmitter, route, hash or content fields. The two-user comparison is still to run live. Needs the Backend observation release: until it ships, `capabilities.observations` is unavailable and the Map says so. Two test users also needed. |
| MAP-03 | Only real observer locations; no inferred transmitter positions or RF routes | Auto | `src/map/map.test.tsx` "never draws a line, path or polygon, even for correlated receptions by several observers" and "draws a pin only for observers with a location ..."; `e2e/observations.spec.ts` "multi-observer fixture draws three pins and no connecting geometry" | Simulated | The Map is plain SVG circles and text, no tiles. A code review of the data mapping is still Not run. |
| MAP-04 | No private message content in the observation projection | Auto | `contracts` `npm test`: the observation validator fails on any route, path, hop, hash, payload, content, text, transmitter or raw key in the schemas and fixtures | Simulated | Synthetic fixtures only. A captured real sample: Not run (no live observation API). |
| MAP-05 | Freshness, empty, offline and denied states | Auto | `src/map/map.test.tsx` (freshness text, empty, error with retry, revoked, resume after a dropped stream, 410 and resync); `e2e/observations.spec.ts` "access_revoked ends the view and clears what it held" | Simulated | Offline state comes from the shared state components. |
| MAP-06 | Signed out, the Map is not reachable: login form only, no tab navigation, no map canvas, no observation request | Auto | live: "signed-out /map shows no Map, no tab navigation and makes no observation request" | Passed on 2026-11-19 | Read-only GETs; `/api/observations/` was never requested. |
| MAP-07 | Pins only for observers whose location may be shown; every observer is in the list | Auto | `src/map/map.test.tsx` "draws a pin only for observers with a location; the list shows all, marking the rest" and "with no located observer draws no canvas at all, only the list"; `e2e/observations.spec.ts` "pins only for located observers, the list for all, and a live highlight" | Simulated |  |
| MAP-08 | Signed in, the Map respects the capability: unavailable or forbidden shows that state with no observation call; available sends only `scope=self` requests and draws no route geometry | Auto | live: "Map capability gating ..." (signed-in) | Passed on 2026-11-19 | Live signed-in with observations available: only `scope=self` requests, located observers drawn as pins, no route geometry. |
| MAP-09 | Live stream: resume with the last event id; revocation drops everything held | Auto | `src/map/map.test.tsx` "resumes with Last-Event-ID after the stream drops", "on access_revoked drops everything it holds, does not reconnect and re-reads the session" | Simulated | Live stream: Not run. |

### Messaging

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| MSG-01 | Browse conversations and history with paging | Auto | `src/test/chats.test.tsx` "lists real conversations, filters them, and pages with next_cursor"; `e2e/messaging.spec.ts` "browse, open a channel, send a DM ..." | Simulated | |
| MSG-02 | Authorized direct message sent through the Backend | Manual | See "Manual send journeys" below; needs explicit approval because it transmits over radio | Passed on 2026-11-19 | One bounded direct message with explicit owner approval, from a bench Companion to a bench contact: queued, transmitted (one transmission), then timed out with no ACK heard by the sender. The recipient's queue holds the message, so it was received. An `acked` outcome has not yet been seen live. The live suite sends nothing. |
| MSG-03 | Authorized channel message sent through the Backend | Manual | See "Manual send journeys" below | Not run | |
| MSG-04 | Sender identity: only identities with `can_send` are offered | Auto | `src/test/chats.test.tsx` "offers only identities with can_send, and sends with the chosen one" | Simulated | |
| MSG-05 | Contacts | Manual | To be defined when Contacts is in scope | Not run | Not implemented. |
| MSG-06 | Backend picks the origin automatically; Reader shows no gateway chooser | Manual | Observe a live send and the server-reported origin | Not run | |
| MSG-07 | An attempt is sent at most once; double tap makes one attempt; same request re-posted only with the same key | Auto | `src/test/chats.test.tsx` "double-tapping Send creates one attempt"; `src/api/m2client.test.ts` "sends the Idempotency-Key equal to client_attempt_id ..."; `src/messaging/sendFlow.test.ts` "postAttempt" group | Simulated | |
| MSG-08 | An uncertain outcome is shown as unknown, never as failed, and is not resent automatically | Auto | `src/messaging/attemptStatus.test.ts` "shows unknown as unknown, never as failed ..."; `e2e/messaging.spec.ts` "an ambiguous POST failure shows unknown and posts exactly one attempt id ..." | Simulated | |
| MSG-09 | Retry is a new user action with a new attempt id | Auto | `src/test/chats.test.tsx` "\"Send again\" asks first, then uses a NEW attempt id for the same draft" | Simulated | |
| MSG-10 | Acknowledged means delivered to device, never read | Auto | `src/messaging/attemptStatus.test.ts` "labels acked as delivered to device, never as read"; `src/test/chats.test.tsx` "follows queued -> transmitted -> acked ..." | Simulated | |
| MSG-11 | No unsafe BLE to Backend duplicate | Auto | `src/ble/adapter.test.ts` "link lost mid-send ... no Backend call"; "notification never arrives: ... nothing is resent or sent to the Backend" | Simulated | Superseded in the user-facing path by SND-01 to SND-06: the path choice is now wired into Chats. These adapter tests still stand. |
| MSG-12 | Live updates over SSE resume with the last event id; polling fallback | Auto | `src/api/sse.test.ts` "after two missed heartbeat intervals ... reconnects with Last-Event-ID"; "a 410 drops the cursor ..." | Simulated | Live stream: Not run. |
| MSG-13 | Message text is not kept in web storage | Auto | `src/test/chats.test.tsx` "keeps message text out of web storage" | Simulated | |
| MSG-14 | No cross-user message history | Manual | Two test users; confirm A never sees B's conversations or messages | Not run | See SEC-02. |
| MSG-15 | Opening a conversation with unread messages marks it read up to the newest message; repeating is a no-op; the write needs the CSRF token | Auto | `src/test/chats.test.tsx` (mark-read cases); live signed-in: "mark-read: a conversation with unread messages goes to zero, and a repeat is a no-op" | Passed on 2026-11-19 | Live signed-in with one readable bench conversation: unread goes to zero, a repeat is a no-op, the write without CSRF is refused. |
| MSG-16 | Chats lists real conversations with the contract fields; four filters, no Rooms | Auto | live signed-in: "Chats lists: ..."; mock: see MSG-01 and UX-06 | Passed on 2026-11-19 | Live signed-in: contract fields, four filters, no Rooms. |

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
| HW-01 | Bluefy on a real iPhone or iPad: connect, hello, read-only probe against an accepted Companion | Manual | [BLE probe steps](BLE_PROBE.md) | Not run (awaiting tester) | Probe page is live at `/probe/ble` (HW-07). Detection now uses the role-agnostic device layer (HW-13). |
| HW-02 | Bluefy: PIN or permission prompts, reconnect, screen lock and background limits | Manual | [BLE probe steps](BLE_PROBE.md), then lock the screen and reconnect; record each outcome | Not run (awaiting tester) | |
| HW-03 | Bluefy: send and receive over BLE, native outcomes | Manual | `e2e/local-send.spec.ts` (simulated device); real hardware: see SND-06 | Not run (awaiting tester) | Simulated coverage is in the SND rows. No real-hardware send has been run. |
| HW-04 | Android Chrome BLE, simulated: 12 cases on a Pixel 7 profile with a mock Companion | Auto | `e2e/ble.spec.ts` ("Android Chrome profile", 12 cases) | Simulated (not hardware verified) | Android hardware compatibility is not claimed. |
| HW-05 | Android hardware: physical device, background, lock and reconnect | Manual | Run the probe steps on an Android phone with Chrome | Not run | No Android device available. |
| HW-06 | Probe is read-only: only the two hello commands can be written | Auto | `src/ble/probe/probeCore.test.ts` "refuses every non-allowlisted frame before the transport sees it"; "a full probe run writes only allowlisted codes and causes no RF" | Simulated | |
| HW-07 | Probe page is reachable without sign-in on the live host and renders | Auto | live: "/probe/ble renders without sign-in" | Passed on 2026-11-19 | Renders only; no Bluetooth device was used. |
| HW-08 | Main entry chunk has no BLE UUID or `requestDevice` on the live host | Auto | live: "main entry chunk has no BLE UUID and no requestDevice" | Passed on 2026-11-19 | Build-side check: `e2e/ble-prod.spec.ts`, Simulated. |
| HW-09 | Desktop Chromium: real Companion over Web Bluetooth | Manual | Run the probe steps on desktop Chromium | Not run | |
| HW-10 | Unsupported browser shows an explicit fallback and Backend-only use remains | Auto | `e2e/ble.spec.ts` "unsupported browser shows an explicit unsupported state ..."; `e2e/ble-probe.spec.ts` "browser without Web Bluetooth: unsupported, nothing crashes" | Simulated | |
| HW-11 | BLE protocol encoders and decoders match the firmware's documented frames | Auto | `src/ble/protocol.test.ts` (fixture groups) | Simulated | Fixtures follow the firmware maintainers' written answers, not captured traffic from real hardware. |
| HW-12 | USB: the device is detected through the MECON device-interface hello; role, firmware and capabilities come only from the device's answers, never its name | Auto | `src/device/detect.test.ts`; `e2e/usb.spec.ts` ("MECON Companion: connect, identify, hello and contacts ...", "MECON Repeater: identified by hello ...", "a board named Repeater that answers nothing recognisable is not called a Repeater") | Simulated (not hardware verified) | Fake Web Serial. No real device was connected. |
| HW-13 | BLE: same detection; link trust is unknown for BLE and non-read operations are never requested on an unknown link; a default-PIN link is shown as untrusted | Auto | `src/device/trust.test.ts`; `src/device/bleSession.test.ts`; `e2e/ble-device.spec.ts` | Simulated (not hardware verified) | Real iPhone, iPad and Android: Not run (see HW-01, HW-05). |
| HW-14 | USB probe is read-only: shared allowlist, console hello retried before any binary frame, report sanitized | Auto | `e2e/usb-probe.spec.ts` (8 cases); `src/device/probe/usbProbeCore.test.ts`; `src/device/guard.test.ts` | Simulated (not hardware verified) |  |
| HW-15 | `/probe/usb` is reachable without sign-in on the live host and renders | Auto | live: "/probe/usb renders its read-only page, with no CSP violation"; "/probe/ble and /probe/usb answer 200 as the HTML shell" | Passed on 2026-11-19 | Renders only; no serial device was used. |
| HW-16 | USB probe on a real device in desktop Chromium (Companion, Repeater, Room server, a board that resets on open) | Manual | Run the USB probe steps in [USB_PROBE.md](USB_PROBE.md) and paste the sanitized report | Not run (awaiting tester) |  |
| HW-17 | Device lazy chunks (probes, detection, transports) are not requested on the signed-out shell, `/map` or `/chats`, and the entry chunk has no `requestPort` | Auto | live: "device lazy chunks are not loaded on the signed-out shell or the signed-out /map"; "the entry chunk has no Web Serial port request either" | Passed on 2026-11-19 | Together with HW-08 for `requestDevice`. |

### Safe updates and rollback

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| UPD-01 | The service worker registers from `/sw.js` at scope `/` and reaches the activated state | Auto | live: "the worker registers at scope / from /sw.js and reaches the activated state" | Passed on 2026-11-19 | Fresh browser context. |
| UPD-02 | `/sw.js` is same-origin JavaScript and always revalidated | Auto | live: "/sw.js is served same-origin as JavaScript and always revalidated" | Passed on 2026-11-19 |  |
| UPD-03 | The worker controls the page, caches under the served commit, never caches `/api`, and serves the shell offline | Auto | live: "the worker controls the page, caches the served commit, never caches /api, and serves the shell offline" | Passed on 2026-11-19 |  |
| UPD-04 | A new version waits: banner, no automatic activation; with a draft or an uncertain attempt a confirmation says what would be lost; nothing is sent by an update | Auto | `e2e/updates.spec.ts` ("a new version waits ...", "with a draft, activation needs an explicit confirmation ...", "an in-flight send attempt also needs confirmation, and is never resent by the update"); `src/update/*.test.ts` | Simulated |  |
| UPD-05 | Two tabs: updating in one tells the other, which keeps its draft and does not reload | Auto | `e2e/updates.spec.ts` "two tabs: ..." | Simulated |  |
| UPD-06 | Stale-shell repair runs by itself only when nothing is at risk, otherwise it asks | Auto | `src/staleShell.test.ts`; `src/update/guards.test.ts` | Simulated |  |
| UPD-07 | Rollback: to a build without a worker, to a build before `/version.json`, and with the operator kill-switch worker, the page recovers; a Backend outage recovers by itself | Auto | `e2e/rollback.spec.ts` (7 cases) | Simulated | The kill-switch worker is `deploy/sw-unregister.js`. A real rollback of the live host: Not run. |
| UPD-08 | An already-installed browser moves from one real release to the next without losing a draft or resending anything | Manual | Install the Reader, type a draft, release a newer build, follow the banner; then roll back and repeat | Not run | The live suite only opens a fresh browser context, so it does not show an update across releases. |
| UPD-09 | Cache migrations leave data untouched on failure or on a newer schema, and write a quarantine marker | Auto | `src/offline/` and `src/update/updateController.test.ts` | Simulated |  |

### Offline cache, passkey unlock and lease

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| OFF-01 | The cache is a per-user encrypted store (AES-256-GCM, user bound into the AAD and key derivation) | Auto | `src/offline/crypto.test.ts`; `src/offline/cache.test.ts` | Simulated |  |
| OFF-02 | Unlock is passkey only (WebAuthn PRF); a browser or authenticator without PRF gets no offline cache and is told so | Auto | `src/offline/unlock.test.ts`; `e2e/offline.spec.ts` ("an authenticator without PRF ...", "no WebAuthn at all ...", "passkey path (WebAuthn PRF) with a SIMULATED virtual authenticator ...") | Simulated | Virtual authenticator only. |
| OFF-03 | Real passkey PRF on a hardware key, Safari, iOS and Android | Manual | Set up and unlock the offline cache on each | Not run |  |
| OFF-04 | No message text, titles or ids in IndexedDB or web storage | Auto | `src/offline/noWebStorage.test.ts`; `e2e/offline.spec.ts` "passkey setup, offline reload shows only a locked shell, unlock shows cached history, no plaintext in IndexedDB" | Simulated | Not inspected on the live host. |
| OFF-05 | Offline lease: Ed25519 signature checked before parsing, at most 7 days; an expired or invalid lease makes everything read-only | Auto | `src/offline/lease.test.ts`; `src/offline/gate.test.ts`; `e2e/offline.spec.ts` "an expired lease shows read-only ..." | Simulated | Test-only signing key. |
| OFF-06 | The real Backend issues leases (`POST /leases`, `GET /leases/keys`) and the Reader verifies a real one | Manual | Sign in as a test user, set up offline, confirm a Backend-signed lease is stored and verified | Passed on 2026-11-19 | Live: `POST /leases` 200 with a 7.0-day lifetime for the session's user; a request body is refused (422) and a missing CSRF token is refused (403); the signing key is listed active; the signature verifies independently and with the Reader's verifier, and a tampered copy is rejected. Needs the Backend lease release. One signed-out `GET /leases/keys` through the Reader host answered 404 on 2026-11-19; that single read is not part of the suite and proves nothing about issuance. |
| OFF-07 | Drafts and uncertain attempts are never evicted, and return to their conversation after a reload or unlock with the same ids, with nothing posted | Auto | `src/offline/cache.test.ts`; `src/offline/reconcile.test.ts`; `e2e/offline.spec.ts` "an ambiguous send survives a reload ..." | Simulated |  |
| OFF-08 | Sending switched off (`403 sending_disabled`) shows "Sending is switched off on this Backend. Nothing was sent.", is never retried, and refreshes the session | Auto | `src/test/chats.test.tsx` (sending_disabled cases) | Simulated | Live: Not run; needs the Backend to answer it while sending is off, with a test user. |
| OFF-09 | The cache locks on sign-out, account switch, reload and idle | Auto | `src/offline/unlock.test.ts`; `e2e/offline.spec.ts` "reconnecting returns to the signed-in app, and the reload locks the cache again ..." | Simulated |  |
| OFF-10 | Live, signed in as a test user: passkey setup (virtual authenticator with PRF), the Backend issues a lease (`POST /leases` 200, about 7 days), offline reload and unlock show the cache and the lease state with no `/api/` response, a removed credential never unlocks, then site data is cleared and the session signed out | Auto | `acceptance/offline.spec.ts`; mock counterpart `e2e/offline.spec.ts` "a removed passkey credential ..." | Passed on 2026-11-19 | Live, test user with one readable bench conversation, sending off: 1 passed. Mock e2e passes. Live: Not run; needs a test session and the Backend `messaging` capability reported correctly (the test skips otherwise). |

### Send path

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| SND-01 | The composer offers only paths that work: Backend when sending is available and the Reader is online; Bluetooth or USB only for a connected device that is the identity's own and can send | Auto | `src/device/localSendGate.test.ts`; `e2e/local-send.spec.ts` "online with a device: choose Bluetooth, send, accepted and the recipient ACK are shown; nothing goes to the Backend" | Simulated | Simulated devices. |
| SND-02 | No automatic fallback or reroute in either direction; a lost notification is unknown, with one device write and zero Backend POSTs | Auto | `e2e/local-send.spec.ts` "online, a lost notification: outcome unknown, exactly one device write, zero Backend POSTs, and no automatic resend or reroute" | Simulated |  |
| SND-03 | The offline-lease guard sits inside the device send call: a bypassed UI is still refused with zero writes | Auto | `src/device/localSendGate.test.ts`; `e2e/local-send.spec.ts` "offline with an expired lease: blocked and read-only ..." | Simulated |  |
| SND-04 | Local attempts persist, come back as unknown after a reload and are never resent | Auto | `e2e/local-send.spec.ts` "offline with a valid lease: ... the attempt survives a reload offline" | Simulated |  |
| SND-05 | Signed in with no device connected, the path choice offers the Backend only (or says no path is available), never Bluetooth or USB, and sends nothing | Auto | live signed-in: "the send path offers the Backend only when no device is connected, and never a fallback" | Passed on 2026-11-19 | Live: with sending off and no device, the conversation shows the honest unavailable state with no composer and no device path. |
| SND-06 | A real send over Bluetooth and over USB to a bench contact: one attempt, no Backend duplicate | Manual | See "Manual send journeys"; needs explicit approval because it transmits over radio | Not run |  |

### Device mapping and the channel hash

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| DMP-01 | A local DM goes only to a device contact whose key matches the Backend contact's key prefix; an ambiguous match offers a pick restricted to the candidates; no match means no local path | Auto | `src/device/mapping.test.ts`; `src/device/destinations.test.ts`; `e2e/device-mapping.spec.ts` ("an ambiguous DM contact ...", "a DM contact that is not on the device ...") | Simulated |  |
| DMP-02 | A local channel send goes only to the sender's own linked channel whose name is unique on the Backend and on the device; no typed slot and no slot-0 fallback | Auto | `src/device/mapping.test.ts`; `e2e/device-mapping.spec.ts` ("an ambiguous channel ...", "a channel not on the device ...", "a stock Companion ...") | Simulated |  |
| DMP-03 | When the Backend supplies the one-byte channel hash: exactly one device channel with that hash and an agreeing name; a mismatch, a duplicate hash or a name disagreement is refused | Auto | `e2e/device-mapping.spec.ts` ("a channel whose Backend hash and name both match ...", "a channel whose Backend hash differs ... is refused") | Simulated | The Backend does not yet serve the hash; without it the name rule applies. |
| DMP-04 | The device send call accepts only a session-issued mapping token and re-checks it against the device right before writing | Auto | `src/device/session.test.ts`; `src/device/mapping.test.ts` | Simulated |  |
| DMP-05 | Mapping against a real device's channel list | Manual | Connect a bench device, open a channel conversation, confirm the offered destination | Not run |  |

### Connector (USB serial to MQTT)

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| CON-01 | The C0 contract and its synthetic fixtures validate, and the code matches the contract | Auto | `cd contracts && npm test`; `connector/tests/test_contract_fixtures.py`, `connector/tests/test_contract_matches_code.py` | Simulated | Draft contract; the topic mapping is the Backend's, not yet run against it. |
| CON-02 | C1 forwards device-signed envelopes byte for byte, holds no keys, and reassembles split frames into one message | Auto | `connector/tests/test_bridge.py` ("random_opaque_messages_arrive_byte_identical", "split_frame_is_published_exactly_once"); `connector/tests/test_framing.py` | Simulated |  |
| CON-03 | A device command is written at most once: not after a broker reconnect, not held across an unplug, not retried after a write failure | Auto | `connector/tests/test_bridge.py` ("command_is_not_written_again_after_broker_reconnect", "command_dropped_when_serial_is_down_and_not_held_for_replug", "write_failure_is_counted_and_never_retried") | Simulated |  |
| CON-04 | A publish whose outcome is unknown is never resent, and every drop is counted | Auto | `connector/tests/test_bridge.py` ("publish_in_doubt_at_disconnect_is_never_resent", "queue_full_drops_newest_and_counts_each") | Simulated |  |
| CON-05 | Relays broker messages only while the device reports an enrolled Deployment record (fail closed) | Auto | `connector/tests/test_gate.py` | Simulated |  |
| CON-06 | Mutation check of the Connector rules | Auto | `python connector/scripts/mutation.py` | Passed on 2026-11-23 | 99 of 99 mutants killed (60 transport and packaging, 39 hold), each by a named failing test; the unmutated suite passed before (448 passed, 10 skipped) and after. |
| CON-07 | The Connector on a real USB device, against a real broker and the real Backend | Manual | Run the Connector on a bench host with a stable-id serial device | Not run | Not verified on any device or Backend. |

### Security

| ID | Criterion | Method | Where automated, or manual steps | Evidence status | Notes |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | `/devices` for A never includes B's devices, and the reverse | Auto | live: "/devices of A never includes a device of B, and the reverse" | Passed on 2026-11-19 | Live signed-in with two test users. |
| SEC-02 | Cross-user message isolation | Manual | Two test users; compare conversation ids and message ids visible to each, count only | Not run | |
| SEC-03 | Fleet owner and instance admin roles do not read another user's private messages | Manual | Sign in as a fleet owner test user; confirm another user's messages are not shown | Not run | |
| SEC-04 | Revocation and expiry fail closed | Manual | See M1-13 and M1-14 | Not run | |
| SEC-05 | The Reader never stores or exports MeshCore private keys | Auto | `src/ble/adapter.test.ts` "persists nothing: no localStorage, sessionStorage or IndexedDB use across a full session"; `src/ble/probe/probeCore.test.ts` "removes keys, names, ids, coordinates and PINs and keeps presence and lengths" | Simulated | Code review of key handling also needed: Not run. |
| SEC-06 | Strict CSP: no inline script or style | Auto | live: "shell answers 200 with security headers" and the CSP console check | Passed on 2026-11-19 |  |
| SEC-07 | Source and provenance integrity of observations | Review | Review the observation contract and its signature or provenance fields | Passed on 2026-11-23 (contract only) | The reception schema is closed (`additionalProperties: false`): no transmitter location, route, hop, raw bytes or packet hash. `provenance` names the visibility rule, not who produced the data. There is no signature field, and `observed_at` is the observer's own clock, qualified by `clock_confidence`. So authenticity is the Backend's to ensure at ingest; review against a real feed: Not run. |
| SEC-08 | Security-sensitive tests fail when the logic is broken | Review | `reader/scripts/mutation.mjs`, run by the `reader-mutation` job in `.github/workflows/ci.yml` (send safety, CSRF, probe allowlist; kills counted only as failed tests) | Passed on 2026-11-23 | Reader: `reader/scripts/mutation.mjs` in CI (`reader-mutation`), 45 of 45 mutants killed, each by a named failing test, with the control run (627 passed) first and the baseline passing after restore; it covers the send capability gates, the send and send-again checks, the local send paths, identity ownership, the destination token, the offline lease guard, the CSRF retry and sign-out reset, and the probe allowlist. Connector: CON-06. |
| SEC-09 | No secrets, personal data or real device identifiers in the repository or evidence | Review | Scan the repository and the evidence reports before publishing | Passed on 2026-11-23 (working tree) | All 407 tracked files and all 146 commits were scanned for tokens and keys, emails, MAC addresses, non-loopback IP addresses and private host or board names. Working tree: no finding after this change, which rewords one host name in `release.yml`. The only key material is the published, labelled test-only keypair. The commit history still holds private names and links in older documentation and commit subjects; whether to rewrite it is the owner's decision. Evidence reports outside the repository were not scanned. Owner's decision, 2026-11-23: the history is left as it is (a rewrite would break clones, PR references and release tags); accepted limitation. |

## How evidence is recorded

- Each run produces a short report: the matrix version, run date, Reader commit (from `/version.json`), the list of rows run with their status, and the exact pass, fail and skip counts.
- Reports contain no personal data: no email addresses, display names, session values, device ids, node keys, contact names, coordinates or message text. Use counts and synthetic labels (user A, user B).
- Automated live runs print only test names and results. The signed-in suite takes session values from the environment, never prints them, and disables trace, video and screenshots.
- BLE and USB probe reports are pasted into the hardware tracking thread in the form the probe's "Copy report" button produces, which sanitizes keys, names, ids, coordinates and PINs.
- A row changes from Not run only when evidence exists. When a prerequisite is missing the row stays Not run and the note says what is missing.

## Go / no-go

**Current state, 2026-11-19: no-go beyond the restricted deployment.** The static shell, headers, service worker, probes and the signed-out Map and device-code boundaries pass live. Everything that needs a signed-in user, a real device or a Backend release is Simulated or Not run.

What blocks each gate:

| Gate | Blocked by |
| --- | --- |
| M1 restricted shell | The real sign-in flow (M1-09; test users sign in through a test-only route), session expiry and server-side revocation (M1-13, M1-14), and the rollout smoke test of mecon.cloud and MQTT (M1-17). Cookie attributes, the cross-site refusal and logout pass live. |
| M2 messaging and Map | Chats lists, mark-read, the send-path state, Map gating with pins, device isolation, leases and the offline cache pass live. Still open: an `acked` send seen live, a channel send (MSG-03), the two-user observation comparison (MAP-02), and the live event stream (MSG-12). Sending stays switched off outside approved test windows. |
| M3 hardware | Real devices: Bluefy on an iPhone or iPad, Android Chrome, desktop Chromium with Web Bluetooth and Web Serial, real passkey PRF authenticators, and the Connector on a real USB device with a real broker. All of it is simulated today; no hardware compatibility is claimed. |
| M4 acceptance | Every row Passed or an accepted, recorded limitation; real-device end-to-end; the manual send journeys (explicit approval, bench radios only); the stock-familiarity review. |

MVP1 acceptance is complete only when every row above is Passed or has a recorded, accepted limitation. **Public beta needs separate owner approval** and is not implied by this matrix, by a green run, or by completing MVP1 acceptance.
