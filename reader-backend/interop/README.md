# Reader core interop run (a real core against this repository's HTTP adapter)

A one-off run that replays every published reader-core v1 case through `HttpReaderCore`, the adapter the facade uses, against a real core over HTTP. Nothing here is deployed, and nothing in it is meant for production. Every name, origin and secret is made up. It is a run harness, not part of the facade.

## What it does

For each case in [`contracts/reader-core/v1/cases`](../../contracts/reader-core/v1/cases), as `tests/core_replay.py` does in its `adapter` target against the in-repo stub:

1. the case's world is built inside the core (once per case, a fresh copy);
2. each request is sent raw, as the case writes it, and the answer is checked against the case (status, declared status, schema, body values, matches, lease checks);
3. the same request is sent again through `HttpReaderCore`, from the world as it was before the raw request (the core's database is saved and put back around it), and the adapter's answer, turned back into the contract's status and body, must meet the same expectation. An httpx hook records what the adapter sent: one request, the case's body (a `limit` of 50 is the default), a bearer token. With a wrong token the adapter must answer `core_unavailable`; with an absent token file it must send nothing. A step whose body breaks the request schema is sent raw only, since the port takes typed arguments.

A case a core cannot express is reported NOT APPLICABLE with the core's own reason, never passed.

## How the cases act on the core

The cases name world actions (`issue-session`, `user-id`, `end-session`, `expire-session`, `approve-login`, `exhaust-login-limit`, `set-switch`, `age-out-events`, `core-degraded`, `core-recovered`). A core does each its own way, so the way is a module the runner supplies (`CORE_OPS`), kept outside this repository and written for the core under test. `core_driver.py` lists the ops it calls. The module runs in the core's own process: a launcher (`CORE_LAUNCHER`, also supplied) calls `ops_agent.serve_in_thread` and then starts the core, because the core's rate limits, its mailer and its database handle live there. The driver reaches the module over a unix socket in a volume shared with the core alone.

## Running it

Needs Docker with the compose plugin and `timeout` (coreutils) on a CI host, and python3 for the token.

    CORE_IMAGE=registry/core:tag CORE_ENV_FILE=core.env CORE_OPS=/path/ops_module.py CORE_LAUNCHER=/path/launcher.py ./run_core.sh

`run_core.sh`:

1. generates a service token (`secrets.token_urlsafe`) into a mode-600 file in a private temporary directory, mounted read-only into the core and the driver; the value is never printed;
2. starts `core` and `driver` with `docker compose up -d --build --wait` on an `internal: true` network with no published ports;
3. execs the driver, which prints one line per case (`PASS`, `FAIL` or `NA`) and a total, and exits nonzero on any `FAIL`;
4. on exit, interrupt or termination, runs `docker compose down -v` and shreds the token file. The whole run is bounded (`INTEROP_TIMEOUT`, default 900 s) and each step has its own bound.

The core must serve reader-core v1 at `http://core:8000/internal/reader-core/v1` (`CORE_URL` in the compose file) and `/health` on port 8000. `CORE_ENV_FILE` holds the core's settings for the run: made-up values only, its database under `/data`, the service token file at `/run/interop/service_token`, and whatever else the core needs to start with no outside services. `DOCKER_CMD` names the docker command (`sudo -n docker` where the user needs sudo).

## Results

- **PASS**: the case ran against the core, raw and through the adapter, and every expectation held.
- **FAIL**: an expectation did not hold, or an unexpected error. The line says which step.
- **NA**: the core's ops module cannot do an action the case needs; the line gives its reason.

The driver scrubs a login `credential` from its output. It does not prove the facade's mapping of these answers (its own tests do).
