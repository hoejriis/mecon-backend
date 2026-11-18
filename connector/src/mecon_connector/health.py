"""Tiny health and metrics HTTP endpoint (stdlib), loopback by default, read-only."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from .metrics import Metrics


def make_server(bind: str, port: int, metrics: Metrics, snapshot: Callable[[], dict]) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/metrics":
                body, code, ctype = metrics.render().encode(), 200, "text/plain; version=0.0.4"
            elif self.path == "/healthz":
                snap = snapshot()
                body = json.dumps(snap, separators=(",", ":")).encode()
                code, ctype = (200 if snap.get("ready") else 503), "application/json"
            else:
                body, code, ctype = b"not found\n", 404, "text/plain"
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a: object) -> None:  # request lines are not logged
            pass

    return ThreadingHTTPServer((bind, port), Handler)


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    t = threading.Thread(target=server.serve_forever, name="health", daemon=True)
    t.start()
    return t
