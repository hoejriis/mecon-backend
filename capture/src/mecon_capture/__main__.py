"""Entry point: mecon-capture --config /etc/mecon-capture/config.toml"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading

from . import __version__
from .archive import Archive
from .config import ConfigError, load
from .health import make_server, serve_in_thread
from .ingester import Ingester, utc_now
from .logutil import Log
from .paho_transport import PahoTransport


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mecon-capture")
    ap.add_argument("--config", help="path to config.toml")
    ap.add_argument("--check-config", action="store_true", help="validate the config and exit")
    ap.add_argument("--version", action="store_true")
    a = ap.parse_args(argv)
    if a.version:
        print(__version__)
        return 0
    if not a.config:
        ap.error("--config is required")
    try:
        cfg = load(a.config)
    except ConfigError as e:
        for p in e.problems:
            print(f"config error: {p}", file=sys.stderr)
        return 2
    missing = sorted({r for p in cfg.profiles for r in (p.username_ref, p.password_ref) if r and r not in os.environ})
    if a.check_config:
        for r in missing:
            print(f"note: environment variable {r} is not set", file=sys.stderr)
        print("config ok")
        return 0
    if missing:
        for r in missing:
            print(f"config error: environment variable {r} is not set", file=sys.stderr)
        return 2

    log = Log(level=cfg.log_level)
    archive = Archive(cfg.archive_path, cfg.max_payload_bytes)
    ingester = Ingester(cfg, archive, lambda _p: PahoTransport(), log=log)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    server = None
    if cfg.health.enabled:
        server = make_server(cfg.health.bind, cfg.health.port,
                             lambda: {"profiles": ingester.statuses(), "counters": archive.counters(),
                                      "ingester": ingester.buffer.counters(utc_now())})
        serve_in_thread(server)
    log.info("started", version=__version__, sources=len(cfg.profiles))
    ingester.start()
    stop.wait()
    ingester.stop()  # stops receiving, then flushes the buffer
    if server is not None:
        server.shutdown()
    archive.close()
    log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
