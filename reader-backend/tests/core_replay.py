"""Replays the published reader-core cases (contracts/reader-core/v1/cases), read in place, never copied.

Three targets: the two of the cases README, and the HTTP adapter.

- `http`: a stub core (`stub_reader_core.py`) on a loopback socket. Every request is sent raw, as the case writes it
  (its body, and the service token the case names), and the stub's answer is checked against the case: status,
  declared status, schema, body values, matches and lease checks.
- `fake`: `FakeReaderCore` called directly with the case's arguments, its answer turned into the contract's status
  and body (`stub_reader_core.dispatch`), so the facade's own tests run against a fake that follows the contract.
  The fake is a Python port: it has no service token and takes typed arguments, so the cases about the token and
  about a body that breaks the request schema are not applicable to it.
- `adapter`: the `http` target, and then each request again through `HttpReaderCore` against the same stub, from
  the world as it was before the raw request (the world is restored after, to the state the raw request left, so
  later steps see one request's effects and the captures come from the raw answer). The adapter must send exactly
  the case's body (`limit` defaulting to 50) with the service token, and its answer, as the port returns it and
  turned back into the contract's status and body, must meet the same expectation. With an absent or wrong token
  it must answer `core_unavailable` (an absent token sends nothing). A step whose body breaks the request schema is
  sent raw only: the port takes typed arguments, so the adapter never builds such a body.

The checks are the Reader API runner's own (`replay.Replay`), so the two runners cannot judge a body differently.
"""
from __future__ import annotations

import copy
import itertools
import json
import os
import pathlib
import re
import secrets
from datetime import timedelta
from typing import Any

import httpx

from mecon_reader_backend.fakes import FakeReaderCore
from mecon_reader_backend.fakes.world import now
from mecon_reader_backend.http_core import HttpReaderCore
from replay import CaseFailed, NotApplicable, Replay
from stub_core import serve
from stub_reader_core import CORE, StubReaderCore, dispatch, world_from_core_description

MODES = ("http", "fake")  # the cases README's targets (test_core_cases.py)
ADAPTER = "adapter"  # the HTTP adapter against the stub (test_http_core.py)
ADAPTER_UNAVAILABLE = {"status": 503, "schema": "Refusal", "body": {"/code": "core_unavailable"}}
FAKE_NO_TOKEN = "the fake core is a Python port with no service token; the token is the HTTP surface's"
FAKE_NO_SCHEMA = "a body that breaks the request schema is the HTTP surface's to refuse; the port takes typed arguments"


class CoreReplay:
    # The Reader API runner's checks, shared as they are.
    check = Replay.check
    check_headers = Replay.check_headers
    check_match = Replay.check_match
    check_lease = Replay.check_lease
    select = Replay.select

    def __init__(self, case: dict, mode: str, tmp: pathlib.Path | None = None):
        assert mode in MODES or mode == ADAPTER
        assert mode != ADAPTER or tmp is not None, "the adapter mode writes its token files under tmp"
        self.case, self.mode, self.tmp = case, mode, tmp
        self.adapter_steps = 0  # requests also sent through the adapter
        self.raw_only_steps: list[int] = []  # requests sent raw only (a body that breaks the request schema)
        self.contract = CORE
        self.world = world_from_core_description(CORE.worlds["worlds"][case["world"]])
        self.captures: dict[str, Any] = {}
        self.log: list[str] = []
        self.stub: StubReaderCore | None = None
        self.fake = FakeReaderCore(self.world)

    @property
    def core(self) -> FakeReaderCore:
        return self.fake if self.mode == "fake" else self.stub.core

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
        elif name == "exhaust-login-limit":
            self.core.exhaust_login_limit(args["client_address"])
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
            if self.mode == ADAPTER:
                await self.through_adapter(i, op, op_id, expect, body, token, req.get("invalid", False))
        for name, sel in (step.get("capture") or {}).items():
            self.captures[name] = self.select(i, got, sel)

    # ---- the adapter ----

    def snapshot(self):
        """The stub world's and core's state, deep-copied; lease signing keys, queues and id counters are shared."""
        w, core = self.world, self.stub.core
        keep = {id(k.private): k.private for k in w.lease_keys} | {id(q): q for q in w.revocation_queues}
        keep |= {id(v): v for v in w.__dict__.values() if isinstance(v, itertools.count)}  # ids keep counting
        return copy.deepcopy((w.__dict__, {k: v for k, v in core.__dict__.items() if k != "world"}), keep)

    def restore(self, snap) -> None:
        world_state, core_state = snap
        self.world.__dict__.clear()
        self.world.__dict__.update(world_state)
        self.stub.core.__dict__.update(core_state)

    def token_file(self, name: str, value: str | None) -> pathlib.Path:
        p = self.tmp / f"{name}.token"
        if value is not None:
            p.write_text(value + "\n")
            os.chmod(p, 0o600)
        return p

    @staticmethod
    def normalised(body: dict | None) -> dict | None:
        if body is None:
            return None
        return {k: v for k, v in body.items() if not (k == "limit" and v == 50)}

    async def through_adapter(self, i: int, op: dict, op_id: str, expect: dict, body: dict | None, token: str,
                              invalid: bool) -> None:
        if invalid:
            self.raw_only_steps.append(i)
            return
        after = self.snapshot()
        self.restore(self.before)
        adapter = {"valid": self.adapter, "wrong": self.wrong_adapter, "absent": self.absent_adapter}[token]
        sent_from = len(self.stub.requests)
        status, wire = await dispatch(adapter, op_id, body)
        sent = self.stub.requests[sent_from:]
        self.restore(after)
        raw = b"" if wire is None else json.dumps(wire).encode()
        self.log.append(f"adapter {op_id} ({token} token) -> {status} {raw[:300]!r}")
        self.adapter_steps += 1
        if token == "absent":
            if sent:
                self.fail(i, f"the adapter sent a request without a token: {sent}")
        elif len(sent) != 1 or sent[0]["operation"] != op_id \
                or self.normalised(sent[0]["body"]) != self.normalised(body):
            self.fail(i, f"the adapter did not send the case's body: {sent}, expected {body}")
        elif sent[0]["auth_ok"] != (token == "valid"):
            self.fail(i, f"the adapter's token was {'refused' if token == 'valid' else 'accepted'}")
        self.check(i, op, ADAPTER_UNAVAILABLE if token != "valid" else expect, status, None, raw)

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
            adapters = []
            if self.mode == ADAPTER:
                self.adapter = HttpReaderCore(base, self.token_file("valid", self.stub.token), timeout_s=5.0)
                self.wrong_adapter = HttpReaderCore(
                    base, self.token_file("wrong", "synthetic-wrong-token-" + secrets.token_hex(8)), timeout_s=5.0)
                self.absent_adapter = HttpReaderCore(base, self.token_file("absent", None), timeout_s=5.0)
                adapters = [self.adapter, self.wrong_adapter, self.absent_adapter]
            try:
                for i, step in enumerate(self.case["steps"], 1):
                    if "action" in step:
                        self.act(step)
                    else:
                        if self.mode == ADAPTER:
                            self.before = self.snapshot()
                        await self.request(i, step)
            finally:
                for a in adapters:
                    await a.aclose()
                await self.raw.aclose()
