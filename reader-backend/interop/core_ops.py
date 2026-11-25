"""The driver-op interface of the interop run: how the replay acts on a REAL core.

The published session-lookup cases name world actions (`issue-session`, `expire-session`, `revoke-session`,
`csrf-for`, `core-degraded`, `core-recovered`). A core does each "by whatever means its tests use", so the means
is pluggable: the party running the interop supplies a small module (env `CORE_OPS`, a dotted module name or a
path to a .py file) that runs INSIDE the core's own container, next to its code, and `ops_agent.py` serves it on
a unix socket the driver container reaches. This file holds the shared pieces (stdlib only, so it imports in any
image): the interface, the not-applicable signal and the client the driver uses.

The module supplies `make_ops()`, returning an object with:

    setup() -> None                         seed the world's two users (alice a plain user, admin an instance
                                            admin), idempotent
    issue_session(user: str) -> str         a new live session for "alice" or "admin"; returns the credential
                                            (the cookie value). Never log it.
    expire_session(credential: str)         move its expiry into the past, as time passing would
    revoke_session(credential: str)         end it as signing out would
    csrf_for(credential: str) -> str        the CSRF token the core derives for it
    core_degraded() / core_recovered()      OPTIONAL: make the core unable to answer lookups, and undo it.
                                            Absent, or raising NotApplicable(reason), marks the cases that
                                            need it NOT APPLICABLE with that reason; they never pass silently.
    known_divergences                       OPTIONAL list of {"case", "pointer", "reason"}: a body member where
                                            the core knowingly differs from a case. Strict: the driver fails
                                            the case if the member stops diverging, and reports it as XFAIL
                                            (not PASS) while it does.

A method may raise NotApplicable(reason) for any op it cannot do.
"""
from __future__ import annotations

import json
import socket
from typing import Any

MAX_LINE = 1 << 20


class NotApplicable(Exception):
    """The core cannot do this op; the reason is printed next to the cases that need it."""


class OpsError(Exception):
    """The op failed (not the same as not applicable)."""


class OpsClient:
    """The driver's side: one JSON line out, one back, over the unix socket `ops_agent.py` serves."""

    def __init__(self, sock_path: str, timeout_s: float = 30.0):
        self.sock_path, self.timeout_s = sock_path, timeout_s

    def call(self, op: str, **args: Any) -> Any:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(self.timeout_s)
            s.connect(self.sock_path)
            s.sendall(json.dumps({"op": op, "args": args}).encode() + b"\n")
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_LINE:
                    raise OpsError("ops answer too large")
        try:
            reply = json.loads(buf)
        except ValueError:
            raise OpsError(f"ops {op}: unreadable answer") from None
        if reply.get("ok"):
            return reply.get("value")
        if "na" in reply:
            raise NotApplicable(reply["na"])
        raise OpsError(f"ops {op}: {reply.get('error', 'failed')}")

    # the interface, named as in the module above
    def describe(self) -> dict:
        return self.call("describe")

    def setup(self) -> None:
        self.call("setup")

    def issue_session(self, user: str) -> str:
        return self.call("issue_session", user=user)

    def expire_session(self, credential: str) -> None:
        self.call("expire_session", credential=credential)

    def revoke_session(self, credential: str) -> None:
        self.call("revoke_session", credential=credential)

    def csrf_for(self, credential: str) -> str:
        return self.call("csrf_for", credential=credential)

    def core_degraded(self) -> None:
        self.call("core_degraded")

    def core_recovered(self) -> None:
        self.call("core_recovered")
