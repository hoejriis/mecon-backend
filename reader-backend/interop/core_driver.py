"""One-off interop run: every reader-core v1 case, through `HttpReaderCore`, against a REAL core over HTTP.

Runs in the driver container on the run's internal network. For each case in contracts/reader-core/v1/cases it does
what the `adapter` target of tests/core_replay.py does against the in-repo stub: each request is sent raw, as the
case writes it, and the answer is checked against the case; then the same request is sent again through the real
adapter (`HttpReaderCore`, as the facade uses it) from the world as it was before the raw request, and the
adapter's answer, turned back into the contract's status and body, must meet the same expectation. The real core
replaces the stub, so:

- the world (`worlds.json`) is built inside the core by the ops layer (core_ops.py, supplied by whoever runs this,
  acting inside the core's own process and database), once per case, and every world action goes through it;
- the stub's "what did the adapter send" record is replaced by an httpx request hook on the adapter's client;
- the stub's world snapshots are replaced by ops snapshot/restore of the core's database.

Ops this driver calls (the module's `make_ops()` object; an op it cannot do raises NotApplicable(reason), which
makes every case needing it NOT APPLICABLE with that reason, never a pass):
    reset_world(world)            a fresh copy of the named world, both switches as the world says
    issue_session(user) -> str    a live session for the user; returns its `session_ref` only
    user_id(user) -> str          the user's id as the contract writes it
    end_session(session_ref), expire_session(session_ref)
    login_mark() -> int, login_noted(request_id, mark)    let the ops layer find the login link a start sent
    approve_login(request_id)     open that link, as the person would
    exhaust_login_limit(client_address), set_switch(switch, value), age_out_events()
    core_degraded(), core_recovered()
    snapshot(name), restore(name) the core's database, so the adapter's repeat of a request starts from the same world

Status per case: PASS, FAIL, NA. Exit 1 on any FAIL, or when the cases were not all accounted for.

Environment: CORE_URL (the core's reader-core base, up to but not including /reader), SERVICE_TOKEN_FILE,
OPS_SOCKET, ONLY (comma-separated case ids, for a partial run).
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import secrets
import sys
import tempfile
from urllib.parse import urlsplit

import httpx

from core_ops import NotApplicable as OpNotApplicable
from core_ops import OpsClient
from core_replay import ADAPTER, ADAPTER_UNAVAILABLE, CoreReplay
from mecon_reader_backend.http_core import HttpReaderCore
from replay import CaseFailed, NotApplicable
from stub_reader_core import CORE, dispatch

CASE_TIMEOUT_S = 90.0


class Recorder:
    """What an adapter's client sent, from an httpx request hook: method, path, JSON body, whether it carried a token."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def hook(self, request: httpx.Request) -> None:
        try:
            body = json.loads(request.content) if request.content else None
        except ValueError:
            body = "<not json>"
        self.sent.append({"method": request.method, "path": request.url.path, "body": body,
                          "has_auth": request.headers.get("authorization", "").lower().startswith("bearer ")})


class RealCoreReplay(CoreReplay):
    def __init__(self, case: dict, tmp: pathlib.Path, ops: OpsClient, core_url: str, token_path: str):
        super().__init__(case, ADAPTER, tmp)
        self.ops, self.core_url, self.token_path = ops, core_url, token_path
        self.base_path = urlsplit(core_url).path.rstrip("/")
        self.snaps = 0
        self.recorders: dict[str, Recorder] = {}

    # ---- the world, in the real core ----

    def snapshot(self) -> str:
        self.snaps += 1
        name = f"s{self.snaps}"
        self.ops.call("snapshot", name=name)
        return name

    def restore(self, name: str) -> None:
        self.ops.call("restore", name=name)

    def act(self, step: dict) -> None:
        name, args = step["action"], self.sub(step.get("args", {}))
        if name not in CORE.actions:
            raise NotApplicable(f"action {name} is not mapped")
        captured = None
        try:
            if name == "issue-session":
                captured = self.ops.call("issue_session", user=args["user"])
            elif name == "user-id":
                captured = self.ops.call("user_id", user=args["user"])
            elif name == "end-session":
                self.ops.call("end_session", session_ref=args["session_ref"])
            elif name == "expire-session":
                self.ops.call("expire_session", session_ref=args["session_ref"])
            elif name == "approve-login":
                self.ops.call("approve_login", request_id=args["request_id"])
            elif name == "exhaust-login-limit":
                self.ops.call("exhaust_login_limit", client_address=args["client_address"])
            elif name == "set-switch":
                self.ops.call("set_switch", switch=args["switch"], value=args["value"])
            elif name == "age-out-events":
                self.ops.call("age_out_events")
            elif name == "core-degraded":
                self.ops.call("core_degraded")
            elif name == "core-recovered":
                self.ops.call("core_recovered")
        except OpNotApplicable as e:
            raise NotApplicable(f"{name}: {e}") from None
        if "capture" in step:
            if captured is None:
                raise CaseFailed(f"action {name} captures nothing")
            self.captures[step["capture"]] = captured

    # ---- requests: raw, then through the adapter ----

    async def request(self, i: int, step: dict) -> None:
        req, expect = step["request"], step["expect"]
        op_id = req["operation"]
        op = CORE.ops[op_id]
        token = req.get("service_token", "valid")
        body = self.sub(req["body"]) if "body" in req else None
        headers = {}
        if token == "valid":
            headers["Authorization"] = "Bearer " + pathlib.Path(self.token_path).read_text().strip()
        elif token == "wrong":
            headers["Authorization"] = "Bearer synthetic-wrong-token-" + secrets.token_hex(8)
        content = None
        if body is not None:
            content = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        mark = self.ops.call("login_mark") if op_id == "startLogin" else None
        r = await self.raw.request(op["method"], op["path"], headers=headers, content=content)
        self.log.append(f"{op['method']} {op['path']} ({token} token) -> {r.status_code} {r.text[:300]}")
        got = self.check(i, op, expect, r.status_code, r.headers, r.content)
        if op_id == "startLogin" and r.status_code == 202:
            self.ops.call("login_noted", request_id=got["request_id"], mark=mark)
        await self.through_adapter(i, op, op_id, expect, body, token, req.get("invalid", False))
        for name, sel in (step.get("capture") or {}).items():
            self.captures[name] = self.select(i, got, sel)

    async def through_adapter(self, i: int, op: dict, op_id: str, expect: dict, body: dict | None, token: str,
                              invalid: bool) -> None:
        if invalid:
            self.raw_only_steps.append(i)
            return
        after = self.snapshot()
        self.restore(self.before)
        adapter = {"valid": self.adapter, "wrong": self.wrong_adapter, "absent": self.absent_adapter}[token]
        rec = self.recorders[token]
        sent_from = len(rec.sent)
        status, wire = await dispatch(adapter, op_id, body)
        sent = rec.sent[sent_from:]
        self.restore(after)
        raw = b"" if wire is None else json.dumps(wire).encode()
        self.log.append(f"adapter {op_id} ({token} token) -> {status} {raw[:300]!r}")
        self.adapter_steps += 1
        if token == "absent":
            if sent:
                self.fail(i, f"the adapter sent a request without a token: {sent}")
        elif len(sent) != 1 or sent[0]["method"] != op["method"] or sent[0]["path"] != self.base_path + op["path"] \
                or self.normalised(sent[0]["body"]) != self.normalised(body) or not sent[0]["has_auth"]:
            self.fail(i, f"the adapter did not send the case's request: {sent}, expected {op['method']} "
                         f"{self.base_path + op['path']} with {body} and a bearer token")
        self.check(i, op, ADAPTER_UNAVAILABLE if token != "valid" else expect, status, None, raw)

    async def run(self) -> None:
        self.ops.call("reset_world", world=self.case["world"])
        self.raw = httpx.AsyncClient(base_url=self.core_url, trust_env=False, follow_redirects=False, timeout=40)
        clients = []

        def adapter_for(name: str, token_path) -> HttpReaderCore:
            rec = Recorder()
            self.recorders[name] = rec
            client = httpx.AsyncClient(follow_redirects=False, trust_env=False, event_hooks={"request": [rec.hook]})
            clients.append(client)
            return HttpReaderCore(self.core_url, token_path, timeout_s=15.0, client=client)

        self.adapter = adapter_for("valid", self.token_path)
        self.wrong_adapter = adapter_for(
            "wrong", self.token_file("wrong", "synthetic-wrong-token-" + secrets.token_hex(8)))
        self.absent_adapter = adapter_for("absent", self.token_file("absent", None))
        try:
            for i, step in enumerate(self.case["steps"], 1):
                if "action" in step:
                    self.act(step)
                else:
                    self.before = self.snapshot()
                    await self.request(i, step)
        finally:
            try:
                self.ops.call("core_recovered")
            except Exception:  # noqa: BLE001 - best effort; the next case resets the world anyway
                pass
            for c in clients:
                await c.aclose()
            await self.raw.aclose()


def scrub(text: str) -> str:
    return re.sub(r'("credential"\s*:\s*")[^"]+', r"\1<redacted>", text)


async def main() -> int:
    core_url = os.environ["CORE_URL"].rstrip("/")
    token_path = os.environ["SERVICE_TOKEN_FILE"]
    only = {x for x in os.environ.get("ONLY", "").split(",") if x}
    ops = OpsClient(os.environ["OPS_SOCKET"], timeout_s=60.0)
    cases = [c for _, c in CORE.load_cases()]
    results: list[tuple[str, str, str]] = []
    adapter_steps = raw_only = 0
    with tempfile.TemporaryDirectory() as td:
        for case in cases:
            if only and case["id"] not in only:
                continue
            tmp = pathlib.Path(td) / case["id"]
            tmp.mkdir()
            r = RealCoreReplay(case, tmp, ops, core_url, token_path)
            try:
                await asyncio.wait_for(r.run(), CASE_TIMEOUT_S)
                results.append((case["id"], "PASS", f"{case['title']} (adapter steps {r.adapter_steps}, "
                                                    f"raw-only steps {len(r.raw_only_steps)})"))
            except (NotApplicable, OpNotApplicable) as e:
                results.append((case["id"], "NA", str(e)))
            except (CaseFailed, AssertionError) as e:
                results.append((case["id"], "FAIL", str(e)))
            except Exception as e:  # noqa: BLE001 - an unexpected error is a failure, never a pass
                results.append((case["id"], "FAIL", f"{type(e).__name__}: {e}"))
            adapter_steps += r.adapter_steps
            raw_only += len(r.raw_only_steps)
    counts = {k: sum(1 for _, s, _ in results if s == k) for k in ("PASS", "FAIL", "NA")}
    for cid, status, detail in results:
        print(scrub(f"{status:<5} {cid}: {detail}"))
    expected = len(only) if only else len(cases)
    print(f"TOTAL cases={len(results)} PASS={counts['PASS']} FAIL={counts['FAIL']} NA={counts['NA']} "
          f"(expected {expected} cases); requests sent through the adapter={adapter_steps}, raw only={raw_only}")
    if len(results) != expected:
        print("FAIL: not every case was accounted for")
        return 1
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
