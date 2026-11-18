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
| `npm run e2e` | Builds, serves with `vite preview` under the production CSP, and runs headless Chromium at 390x844, 820x1180 and 1440x900. Screenshots go to `e2e-artifacts/` (gitignored). |

Docker image, built from the repository root:

    docker build -f reader/Dockerfile --build-arg RENDER_GIT_COMMIT=$(git rev-parse HEAD) -t mecon-reader .
    docker run --rm -p 8080:8080 mecon-reader

## Layout

- `reader/src/tabs.ts`: the five tabs (Chats, Nodes, Map, Tools, Settings) and their placeholder copy.
- `reader/src/api/`: typed API client and the generated schema types.
- `reader/src/auth/`: auth state, login polling and pending-login storage.
- `reader/src/staleShell.ts`: stale-shell repair.
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
the Backend's commit, which differs from the Reader's. When both commits are
non-null and differ, the Reader asks any registered service worker to update,
waits about 3 s, then unregisters every worker, deletes every cache and
reloads, at most once per served commit (`sessionStorage`). A null commit on
either side does nothing. `/version.json` is served with `Cache-Control:
no-cache` by `deploy/reader-headers.caddy` like everything outside
`/assets/`.

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
