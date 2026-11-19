"""Entry point: python -m mecon_connector --config /etc/mecon-connector/config.toml"""

from __future__ import annotations

import argparse
import dataclasses
import signal
import sys
import threading

from . import __version__
from .bridge import Bridge
from .config import ConfigError, Selector, check_path, check_secrets, load
from .health import make_server, serve_in_thread
from .logutil import Log
from .metrics import Metrics
from .paho_transport import PahoTransport
from .serial_link import list_ports, make_opener


def with_port(cfg, port: str):  # type: ignore[no-untyped-def]
    """The config with the serial selector replaced by an explicit --port path. Validated like the config."""
    problems = check_path(port, "--port")
    if problems:
        raise ConfigError(problems)
    return dataclasses.replace(cfg, device=dataclasses.replace(cfg.device, selector=Selector(path=port)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mecon-connector")
    ap.add_argument("--config", help="path to config.toml")
    ap.add_argument(
        "--port",
        metavar="PATH",
        help="open exactly this serial port (a stable udev symlink such as /dev/bench/<name>); "
        "replaces device.select in the config",
    )
    ap.add_argument("--check-config", action="store_true", help="validate the config and exit")
    ap.add_argument("--list-ports", action="store_true", help="print serial ports with their stable ids and exit")
    ap.add_argument("--version", action="store_true")
    a = ap.parse_args(argv)
    if a.version:
        print(__version__)
        return 0
    if a.list_ports:
        for p in list_ports():
            vid = f"{p.vid:04x}" if p.vid is not None else "-"
            pid = f"{p.pid:04x}" if p.pid is not None else "-"
            print(f"{p.device}\tvid={vid} pid={pid} usb_serial={p.usb_serial or '-'} by_id={','.join(p.by_id_names) or '-'}")
        return 0
    if not a.config:
        ap.error("--config is required")
    try:
        cfg = load(a.config)
        if a.port is not None:
            cfg = with_port(cfg, a.port)
        notes = check_secrets(cfg, missing_ok=a.check_config)
    except ConfigError as e:
        for p in e.problems:
            print(f"config error: {p}", file=sys.stderr)
        return 2
    if a.check_config:
        for n in notes:
            print(f"note: {n}", file=sys.stderr)
        print("config ok")
        return 0

    log, metrics = Log(level=cfg.log_level), Metrics()
    transport = PahoTransport(cfg.mqtt.client_id, cfg.mqtt.keepalive_s)
    bridge = Bridge(cfg, transport, make_opener(cfg.device.selector, cfg.device.baud), metrics, log)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    server = None
    if cfg.health.enabled:
        server = make_server(cfg.health.bind, cfg.health.port, metrics, bridge.snapshot)
        serve_in_thread(server)
    log.info("started", version=__version__, mode=cfg.device.mode, brokers=len(cfg.mqtt.brokers))
    try:
        bridge.run(stop)
    finally:
        if server is not None:
            server.shutdown()
    log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
