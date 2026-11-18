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
| `npm run e2e` | Builds, serves with `vite preview` under the production CSP, and runs headless Chromium at 390x844, 820x1180 and 1440x900. Screenshots go to `e2e-artifacts/` (gitignored). |

Docker image, built from the repository root:

    docker build -f reader/Dockerfile --build-arg RENDER_GIT_COMMIT=$(git rev-parse HEAD) -t mecon-reader .
    docker run --rm -p 8080:8080 mecon-reader

## Layout

- `reader/src/tabs.ts`: the five tabs (Chats, Nodes, Map, Tools, Settings) and their placeholder copy.
- `reader/src/components/`: header and bottom tab bar.
- `reader/src/routes/`: one page component per tab; from 900px wide a list pane and a detail pane sit above the bottom bar.
- `reader/src/styles/tokens.css`: design tokens (palette, light and dark via `prefers-color-scheme`).
- `reader/public/brand/`: official brand SVGs.
- `deploy/`: Caddy configuration (`reader-headers.caddy` defines the `(reader_headers)` snippet; `Caddyfile` serves the built app).
- `.github/workflows/ci.yml`: checks and image smoke test.

The build stamp `__BUILD_COMMIT__` is set from the `RENDER_GIT_COMMIT`
environment variable at build time and is `null` when unset.

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
