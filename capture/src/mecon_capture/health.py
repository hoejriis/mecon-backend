"""A small read-only health endpoint (stdlib), loopback by default.

GET /healthz returns JSON: `profiles` (one status per source, status.schema.json) and `counters`
(the archive's counters, counters.schema.json). It reports; it never changes anything.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable


def make_server(bind: str, port: int, snapshot: Callable[[], dict]) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                body, code, ctype = json.dumps(snapshot(), separators=(",", ":")).encode(), 200, "application/json"
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
