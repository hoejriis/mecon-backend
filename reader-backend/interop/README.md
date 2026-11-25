# Session lookup interop run (a real core against this facade)

A one-off run that checks the session-lookup v1 contract end to end: a real core image, this repository's facade and a driver, on one internal network. Nothing here is deployed, and nothing in it is meant for production. Every name, origin and secret is made up.

## What it proves

1. **The 20 published cases against a real core.** Each case in [`contracts/session-lookup/v1/cases`](../../contracts/session-lookup/v1/cases) is replayed as `tests/lookup_replay.py` does in `http` mode: the raw request is sent to the core and the answer checked against the case (status, schema, body, stream), then a valid-token lookup is sent again through `HttpSessionLookup`, whose answer must mean the same. A refused or absent service token must give `core_unavailable` through the adapter, and its feed must end with no item.
2. **One revocation-feed case** (`revocation-feed`), which the cases cannot replay. A session is cached by the facade as a read, then signed out on the core, and the sign-out must reach the facade within a bound (default 5 s).
   - **A**, the facade's `SessionResolver` over the real adapter, with a 30 s cache: the cache entry must be gone within the bound (a cache of 30 s cannot expire sooner, so only a revocation item removes it), and the next read must be `Denied("revoked")`.
   - **B**, the running facade container with the same 30 s cache: `GET /api/reader/v1/session` answers 200 while the session lives and 401 within the bound after the sign-out.

It does not prove cache timing against the clock, stream closing on a revocation, or the facade's behaviour with the feed down; the facade's own tests do (see the cases README).

## How the cases act on the core

The cases name world actions (`issue-session`, `expire-session`, `revoke-session`, `csrf-for`, `core-degraded`, `core-recovered`). A core does each its own way, so the way is a module you supply (`CORE_OPS`), written for the core under test and kept outside this repository. It runs in a container made from the core's image, next to the core and its code, behind a small agent (`ops_agent.py`) on a unix socket in a volume shared only with the driver. Its interface is described in [`core_ops.py`](core_ops.py): `setup`, `issue_session`, `expire_session`, `revoke_session`, `csrf_for`, optionally `core_degraded` and `core_recovered`, and an optional list of known divergences.

A core that cannot do an op says so (the method is absent or raises `NotApplicable(reason)`), and every case that needs it is reported **NA** with that reason. A case is never counted as passed without being run.

## Running it

Needs Docker with the compose plugin and `timeout` (coreutils) on a CI host, and python3 for the token.

    CORE_DIR=/path/to/core-checkout CORE_ENV_FILE=core.env CORE_OPS=/path/to/ops_module.py ./run.sh
    # or an existing image:
    CORE_IMAGE=registry.example/core:tag CORE_ENV_FILE=core.env CORE_OPS=/path/to/ops_module.py ./run.sh

`run.sh`:

1. generates a service token (`secrets.token_urlsafe`) into a mode-600 file in a private temporary directory, mounted read-only into the core, the facade and the driver; the value is never printed;
2. starts `core`, `core-ops`, `facade` and `driver` with `docker compose up -d --build --wait` on an `internal: true` network with no published ports;
3. execs the driver, which prints one line per case (`PASS`, `FAIL`, `NA` or `XFAIL`) and a total, and exits nonzero on any `FAIL`;
4. on exit, interrupt or termination, runs `docker compose down -v` and shreds the token file. The whole run is bounded (`INTEROP_TIMEOUT`, default 900 s) and each step has its own bound.

The core must serve session lookup v1 at `http://core:8000/internal/session-lookup/v1` (the compose file's `CORE_LOOKUP_URL`; edit it if the core serves the routes elsewhere), and `/health` on port 8000 for its healthcheck. `CORE_ENV_FILE` holds the core's settings for the run: made-up values only, its database under `/data` (the data volume), the service token file at `/run/interop/service_token`, the origin allow-list `https://reader.example.test` and whatever else the core needs to start with no outside services.

`selftest.py` checks the driver itself with no core and no Docker: it runs the driver against this repository's stub core and facade, with the ops layer served by the real agent. `python interop/selftest.py` must print 21 PASS; `--mutate no-feed` must give a FAIL on `revocation-feed`, `--mutate no-degrade` an NA on `lookup-17`, and `--mutate diverge` a FAIL on `lookup-01`.

## Results

- **PASS**: the case ran against the core and every expectation held, on the raw request and through the adapter.
- **FAIL**: an expectation did not hold, or an unexpected error. The line says which step.
- **NA**: the core's ops module cannot do an action the case needs; the line gives its reason.
- **XFAIL**: the core's ops module lists a known divergence for a body member of this case, and the member still diverges. Held strictly: when the member starts matching, the case FAILs until the entry is dropped. It does not set the exit code, so read the list.

The driver redacts every credential and CSRF token it captured from its output.

## Not applicable cases

`lookup-17` (a core that cannot answer) needs `core-degraded`. A core can only offer it if it has a way to make lookups fail from outside without a different fault; one that makes its lookup fail only by patching a function in its own test process reports NA.
