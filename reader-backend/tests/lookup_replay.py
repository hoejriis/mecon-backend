"""Replays the published session-lookup cases (contracts/session-lookup/v1/cases), read in place, never copied.

Two targets, per the cases README:

- `http`: a stub core (`stub_core.py`) on a loopback socket. Every request is first sent raw, as the case
  writes it, and the stub's answer is checked against the case (status, schema, body, stream). A lookup with
  the valid service token is then sent again through `HttpSessionLookup`, and the adapter's answer must mean
  the same thing (a `Caller` for 200, the same `Denied` reason for 403, `core_unavailable` for 503). With an
  absent or wrong token the adapter must answer `core_unavailable` and its feed must end with no item.
- `fake`: `FakeSessionLookup` called directly, its answer turned into the contract's status and body, so the
  facade's own tests run against a fake that follows the contract. The fake is a Python port with no service
  token, so the cases about the token are not applicable to it.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import secrets
from datetime import timedelta
from typing import Any

import httpx

from mecon_reader_backend.fakes import FakeSessionLookup
from mecon_reader_backend.fakes.world import now
from mecon_reader_backend.http_lookup import HttpSessionLookup
from mecon_reader_backend.ports import Caller, Denied, Subscribed
from replay import _MISSING, CaseFailed, Contract, NotApplicable, REPO, parse_sse, pointer
from stub_core import StubCore, answer_wire, item_wire, serve, world_from_lookup_description

LOOKUP = Contract("mecon-session-lookup", REPO / "contracts" / "session-lookup" / "v1", ("lookup",), "",
                  ("issue-session", "expire-session", "revoke-session", "csrf-for", "core-degraded",
                   "core-recovered"),
                  lambda desc: (None, None, None, {}))
MODES = ("http", "fake")
STREAM_BOUND_S = 2.0
FAKE_NO_TOKEN = "the fake lookup is a Python port with no service token; the token is the HTTP surface's"


def port_args(body: dict) -> dict[str, Any]:
    return {"credential": body["credential"], "purpose": body["purpose"], "csrf_token": body.get("csrf_token"),
            "origin": body.get("origin"), "sec_fetch_site": body.get("sec_fetch_site")}


class LookupReplay:
    def __init__(self, case: dict, mode: str, tmp: pathlib.Path):
        assert mode in MODES
        self.case, self.mode, self.tmp = case, mode, tmp
        self.world = world_from_lookup_description(LOOKUP.worlds["worlds"][case["world"]])
        self.captures: dict[str, Any] = {}
        self.log: list[str] = []
        self.fake = FakeSessionLookup(self.world)
        self.stub: StubCore | None = None

    # ---- helpers ----

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

    def token_file(self, name: str, value: str | None) -> pathlib.Path:
        p = self.tmp / f"{name}.token"
        if value is not None:
            p.write_text(value + "\n")
            os.chmod(p, 0o600)
        return p

    def auth(self, mode: str) -> dict[str, str]:
        if mode == "absent":
            return {}
        token = self.stub.token if mode == "valid" else "synthetic-wrong-token-" + secrets.token_hex(8)
        return {"Authorization": "Bearer " + token}

    def session(self, credential: str):
        s = self.world.sessions.get(credential)
        if s is None:
            raise CaseFailed(f"{self.case['id']}: no session holds that credential")
        return s

    # ---- actions ----

    def act(self, step: dict) -> None:
        name, args = step["action"], self.sub(step.get("args", {}))
        if name not in LOOKUP.actions:
            raise NotApplicable(f"action {name} is not mapped")
        captured = None
        if name == "issue-session":
            captured = self.world.mint_session(args["user"]).credential
        elif name == "expire-session":
            self.session(args["credential"]).expires_at = now() - timedelta(seconds=1)
        elif name == "revoke-session":
            self.world.revoke(self.session(args["credential"]))
        elif name == "csrf-for":
            captured = self.world.csrf_for(self.session(args["credential"]))
        elif name == "core-degraded":
            self.target_lookup().unavailable = True
        elif name == "core-recovered":
            self.target_lookup().unavailable = False
        if "capture" in step:
            if captured is None:
                raise CaseFailed(f"action {name} captures nothing")
            self.captures[step["capture"]] = captured

    def target_lookup(self) -> FakeSessionLookup:
        return self.stub.lookup if self.mode == "http" else self.fake

    # ---- checks ----

    def check(self, i: int, op: dict, expect: dict, status: int, body: Any, headers=None) -> None:
        if status != expect["status"]:
            self.fail(i, f"status {status}, expected {expect['status']}")
        if status not in op["statuses"]:
            self.fail(i, f"status {status} is not declared by the operation")
        if expect["schema"] is not None:
            errs = sorted(LOOKUP.schema_validator(expect["schema"]).iter_errors(body), key=str)
            if errs:
                self.fail(i, f"body fails {expect['schema']}: {errs[0].message}")
        for name, want in (expect.get("headers") or {}).items():
            if headers is None:
                raise NotApplicable("a header expectation needs the HTTP surface")
            got = headers.get(name)
            if (want == "present" and got is None) or (want == "absent" and got is not None) \
                    or (want not in ("present", "absent") and got != self.sub(want)):
                self.fail(i, f"header {name} is {got!r}, expected {want!r}")
        for ptr, want in (expect.get("body") or {}).items():
            got = pointer(body, ptr)
            if got is _MISSING or got != self.sub(want):
                self.fail(i, f"body {ptr} is {'(missing)' if got is _MISSING else repr(got)}, expected {self.sub(want)!r}")

    def check_frames(self, i: int, expect: dict, frames: list) -> None:
        val = LOOKUP.schema_validator(expect["schema"])
        for f in frames:
            errs = list(val.iter_errors(f))
            if errs:
                self.fail(i, f"frame fails {expect['schema']}: {errs[0].message}")
        for m in (expect.get("stream") or {}).get("match") or []:
            arr = pointer(frames, m["at"])
            where = self.sub(m["where"])
            n = sum(1 for item in arr if all(pointer(item, p) is not _MISSING and pointer(item, p) == v
                                             for p, v in where.items()))
            if "count" in m and n != m["count"]:
                self.fail(i, f"stream match {where} counts {n}, expected {m['count']}")
            if "at_least" in m and n < m["at_least"]:
                self.fail(i, f"stream match {where} counts {n}, expected at least {m['at_least']}")

    # ---- requests ----

    async def request(self, i: int, step: dict) -> None:
        req, expect = step["request"], step["expect"]
        op_id = req["operation"]
        op = LOOKUP.ops[op_id]
        token = req.get("service_token", "valid")
        if "capture" in step:
            raise NotApplicable("no lookup case captures from a response yet")
        if self.mode == "fake" and token != "valid":
            raise NotApplicable(FAKE_NO_TOKEN)
        if op_id == "lookupCaller":
            body = self.sub(req["body"])
            if self.mode == "fake":
                if req.get("invalid"):
                    raise NotApplicable("a body that breaks LookupRequest is the HTTP surface's to refuse")
                status, wire = answer_wire(await self.fake.resolve(**port_args(body)))
                self.log.append(f"fake lookup -> {status} {wire}")
                return self.check(i, op, expect, status, wire)
            r = await self.raw.post("/lookup", content=json.dumps(body).encode(),
                                    headers={"Content-Type": "application/json", **self.auth(token)})
            self.log.append(f"POST /lookup ({token} token) -> {r.status_code} {r.text[:200]}")
            try:
                parsed = r.json()
            except ValueError:
                self.fail(i, f"body is not JSON: {r.text[:100]!r}")
            self.check(i, op, expect, r.status_code, parsed, r.headers)
            if req.get("invalid"):
                return
            await self.adapter_lookup(i, op, expect, body, token)
        elif op_id == "streamRevocations":
            if self.mode == "fake":
                it = self.fake.revocations()
                try:
                    first = await asyncio.wait_for(anext(it), STREAM_BOUND_S)
                finally:
                    await it.aclose()
                self.log.append(f"fake feed -> {first}")
                if expect["status"] != 200:
                    self.fail(i, f"the fake feed opened where status {expect['status']} was expected")
                return self.check_frames(i, expect, [item_wire(first)])
            await self.raw_stream(i, op, expect, token)
            await self.adapter_feed(i, expect, token)
        else:
            raise NotApplicable(f"operation {op_id} is not mapped")

    async def adapter_lookup(self, i: int, op: dict, expect: dict, body: dict, token: str) -> None:
        before = len(self.stub.requests)
        if token == "valid":
            answer = await self.adapter.resolve(**port_args(body))
            sent = self.stub.requests[before:]
            if len(sent) != 1 or sent[0]["body"] != body or not sent[0]["auth_ok"]:
                self.fail(i, f"the adapter did not send the case's body with the service token: {sent}")
            status, wire = answer_wire(answer)
            self.log.append(f"adapter -> {answer!r}")
            return self.check(i, op, expect, status, wire)
        adapter = self.absent_adapter if token == "absent" else self.wrong_adapter
        answer = await adapter.resolve(**port_args(body))
        self.log.append(f"adapter ({token} token) -> {answer!r}")
        if answer != Denied("core_unavailable"):
            self.fail(i, f"a refused service token gave {answer!r}, expected core_unavailable (the cookie is kept)")
        if token == "absent" and len(self.stub.requests) != before:
            self.fail(i, "the adapter sent a lookup without a token")

    async def raw_stream(self, i: int, op: dict, expect: dict, token: str) -> None:
        async with self.raw.stream("GET", "/revocations", headers=self.auth(token)) as r:
            if r.status_code != 200:
                raw = await r.aread()
                self.log.append(f"GET /revocations ({token} token) -> {r.status_code} {raw[:200]!r}")
                try:
                    parsed = json.loads(raw)
                except ValueError:
                    self.fail(i, f"body is not JSON: {raw[:100]!r}")
                return self.check(i, op, expect, r.status_code, parsed, r.headers)
            if expect["status"] != 200:
                self.fail(i, f"status 200, expected {expect['status']}")
            if not r.headers.get("content-type", "").startswith("text/event-stream"):
                self.fail(i, f"content-type {r.headers.get('content-type')!r}")
            buf = b""

            async def bounded():
                nonlocal buf
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    # What the core sends first, then stop: a whole data frame, or the heartbeat after it.
                    if b": heartbeat" in buf or re.search(rb"(^|\n)data:[^\n]*\n\n", buf):
                        return
            try:
                await asyncio.wait_for(bounded(), STREAM_BOUND_S)
            except asyncio.TimeoutError:
                pass
        self.log.append(f"GET /revocations -> 200 {buf[:200]!r}")
        self.check_frames(i, expect, parse_sse(buf.split(b": heartbeat")[0]))

    async def adapter_feed(self, i: int, expect: dict, token: str) -> None:
        if token == "valid":
            it = self.adapter.revocations()
            try:
                first = await asyncio.wait_for(anext(it), STREAM_BOUND_S)
            except StopAsyncIteration:
                self.fail(i, "the adapter's feed ended before its first item")
            finally:
                await it.aclose()
            self.log.append(f"adapter feed -> {first!r}")
            if not isinstance(first, Subscribed):
                self.fail(i, f"the adapter's feed began with {first!r}, expected Subscribed")
            return self.check_frames(i, expect, [item_wire(first)])
        adapter = self.absent_adapter if token == "absent" else self.wrong_adapter
        items = []

        async def drain():
            async for item in adapter.revocations():
                items.append(item)
        try:
            await asyncio.wait_for(drain(), STREAM_BOUND_S)
        except asyncio.TimeoutError:
            self.fail(i, f"the adapter's feed with a {token} token stayed open")
        if items:
            self.fail(i, f"the adapter's feed with a {token} token yielded {items!r}")

    # ---- the run ----

    async def run(self) -> None:
        if self.mode == "fake":
            for i, step in enumerate(self.case["steps"], 1):
                if "action" in step:
                    self.act(step)
                else:
                    await self.request(i, step)
            return
        self.stub = StubCore(self.world)
        async with serve(self.stub) as base:
            self.raw = httpx.AsyncClient(base_url=base, trust_env=False, follow_redirects=False, timeout=5)
            self.adapter = HttpSessionLookup(base, self.token_file("valid", self.stub.token), timeout_s=2.0,
                                             feed_silence_s=5.0)
            self.wrong_adapter = HttpSessionLookup(
                base, self.token_file("wrong", "synthetic-wrong-token-" + secrets.token_hex(8)), timeout_s=2.0)
            self.absent_adapter = HttpSessionLookup(base, self.token_file("absent", None), timeout_s=2.0)
            try:
                for i, step in enumerate(self.case["steps"], 1):
                    if "action" in step:
                        self.act(step)
                    else:
                        await self.request(i, step)
            finally:
                for a in (self.adapter, self.wrong_adapter, self.absent_adapter):
                    await a.aclose()
                await self.raw.aclose()
