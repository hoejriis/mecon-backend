# AGENTS.md

Guidance for coding agents (and humans) working on this open-source repository.
Human contributor detail lives in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Layout

- `reader/`: the MECON Reader web app (React, TypeScript, Vite).
- `connector/`: the standalone USB serial-to-MQTT Connector (Python). See `connector/README.md`.
- `contracts/`: versioned API contracts (OpenAPI; the USB Connector's JSON Schema contract in `contracts/connector/v1`) and synthetic fixtures.
- `deploy/`: Caddy config and security headers shared by the container image and static hosts.
- `docs/`: product, architecture and protocol documentation. `docs/ARCHITECTURE_DECISIONS.md` is the decision register; read it before changing behaviour it covers.

## Build and test

```sh
cd contracts && npm ci --ignore-scripts && npm test   # contract lint + fixture validation
cd reader && npm ci
cd connector && pip install --require-hashes --no-deps -r requirements-dev.lock && python -m pytest -q   # needs mosquitto for the integration tests
npm run typecheck && npm run lint && npm test && npm run build
npx playwright install chromium && npm run e2e         # headless
docker build -f reader/Dockerfile .                     # from the repo root
```

## Rules that tests and review enforce

- **Contracts:** a change to `contracts/reader-api/v1/openapi.yaml` regenerates `reader/src/api/schema.gen.ts` (`npm run gen:api`). Operations marked M1 are frozen; change M2 drafts by pull request. Fixtures are synthetic only: no real users, keys, coordinates or device ids.
- **Strict CSP:** no inline scripts or styles (this includes React `style` attributes). Keep `deploy/reader-headers.caddy` and `preview.headers` in `reader/vite.config.ts` in sync.
- **Truthful UI:** never simulate an unavailable capability or invent data. Show unavailable, forbidden, offline and unknown states as such.
- **Send safety:** BLE and Backend are separate, explicit send paths. An attempt is sent at most once; an uncertain outcome is `unknown` and is never resent automatically or rerouted. A retry is a new user action with a new attempt id.
- **Connector transparency:** the Connector forwards device-signed envelopes byte for byte, holds no keys or identity, never fabricates an acknowledgement, and never writes a device command twice or resends a publish whose outcome is unknown. Every drop is counted. Changes to those rules need the mutation check (`python connector/scripts/mutation.py`).
- **Keys:** the Reader never stores or exports MeshCore private keys.
- **Map:** show only real observer locations; never infer transmitter positions or RF routes.
- **Licensing:** Apache-2.0, original code only. Do not copy GPL-licensed client code or protected artwork. Use the official MeshContinuum brand SVGs in `reader/public/brand/` unmodified; never draw a substitute logo.
- **Security-sensitive logic** (authentication, CSRF, send safety, the read-only BLE probe guard) needs tests that fail when the logic is broken. Check by breaking it.
