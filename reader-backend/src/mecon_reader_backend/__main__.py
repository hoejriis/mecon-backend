"""Run the facade: `python -m mecon_reader_backend --world <worlds.json>` or `--core-url <url> --token-file <path>`.

- `--world` serves a synthetic in-memory world behind the fake adapters. It is for poking at the API by hand,
  never for deployment.
- `--core-url` wires in the HTTP adapters: `HttpSessionLookup` (contracts/session-lookup/v1, at `--lookup-url`,
  default the core URL) and `HttpReaderCore` (contracts/reader-core/v1). Both send the service token read from
  `--token-file`. Every option also reads an environment variable (named in `--help`).

Either way it listens on the loopback address unless `--host` says otherwise.
"""
from __future__ import annotations

import argparse
import json
import os
import sys


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    return default if value in (None, "") else float(value)


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="mecon-reader-backend")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--world", help="a worlds.json file (contracts/reader-api/v1/cases/worlds.json): fake adapters; "
                                     "--world wins over MECON_READER_CORE_URL when both are set")
    src.add_argument("--core-url", default=os.environ.get("MECON_READER_CORE_URL") or None,
                     help="the core's base URL on the private network, including any prefix in front of /reader/ "
                          "(MECON_READER_CORE_URL): HTTP adapters")
    p.add_argument("--name", default="two-fleets", help="which world of the file (with --world)")
    p.add_argument("--lookup-url", default=os.environ.get("MECON_READER_LOOKUP_URL") or None,
                   help="the session lookup's base URL (MECON_READER_LOOKUP_URL; default: --core-url)")
    p.add_argument("--token-file", default=os.environ.get("MECON_READER_SERVICE_TOKEN_FILE") or None,
                   help="the mode-600 service token file (MECON_READER_SERVICE_TOKEN_FILE); required with --core-url")
    p.add_argument("--core-timeout-s", type=float, default=_env_float("MECON_READER_CORE_TIMEOUT_S", 5.0),
                   help="bound on one core call (MECON_READER_CORE_TIMEOUT_S, 5)")
    p.add_argument("--events-margin-s", type=float, default=_env_float("MECON_READER_EVENTS_MARGIN_S", 5.0),
                   help="added to a readEvents call's wait_s to bound it (MECON_READER_EVENTS_MARGIN_S, 5)")
    p.add_argument("--lookup-timeout-s", type=float, default=_env_float("MECON_READER_LOOKUP_TIMEOUT_S", 2.0),
                   help="bound on one session lookup (MECON_READER_LOOKUP_TIMEOUT_S, 2)")
    p.add_argument("--host", default=os.environ.get("MECON_READER_HOST") or "127.0.0.1",
                   help="the address to listen on (MECON_READER_HOST, 127.0.0.1)")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--origin", default=os.environ.get("MECON_READER_ORIGIN") or "http://127.0.0.1:8787",
                   help="the Reader origin to allow (MECON_READER_ORIGIN)")
    p.add_argument("--trusted-proxy", action="append", default=[],
                   help="an address or CIDR whose X-Forwarded-For is believed (repeatable)")
    args = p.parse_args(argv)
    if not args.world and not args.core_url:
        p.error("one of --world or --core-url (or MECON_READER_CORE_URL) is required")
    if not args.world and not args.token_file:
        p.error("--core-url needs --token-file (or MECON_READER_SERVICE_TOKEN_FILE)")
    return args


def build(args: argparse.Namespace):
    """(app, lookup, core) for the parsed options. Nothing is contacted until a request arrives."""
    from . import FacadeConfig, create_app

    if args.world:
        from .fakes import build as build_fake

        with open(args.world, encoding="utf-8") as f:
            desc = json.load(f)["worlds"][args.name]
        world, lookup, core = build_fake(desc)
        world.reader_origins = (args.origin,)
        cfg = FacadeConfig(reader_origins=(args.origin,), trusted_proxies=tuple(args.trusted_proxy))
        return create_app(lookup, core, cfg), lookup, core

    from .http_core import HttpReaderCore
    from .http_lookup import HttpSessionLookup

    lookup = HttpSessionLookup(args.lookup_url or args.core_url, args.token_file, timeout_s=args.lookup_timeout_s)
    core = HttpReaderCore(args.core_url, args.token_file, timeout_s=args.core_timeout_s,
                          events_margin_s=args.events_margin_s)
    # The facade's own bounds sit just above the adapters', so an adapter's timeout answers first.
    cfg = FacadeConfig(reader_origins=(args.origin,), trusted_proxies=tuple(args.trusted_proxy),
                       lookup_timeout_s=args.lookup_timeout_s + 0.5,
                       core_timeout_s=args.core_timeout_s + args.events_margin_s + 1.0)
    return create_app(lookup, core, cfg), lookup, core


def main(argv: list[str] | None = None) -> int:
    args = parse(argv)
    import uvicorn

    app, _, _ = build(args)
    if args.world:
        print(f"fake world {args.name!r}: synthetic data only; logins are approved out of band", file=sys.stderr)
    else:
        print(f"core {args.core_url}: HTTP session lookup and reader core adapters", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
