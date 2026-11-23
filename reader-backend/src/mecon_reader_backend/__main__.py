"""Local run with the fake adapters only: `python -m mecon_reader_backend --world <worlds.json>`.

There are no real adapters yet, so this serves a synthetic in-memory world on the loopback address.
It is for poking at the API by hand, never for deployment.
"""
from __future__ import annotations

import argparse
import json
import sys


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mecon-reader-backend")
    p.add_argument("--world", required=True, help="a worlds.json file (contracts/reader-api/v1/cases/worlds.json)")
    p.add_argument("--name", default="two-fleets", help="which world of the file")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--origin", default="http://127.0.0.1:8787", help="the Reader origin to allow")
    args = p.parse_args(argv)

    import uvicorn

    from . import FacadeConfig, create_app
    from .fakes import build

    with open(args.world, encoding="utf-8") as f:
        desc = json.load(f)["worlds"][args.name]
    world, lookup, core = build(desc)
    world.reader_origins = (args.origin,)
    app = create_app(lookup, core, FacadeConfig(reader_origins=(args.origin,)))
    print(f"fake world {args.name!r}: synthetic data only; logins are approved out of band", file=sys.stderr)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
