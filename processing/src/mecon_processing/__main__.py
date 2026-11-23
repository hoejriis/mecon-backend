"""Entry point: mecon-processing --config /etc/mecon-processing/config.toml [--once]"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading

from . import __version__
from .config import ConfigError, load
from .documents import ArchiveReader
from .health import make_server, serve_in_thread
from .logutil import Log
from .processor import Processor
from .store import Store


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mecon-processing")
    ap.add_argument("--config", help="path to config.toml")
    ap.add_argument("--check-config", action="store_true", help="validate the config and exit")
    ap.add_argument("--once", action="store_true", help="process what is pending, then exit")
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
    if a.check_config:
        print("config ok")
        return 0
    if not os.path.exists(cfg.archive_path):
        print("config error: archive.path does not exist (the archive is created by the capture service)", file=sys.stderr)
        return 2

    log = Log(level=cfg.log_level)
    reader = ArchiveReader(cfg.archive_path)
    store = Store(cfg.store_path)
    proc = Processor(store, cfg.sources, batch_max=cfg.batch_max, log=log)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    if a.once:
        n = proc.drain(reader)
        log.info("once_done", processed=n)
        store.close()
        return 0

    server = None
    if cfg.health.enabled:
        server = make_server(cfg.health.bind, cfg.health.port,
                             lambda: {"counters": proc.counters(reader), "progress": store.progress()})
        serve_in_thread(server)
    log.info("started", version=__version__, sources=len(cfg.sources))
    while not stop.is_set():
        try:
            before = store.progress()
            proc.run_pending(reader)
            n = store.progress() - before
        except Exception as e:  # the store or the archive could not be used: nothing was committed; try again
            log.error("batch_failed", error=type(e).__name__)
            n = 0
        if n == 0:
            stop.wait(cfg.interval_s)
    if server is not None:
        server.shutdown()
    store.close()  # a batch in flight finished (or rolled back) before the loop looked at the stop flag
    log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
