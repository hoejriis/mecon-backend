# Reader development

Guide for human contributors to the Reader web app in `reader/`. Product and
API intent live in [MVP1_IMPLEMENTATION_DESIGN.md](MVP1_IMPLEMENTATION_DESIGN.md)
and [READER_API_CONTRACT.md](READER_API_CONTRACT.md).

## Prerequisites

- Node.js 22 and npm.
- Docker, only to build or smoke-test the runtime image.
- For end-to-end tests: `npx playwright install chromium` once (add
  `--with-deps` on a fresh Linux machine).

## Commands

Run from `reader/`:

| Command | What it does |
| --- | --- |
| `npm ci` | Install the exact locked dependencies. |
| `npm run dev` | Vite dev server. |
| `npm run typecheck` | `tsc --noEmit` with strict settings. |
| `npm run lint` | ESLint. |
| `npm test` | Vitest unit tests (jsdom, Testing Library). |
| `npm run build` | Typecheck and production build into `dist/`. |
| `npm run gen:api` | Regenerate `reader/src/api/schema.gen.ts` from `contracts/reader-api/v1/openapi.yaml` (openapi-typescript, pinned exactly). The output is committed; a unit test fails when it is stale (`npm run gen:api:check` does the same check alone). |
| `npm run e2e` | Builds, serves with `vite preview` under the production CSP, and runs headless Chromium at 390x844, 820x1180 and 1440x900. Screenshots go to `e2e-artifacts/` (gitignored). `e2e/updates.spec.ts` builds two production builds with different commits and serves them from a small server (`e2e/swapServer.ts`) that swaps the served build, to exercise the service worker update lifecycle. `e2e/rollback.spec.ts` rolls that server back to builds with no worker (built with `MECON_SW=off`, which leaves the `mecon-service-worker` plugin out and is a test-only flag) and to one serving the kill switch. |

Docker image, built from the repository root:

    docker build -f reader/Dockerfile --build-arg RENDER_GIT_COMMIT=$(git rev-parse HEAD) -t mecon-reader .
    docker run --rm -p 8080:8080 mecon-reader

## Layout

- `reader/src/tabs.ts`: the five tabs (Chats, Nodes, Map, Tools, Settings) and their placeholder copy.
- `reader/src/api/`: typed API client and the generated schema types.
- `reader/src/auth/`: auth state, login polling and pending-login storage.
- `reader/src/staleShell.ts`: stale-shell repair.
- `reader/src/sw/`: the service worker source (`sw.js`) and the build helper that stamps and lists the precache (`buildSw.ts`).
- `reader/src/update/`: the update lifecycle (`updateController.ts`), the guards that say what an update would interrupt (`guards.ts`), registration (`register.ts`) and the banner.
- `reader/src/storage/`: the versioned migration runner (schema v1 is the encrypted offline cache).
- `reader/src/offline/`: the encrypted offline cache and lease. `unlock.ts` (passkey through WebAuthn PRF only, with no PIN and no fallback; random data key wrapped by the KEK; idle lock; a browser without PRF gets no offline cache), `crypto.ts` (AES-GCM records with the user in the AAD, HKDF per-user and per-purpose keys), `cache.ts` (IndexedDB, bounded LRU, drafts and send attempts never evicted), `lease.ts` and `leaseManager.ts` (Ed25519 verification, `permits()`), `gate.ts` (the mode rules and `offlineSendGuard`, the guard the BLE and USB send paths call), `reconcile.ts` (reconnect), `session.ts` (lock rules), and the React provider and screens. Tests use `fake-indexeddb` and WebCrypto in Node; `testkit.ts` is test-only.
- `reader/src/components/`: header, skip link, bottom tab bar with icons, state components and login screen.
- `reader/src/routes/`: one page component per tab; from 900px wide a list pane and a detail pane sit above the bottom bar.
- `reader/src/styles/tokens.css`: design tokens (palette, light and dark via `prefers-color-scheme`).
- `reader/public/brand/`: official brand SVGs.
- `deploy/`: Caddy configuration (`reader-headers.caddy` defines the `(reader_headers)` snippet; `Caddyfile` serves the built app).
- `.github/workflows/ci.yml`: checks and image smoke test.

The build stamp `__BUILD_COMMIT__` is set from the `RENDER_GIT_COMMIT`
environment variable at build time and is `null` when unset. The full value
is exposed as `BUILD_COMMIT` in `reader/src/buildInfo.ts`; Settings shows the
first 12 characters, and stale-shell repair compares the whole string.

## Authentication client

`reader/src/api/client.ts` is a same-origin `fetch` client (base
`/api/reader/v1`, `credentials: 'same-origin'`) typed from the generated
schema. State-changing calls send `X-CSRF-Token` from the latest
`GET /session`; on 403 `csrf_failed` the client refetches the session and
retries once, never more. Any 401 clears the in-memory session and cached data
and shows the login screen. Login follows the contract: `POST /login`, then
poll `GET /login/{request_id}` at `poll_after_ms`; only the polling app is
signed in. The pending `{request_id, expires_at}` is kept in `localStorage`
(failures to use storage are ignored) so a killed app resumes polling.

### Stale installed shell

An installed shell can run an old build for days, so on load the Reader
fetches `/version.json` (emitted at build by `reader/vite.config.ts`, body
`{"commit": <string|null>}`) and compares it with the commit compiled into the
bundle. The Backend's `/health` is deliberately not used for this: it reports
the Backend's commit, which differs from the Reader's. A null commit on either
side does nothing, and a matching commit does nothing. `/version.json` is
served with `Cache-Control: no-cache` by `deploy/reader-headers.caddy` like
everything outside `/assets/`, and the service worker never answers it.

When both commits are non-null and differ, the repair runs **only when nothing
can be lost**, that is when no draft is non-empty, no send attempt is in an
uncertain state and no BLE link is open (see "Safe updates"). That is checked
before the repair and again after the roughly 3 s wait, because a draft can be
typed meanwhile. The repair asks the registered worker to update and waits;
if a new version has downloaded it is activated the normal way (rollback cache
kept), otherwise every worker is unregistered, every cache deleted and the page
reloaded, at most once per served commit (`sessionStorage`). When something
could be lost, nothing is repaired or reloaded: the same confirmed-update
banner as for a waiting version is shown and the user decides.

## Safe updates

The Reader ships a service worker (`/sw.js`, a same-origin static file written
at build by the `mecon-service-worker` plugin in `reader/vite.config.ts`; no
inline script, so the strict CSP is unchanged). Source: `reader/src/sw/sw.js`.
It is registered in production builds only.

**Worker.** Install downloads `index.html` and every built file (hashed assets
and `public/` files, never `sw.js` or `version.json`) into a cache named
`mecon-reader-shell-<commit>` (`local-<hash>` for a build with no commit), and
writes a completion marker last. It never calls `skipWaiting`: a new version
waits. A failed or interrupted install deletes only its own incomplete cache
and rejects, so the running version and its cache are untouched. Navigations
are answered with the cached `index.html` (offline included); precached files
are served cache-first. `/api/*` is never handled by the worker: no cache, no
offline fallback, the browser goes to the network. Non-GET, cross-origin,
`/version.json`, `/sw.js` and unknown paths also go to the network. The worker
holds no message text, drafts or other private data.

**Activation and retention.** The page sends `SKIP_WAITING` only after a user
tap (and confirmation, below). On activation the worker records
`{current, previous}` in the `mecon-reader-meta` cache (cache names only),
keeps the previous version's cache, and deletes caches older than the previous
one. The previous cache is deleted only when a page running the new version
sends `BOOT_OK` with its own commit (so an old tab cannot vouch for the new
version) and no other tab is open (an old tab may still need that version's
lazy chunks; with two tabs the cache is kept until one new page is the only
tab). Until then an asset missing from the new cache is served from the
previous one.

**Banner and confirmation.** With a waiting version the Reader shows a
non-blocking "Update available" banner. Activation needs a tap. Before it
activates, the Reader asks every registered guard (`update/guards.ts`):
non-empty drafts (`MessagingContext`), send attempts with no final outcome
(`isUncertainAttempt`: in flight, ambiguous, unknown, timed out, or awaiting a
DM acknowledgement) and an open BLE link (`bleAdapterGuard`, to be registered
by whichever component mounts a `BleAdapter`; no production view mounts one
yet, so it is not wired). If any guard reports something, a confirmation lists
it: drafts are in memory and would be lost; attempts keep their identity on
the Backend and are not resent; the BLE link would be closed. If something new
appears between the prompt and the confirm, the prompt is shown again instead
of acting. After confirmation the page posts `SKIP_WAITING` and reloads once on
`controllerchange`. The update never sends anything.

**Several tabs.** Activation announces itself on a `BroadcastChannel`
(`mecon-reader-update`) and through the browser's own `controllerchange`. Other
tabs show "Updated in another tab - reload when ready" and never reload by
themselves; their Reload button asks for the same confirmation when they hold
drafts or uncertain attempts.

## Version compatibility and rollback policy

- **Assets.** Hashed files are immutable; `index.html`, `sw.js` and
  `version.json` always revalidate. A deploy publishes a whole build; the
  Reader talks to the Backend through the versioned `/api/reader/v1` contract,
  and a Reader build must work with the Backend versions its contract covers.
- **Host rollback.** The static host keeps previous release directories (the
  release tarball per tag is also kept on GitHub); rolling back is pointing the
  host at an earlier directory. The host-side tooling is outside this
  repository. Installed clients treat that as a newer-commit-differs case: the
  worker of the older build is a different `sw.js`, so it installs, waits and
  is offered through the same banner. A rollback to a release that still ships
  a worker therefore needs no special client step, and never clears caches or
  data. Rolling back below the first worker release is covered next.
- **Rolling back below the first service-worker release.** A release with no
  `/sw.js` (v0.1.0 and v0.2.0) is not a "different worker": on the host an
  unknown path falls back to `index.html` (`try_files {path} /index.html`), so
  `/sw.js` answers 200 `text/html`. The browser's update check cannot parse that
  as a script, so the installed worker stays registered and keeps answering
  navigations with its cached shell. What the browser then does by itself
  (tested in `reader/e2e/rollback.spec.ts`, headless Chromium, host-shaped
  server):
  - The stale-shell check (above) fetches `/version.json`. A rolled-back build
    that has the file names another commit; one that predates it (v0.1.0) is
    answered with 404 or with `text/html` by the fallback, which the check
    treats as "a different build" (`UNVERSIONED`). With nothing at risk the page
    unregisters the worker, deletes its caches and reloads onto the rolled-back
    build within about 3.5 s of the navigation (3.3 s measured: the repair's
    fixed 3 s wait plus reload; the bound the test enforces is 15 s). After that
    the stale shell is never served again: the next navigation is a network
    request.
  - With a draft, an uncertain attempt or an open BLE link the page does **not**
    reload, unregister or clear anything; the confirmed-update banner appears
    and states what would be lost. After the user confirms, the same repair runs.
  - A tab that is never navigated and has no check running keeps its shell
    until it is; nothing reaches into an open tab.

  **Kill switch.** To make a rolled-back host drop the worker without relying on
  the page's own check (for example for clients older than the stale-shell
  check), the host operator copies `deploy/sw-unregister.js` into the rollback
  target directory as `sw.js` (or serves that file at `/sw.js`; it must not be
  cached: the host already sends `Cache-Control: no-cache` outside `/assets/`).
  A browser that installed a Reader worker fetches it on its next update check
  (any navigation, or the hourly and on-focus checks), and the kill-switch
  installs with `skipWaiting`, deletes every cache and unregisters itself on
  activation. It deliberately never navigates or reloads a page and has no
  `fetch` or `message` handler: a worker cannot see unsent drafts, so open tabs
  keep running untouched, and the next navigation the user makes is served by
  the network, that is by the rolled-back build. A tab that had the worker may
  show the "Updated in another tab, reload when ready" banner meanwhile.
  Remove the file again when rolling forward to a release with its own worker.
  To roll forward after a rollback, nothing is needed: the new build's `sw.js`
  replaces the kill-switch's registration, or installs fresh.

  **Backend without the Reader API.** While `/api/reader/v1/*` answers 404 (or
  the network fails), the signed-out screen shows "Could not reach the Backend".
  The session load (a read-only `GET`) is retried by itself, first after 5 s,
  then 10 s, 20 s, 40 s and every 60 s, and stops on a session or a 401. No
  write is retried. The worker never handles `/api/`, so no cache holds that
  state and a reload once the API is back shows the login form.
- **Client rollback.** The previous version's cache is retained until the new
  version has booted and is the only tab (above); a failed install never
  replaces the running version.
- **Local data.** The future encrypted cache is migrated by
  `storage/migrations.ts`: a schema version marker, ordered one-step
  migrations, run on a copy of the live generation, verified, then switched by
  one write. On failure, or when the stored schema is newer than this build
  knows, the live data is left untouched, a quarantine marker is written and the
  UI shows "This version can't read your local data; nothing was deleted."
  with guidance to go back to the version used before or reload the latest.
  The generation kept before a switch is freed only by
  `discardPreviousGeneration`. Today there is one registered migration (0 to 1,
  no data) and nothing stores content; the runner is exercised only by tests
  against an in-memory fake, and is not yet wired to IndexedDB.
- **Never lost by an update:** nothing in web storage holds message text. Drafts
  are in memory and are lost by a reload, which is why a reload asks first.

## Design tokens

`reader/src/styles/tokens.css` has three layers; components use the second and
third only, never raw hex values.

- **Palette** (`--brand-*`, `--surface-dark-*`): the canonical MeshContinuum
  colours from the brand specification.
- **Roles**, defined for light and dark (`prefers-color-scheme`): `--bg`,
  `--surface`, `--surface-raised`, `--surface-sunken`, `--text`,
  `--text-muted`, `--text-on-accent`, `--border` (decorative), `--border-strong`
  (control outlines, at least 3:1), `--accent` (violet: a darkened violet on
  light, the brand violet on dark, both at least 4.5:1 as text), `--accent-soft`,
  `--danger`, `--focus`.
- **Scales**: spacing `--space-1`..`--space-7` (4 px base), radii `--radius-sm`
  to `--radius-pill`, type `--text-xs`..`--text-xl` with weights, and sizes
  (`--tap-min` 44 px, `--tabbar-height`, `--icon-size` 24 px).

The focus ring is `--focus-width` (3 px) in `--focus` (violet on light,
turquoise on dark; at least 3:1 against the backgrounds) with
`--focus-offset`. Turquoise is never used as text or thin lines on light.

Reusable states live in `reader/src/components/States.tsx`: `Empty`,
`Unavailable` (capability unavailable), `Forbidden`, `Offline`
(`navigator.onLine`), `ErrorState` (shows `request_id` small) and `Loading`
(skeleton; the pulse is disabled under `prefers-reduced-motion`). Tab icons are
original line drawings in `TabIcons.tsx`. Accessibility is checked by
`reader/e2e/a11y.spec.ts` (axe, all five tabs, phone and desktop and tablet,
light and dark, zero serious or critical violations); the same run saves
screenshots to `reader/e2e-artifacts/`.

## BLE probe

`/probe/ble` is a production, read-only Bluetooth diagnostics page used to
collect real-hardware evidence (see `docs/BLE_PROBE.md`). It is a lazy chunk and
is not in the main bundle. It identifies the device with the shared detection
(the interface `hello` as `0x7F` frames, then the Companion device query) and
reports the detected firmware, role and capabilities. The dev-only harnesses at
`/dev/ble` (the Companion adapter) and `/dev/ble-session` (the shared device
session over Bluetooth) are separate and are still stripped from production.

## USB device access (Web Serial)

Layers, from the cable up (`reader/src/device/`, `reader/src/ble/serialFraming.ts`):

1. **Byte transport** (`webSerialTransport.ts`, interface `ByteTransport`): moves
   bytes, knows nothing about roles. The chooser is called synchronously from a
   user gesture; only the chosen port is ever opened; nothing reopens it after
   a loss (`connect()` is explicit); writes are bounded and time out.
2. **Identification** (`detect.ts`): after open, finds out what is on the port by
   what it answers, in read-only requests only (see `docs/USB_PROBE.md`). The
   primary path is the MECON firmware's role-agnostic device interface (`hello`
   as a `mecon> ` console line or as `0x7F` frames, `meconIface.ts`); the stock
   CLI (`cliText.ts`) and the Companion binary device query are fallbacks. The
   result is "MECON firmware vX, role R, capabilities ..." or "not MECON /
   unknown", and the role is never taken from a board name.
3. **Drivers and capabilities** (`session.ts`): features are gated on the
   detected capabilities, not on the role. The Companion messaging driver is the
   existing adapter (`ble/adapter.ts`) over `companionSerial.ts` (serial
   wrapper plus the resyncing deframer); it is attached only when the device
   answered Companion frames. A device without `message.send.*` refuses a send
   with `unsupported_capability` and writes nothing.
4. **BLE uses the same layers.** `DeviceSession` accepts a BLE `CompanionTransport`
   as well as a USB byte transport (`detectBleDevice` is the same detection minus
   the console step; BLE has no console, and only Companions have BLE). Both
   produce one `DeviceSession` snapshot and one `DetectedDevice`, gated by the
   same capabilities. A link has a trust: USB `trusted`, BLE `unknown` (Web
   Bluetooth cannot tell a default PIN from a custom one), and on an unknown link
   `request(op)` and the probe ask for class `read` operations only (`trust.ts`).
   See `reader/src/ble/README.md`.
5. **Send safety is the BLE adapter's**: an attempt is written at most once,
   `unknown` is never resent or rerouted, every attempt records its `path`
   (`usb` or `ble`). `unplugged` and `busy` are USB link states.

`/dev/usb` and `/dev/ble-session` are dev-only harnesses (stripped from production). `/probe/usb` is the
read-only page. The simulation (`device/sim/`) is a fake `navigator.serial` over
`MockCompanion` (reused, with a serial wrapper) and `MockRepeater` (a console
with the `mecon> ` interface), with line faults (split, coalesced, garbage,
oversize length) and port faults (cancel, denied, busy, unplug, hang). `npm run e2e`
writes `e2e-artifacts/usb-simulation-matrix.md`. Every result is SIMULATED; nothing
claims hardware compatibility. The Bluetooth simulation is `MockCompanion` (a MECON
Companion that answers `0x7F`, a stock one that does not, a silent one, and one that
refuses `hello`) behind the fake `navigator.bluetooth`; the vitest and Playwright
results for it are SIMULATED as well.

## Content Security Policy rule

The Reader ships under a strict CSP (`script-src 'self'; style-src 'self'`,
see `deploy/reader-headers.caddy`). Do not add inline scripts, inline
`<style>` blocks, `style="..."` attributes in markup, `eval`, or third-party
origins. Put styles in CSS files and scripts in modules. If you change the
policy, change it in both `deploy/reader-headers.caddy` and `preview.headers`
in `reader/vite.config.ts`, so the e2e run keeps testing what is deployed.

## Brand rule

Use only the official SVGs from the MeshContinuum repository's `brand/`
directory, copied unmodified into `reader/public/brand/`. Never redraw,
recolour or approximate the logo, and never use MeshCore marks. Use the
canonical palette from the tokens file.

## Licensing rule

This repository is Apache-2.0. Write original code. Do not copy code, assets
or artwork from MeshCore One or any GPL-licensed or otherwise incompatible
project; using one as a visual or interaction reference is fine, copying is
not. Add dependencies only if their licenses are compatible.

## Honest UI

Do not simulate features the Backend or firmware cannot yet support. Show
truthful empty, loading and unavailable states. Never commit secrets or real
user data, including in test fixtures.

## Local sends (Bluetooth and USB) and the send path

- `reader/src/messaging/localPath.ts` decides which paths can carry a send: Backend when `send` is available and the Reader is online; Bluetooth or USB, for direct messages only, when a `DeviceSession` is connected, its detected capabilities include `message.send.direct` and the device is the sending identity's own (its public key starts with the identity's `public_key_prefix`). Only available paths are shown. The default is Backend while online, else the first local path. A path that disappears is never replaced for the user.
- `reader/src/messaging/localSend.ts` runs one local attempt: the preflight (device, capability, identity, destination, guard) and then the write, once, through `DeviceSession.sendDirect/sendChannel`, whose `authorize()` calls `offlineSendGuard` and the identity-key check before anything reaches the adapter. The guard is therefore in the send call itself, not only in the UI. Online, the lease is not consulted; offline, the lease must permit the operation, identity, device and channel (the session still accepts a channel send for future use and refuses one that does not name its channel; no UI feeds it, and the preflight refuses a channel target).
- An uncertain write is `unknown` (phase `ambiguous`), never resent and never given to the Backend; a Backend `ambiguous` is never given to a device. "Send again" is an explicit action that mints a new attempt id for the same draft id and takes the path the user picks.
- A local attempt records `path` (`ble` or `usb`), the device's `local` facts and the `localTarget` it was addressed to, and is persisted with the other attempts in the encrypted cache. The cache also holds the caller's identities (their assigned device and key prefix are what an offline send is checked against).
- The device layer is a lazy chunk (`device/factory.ts`), fetched when the user connects a device; the main bundle stays Bluetooth- and serial-free.
- A channel target has no local path, online or offline: a channel send needs the device's channel slot, which the Reader cannot learn yet, and a typed slot could transmit to the wrong channel. The UI says so and has no slot entry. A local direct message names its recipient from the connected device's own contact list.
