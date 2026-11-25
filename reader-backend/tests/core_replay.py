"""Replays the published reader-core cases (contracts/reader-core/v1/cases), read in place, never copied.

Two targets, per the cases README:

- `http`: a stub core (`stub_reader_core.py`) on a loopback socket. Every request is sent raw, as the case writes it
  (its body, and the service token the case names), and the stub's answer is checked against the case: status,
  declared status, schema, body values, matches and lease checks.
- `fake`: `FakeReaderCore` called directly with the case's arguments, its answer turned into the contract's status
  and body (`stub_reader_core.dispatch`), so the facade's own tests run against a fake that follows the contract.
  The fake is a Python port: it has no service token and takes typed arguments, so the cases about the token and
  about a body that breaks the request schema are not applicable to it.

The checks are the Reader API runner's own (`replay.Replay`), so the two runners cannot judge a body differently.
"""
from __future__ import annotations

import json
import re
from datetime import timedelta
from typing import Any

import httpx

from mecon_reader_backend.fakes import FakeReaderCore
from mecon_reader_backend.fakes.world import now
from replay import CaseFailed, NotApplicable, Replay
from stub_core import serve
from stub_reader_core import CORE, StubReaderCore, dispatch, world_from_core_description

MODES = ("http", "fake")
FAKE_NO_TOKEN = "the fake core is a Python port with no service token; the token is the HTTP surface's"
FAKE_NO_SCHEMA = "a body that breaks the request schema is the HTTP surface's to refuse; the port takes typed arguments"


class CoreReplay:
    # The Reader API runner's checks, shared as they are.
    check = Replay.check
    check_headers = Replay.check_headers
    check_match = Replay.check_match
    check_lease = Replay.check_lease
    select = Replay.select

    def __init__(self, case: dict, mode: str):
        assert mode in MODES
        self.case, self.mode = case, mode
        self.contract = CORE
        self.world = world_from_core_description(CORE.worlds["worlds"][case["world"]])
        self.captures: dict[str, Any] = {}
        self.log: list[str] = []
        self.stub: StubReaderCore | None = None
        self.fake = FakeReaderCore(self.world)

    @property
    def core(self) -> FakeReaderCore:
        return self.stub.core if self.mode == "http" else self.fake

    def fail(self, step: int, msg: str) -> None:
        raise CaseFailed(f"{self.case['id']} [{self.mode}] step {step}: {msg}\n" + "\n".join(self.log[-6:]))

    def sub(self, value: Any) -> Any:
        if isinstance(value, str):
            m = re.fullmatch(r"\$\{([a-z][a-z0-9_]*)\}", value)
            if m:
                return self.captures[m.group(1)]
            return re.sub(r"\$\{([a-z][a-z0-9_]*)\}", lambda mm: str(self.captures[mm.group(1)]), value)
        if isinstance(value, list):
            return [self.sub(x) for x in value]
        if isinstance(value, dict):
            return {k: self.sub(x) for k, x in value.items()}
        return value

    def session(self, ref: str):
        s = self.world.session_by_ref(ref)
        if s is None:
            raise CaseFailed(f"{self.case['id']}: no session has that session_ref")
        return s

    # ---- actions ----

    def act(self, step: dict) -> None:
        name, args = step["action"], self.sub(step.get("args", {}))
        if name not in CORE.actions:
            raise NotApplicable(f"action {name} is not mapped")
        w = self.world
        captured = None
        if name == "issue-session":
            captured = w.session_ref(w.mint_session(args["user"]))
        elif name == "user-id":
            captured = w.users[args["user"]].id
        elif name == "end-session":
            w.revoke(self.session(args["session_ref"]), "ended")
        elif name == "expire-session":
            self.session(args["session_ref"]).expires_at = now() - timedelta(seconds=1)
        elif name == "approve-login":
            self.core.approve_login(args["request_id"])
        elif name == "set-switch":
            if args["switch"] not in ("sending", "lease_signing"):
                raise NotApplicable(f"unknown switch {args['switch']}")
            w.switches[args["switch"]] = args["value"]
        elif name == "age-out-events":
            w.age_out()
        elif name == "core-degraded":
            self.core.unavailable = True
        elif name == "core-recovered":
            self.core.unavailable = False
        if "capture" in step:
            if captured is None:
                raise CaseFailed(f"action {name} captures nothing")
            self.captures[step["capture"]] = captured

    # ---- requests ----

    async def request(self, i: int, step: dict) -> None:
        req, expect = step["request"], step["expect"]
        op_id = req["operation"]
        op = CORE.ops[op_id]
        token = req.get("service_token", "valid")
        body = self.sub(req["body"]) if "body" in req else None
        if self.mode == "fake":
            if token != "valid":
                raise NotApplicable(FAKE_NO_TOKEN)
            if req.get("invalid"):
                raise NotApplicable(FAKE_NO_SCHEMA)
            status, wire = await dispatch(self.fake, op_id, body)
            raw = b"" if wire is None else json.dumps(wire).encode()
            self.log.append(f"fake {op_id} -> {status} {raw[:300]!r}")
            got = self.check(i, op, expect, status, None, raw)
        else:
            headers = {}
            if token == "valid":
                headers["Authorization"] = "Bearer " + self.stub.token
            elif token == "wrong":
                headers["Authorization"] = "Bearer synthetic-wrong-token"
            content = None
            if body is not None:
                content = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            r = await self.raw.request(op["method"], op["path"], headers=headers, content=content)
            self.log.append(f"{op['method']} {op['path']} ({token} token) -> {r.status_code} {r.text[:300]}")
            got = self.check(i, op, expect, r.status_code, r.headers, r.content)
        for name, sel in (step.get("capture") or {}).items():
            self.captures[name] = self.select(i, got, sel)

    async def run(self) -> None:
        if self.mode == "fake":
            for i, step in enumerate(self.case["steps"], 1):
                if "action" in step:
                    self.act(step)
                else:
                    await self.request(i, step)
            return
        self.stub = StubReaderCore(self.world)
        async with serve(self.stub) as base:
            self.raw = httpx.AsyncClient(base_url=base, trust_env=False, follow_redirects=False, timeout=10)
            try:
                for i, step in enumerate(self.case["steps"], 1):
                    if "action" in step:
                        self.act(step)
                    else:
                        await self.request(i, step)
            finally:
                await self.raw.aclose()
