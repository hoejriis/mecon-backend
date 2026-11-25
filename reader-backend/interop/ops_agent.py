"""Serves the CORE_OPS module on a unix socket. Runs in a container made from the core's image, beside the core.

Stdlib only. The wire is one JSON line per request ({"op", "args"}) and one per answer ({"ok": true, "value"},
{"ok": false, "na": reason} or {"ok": false, "error": text}). Credentials pass through here and are never
logged: the log names ops only. The socket is mode 0666 inside a volume shared with the driver container alone.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core_ops import MAX_LINE, NotApplicable  # noqa: E402

OPS = {"setup", "issue_session", "expire_session", "revoke_session", "csrf_for", "core_degraded", "core_recovered"}
LOCK = threading.Lock()


def load(spec: str):
    if spec.endswith(".py") or os.sep in spec:
        s = importlib.util.spec_from_file_location("interop_core_ops_impl", spec)
        mod = importlib.util.module_from_spec(s)
        s.loader.exec_module(mod)
    else:
        mod = importlib.import_module(spec)
    return mod.make_ops()


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        line = self.rfile.readline(MAX_LINE)
        try:
            req = json.loads(line)
            op, args = req["op"], req.get("args", {})
        except (ValueError, KeyError, TypeError):
            return self.send({"ok": False, "error": "bad request"})
        ops = self.server.ops
        if op == "describe":
            return self.send({"ok": True, "value": {"known_divergences": list(getattr(ops, "known_divergences", []))}})
        if op not in OPS:
            return self.send({"ok": False, "error": "unknown op"})
        fn = getattr(ops, op, None)
        if fn is None:
            return self.send({"ok": False, "na": f"this core's ops module has no {op}"})
        try:
            with LOCK:
                value = fn(**args)
        except NotApplicable as e:
            return self.send({"ok": False, "na": str(e)})
        except Exception as e:  # noqa: BLE001 - reported to the driver by type only, never the message
            print(f"ops_agent: {op} failed: {type(e).__name__}", file=sys.stderr, flush=True)
            return self.send({"ok": False, "error": type(e).__name__})
        print(f"ops_agent: {op} ok", flush=True)
        self.send({"ok": True, "value": value})

    def send(self, obj: dict) -> None:
        self.wfile.write(json.dumps(obj).encode() + b"\n")


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main() -> int:
    sock = os.environ.get("OPS_SOCKET", "/ops/ops.sock")
    ops = load(os.environ["CORE_OPS"])
    if os.path.exists(sock):
        os.unlink(sock)
    srv = Server(sock, Handler)
    os.chmod(sock, 0o666)
    srv.ops = ops
    print("ops_agent: ready", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
