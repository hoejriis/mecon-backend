"""One-off interop run: the session-lookup v1 cases and a revocation-feed check against a REAL core.

Runs in the driver container, on the run's internal network. For each of the published cases it does what the
`http` mode of tests/lookup_replay.py does against the in-repo stub (the raw request checked against the case,
then a valid-token lookup again through `HttpSessionLookup`), but the target is the real core at CORE_LOOKUP_URL
and the world actions act on that core through the ops layer (core_ops.py). A case whose action the core cannot
do is NOT APPLICABLE with the reason; nothing is passed unrun.

Status per case: PASS, FAIL, NA, or XFAIL (a divergence the core's ops module lists, held strictly: it must
still diverge, or the case FAILs). Exit 1 on any FAIL, or when the cases were not all accounted for.

Environment: CORE_LOOKUP_URL (the core's session-lookup base, up to but not including /lookup), SERVICE_TOKEN_FILE,
FACADE_URL, OPS_SOCKET, REVOCATION_BOUND_S (default 5), ONLY (comma-separated case ids, for a partial run).
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import secrets
import sys
import tempfile
import time
from typing import Any

import httpx

from core_ops import NotApplicable as OpNotApplicable
from core_ops import OpsClient
from lookup_replay import LOOKUP, LookupReplay, port_args
from mecon_reader_backend.app import COOKIE
from mecon_reader_backend.http_lookup import HttpSessionLookup
from mecon_reader_backend.ports import Caller, Denied
from mecon_reader_backend.sessions import SessionResolver
from replay import _MISSING, CaseFailed, NotApplicable, pointer
from stub_core import answer_wire

CASE_TIMEOUT_S = 40.0
REVOCATION_CASE = "revocation-feed"
SESSION_PATH = "/api/reader/v1/session"


class InteropReplay(LookupReplay):
    def __init__(self, case: dict, tmp: pathlib.Path, ops: OpsClient, core_url: str, token_file: str,
                 divergences: dict[tuple[str, str], str], redact: set[str]):
        super().__init__(case, "http", tmp)
        self.ops, self.core_url, self.svc_token_path = ops, core_url, token_file
        self.divergences, self.held, self.redact = divergences, set(), redact

    # ---- the real core instead of the stub ----

    def auth(self, mode: str) -> dict[str, str]:
        if mode == "absent":
            return {}
        if mode == "valid":
            token = pathlib.Path(self.svc_token_path).read_text().strip()
        else:
            token = "synthetic-wrong-token-" + secrets.token_hex(8)
        return {"Authorization": "Bearer " + token}

    def act(self, step: dict) -> None:
        name, args = step["action"], self.sub(step.get("args", {}))
        if name not in LOOKUP.actions:
            raise NotApplicable(f"action {name} is not mapped")
        captured = None
        try:
            if name == "issue-session":
                captured = self.ops.issue_session(args["user"])
            elif name == "expire-session":
                self.ops.expire_session(args["credential"])
            elif name == "revoke-session":
                self.ops.revoke_session(args["credential"])
            elif name == "csrf-for":
                captured = self.ops.csrf_for(args["credential"])
            elif name == "core-degraded":
                self.ops.core_degraded()
            elif name == "core-recovered":
                self.ops.core_recovered()
        except OpNotApplicable as e:
            raise NotApplicable(f"{name}: {e}") from None
        if captured is not None:
            self.redact.add(captured)
        if "capture" in step:
            if captured is None:
                raise CaseFailed(f"action {name} captures nothing")
            self.captures[step["capture"]] = captured

    def check(self, i, op, expect, status, body, headers=None) -> None:
        if status != expect["status"]:
            self.fail(i, f"status {status}, expected {expect['status']}")
        if status not in op["statuses"]:
            self.fail(i, f"status {status} is not declared by the operation")
        if expect["schema"] is not None:
            errs = sorted(LOOKUP.schema_validator(expect["schema"]).iter_errors(body), key=str)
            if errs:
                self.fail(i, f"body fails {expect['schema']}: {errs[0].message}")
        for name, want in (expect.get("headers") or {}).items():
            got = headers.get(name) if headers is not None else None
            if (want == "present" and got is None) or (want == "absent" and got is not None) \
                    or (want not in ("present", "absent") and got != self.sub(want)):
                self.fail(i, f"header {name} is {got!r}, expected {want!r}")
        for ptr, want in (expect.get("body") or {}).items():
            got, want = pointer(body, ptr), self.sub(want)
            diverges = (self.case["id"], ptr) in self.divergences
            same = got is not _MISSING and got == want
            if diverges:
                if same:
                    self.fail(i, f"body {ptr} no longer diverges ({got!r}); drop it from the core's known divergences")
                self.held.add(ptr)
            elif not same:
                self.fail(i, f"body {ptr} is {'(missing)' if got is _MISSING else repr(got)}, expected {want!r}")

    async def adapter_lookup(self, i, op, expect, body, token) -> None:
        if token == "valid":
            answer = await self.adapter.resolve(**port_args(body))
            status, wire = answer_wire(answer)
            self.log.append(f"adapter -> {answer!r}")
            return self.check(i, op, expect, status, wire)
        adapter = self.absent_adapter if token == "absent" else self.wrong_adapter
        answer = await adapter.resolve(**port_args(body))
        self.log.append(f"adapter ({token} token) -> {answer!r}")
        if answer != Denied("core_unavailable"):
            self.fail(i, f"a refused service token gave {answer!r}, expected core_unavailable (the cookie is kept)")

    async def run(self) -> None:
        self.raw = httpx.AsyncClient(base_url=self.core_url, trust_env=False, follow_redirects=False, timeout=5)
        self.adapter = HttpSessionLookup(self.core_url, self.svc_token_path, timeout_s=2.0, feed_silence_s=5.0)
        self.wrong_adapter = HttpSessionLookup(
            self.core_url, self.token_file("wrong", "synthetic-wrong-token-" + secrets.token_hex(8)), timeout_s=2.0)
        self.absent_adapter = HttpSessionLookup(self.core_url, self.token_file("absent", None), timeout_s=2.0)
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
        unseen = {p for (c, p) in self.divergences if c == self.case["id"]} - self.held
        if unseen:
            raise CaseFailed(f"{self.case['id']}: listed divergence(s) never observed: {sorted(unseen)}")


# ---- the revocation-feed case ----

async def revocation_case(ops: OpsClient, core_url: str, token_file: str, facade_url: str | None, bound_s: float,
                          redact: set[str]) -> str:
    """A session cached as a read is signed out on the core; the feed must drop it, not the cache expiring.

    A: the facade's SessionResolver over the real adapter, cache 30 s. After the sign-out the cache entry must be
       gone within `bound_s` (nothing but a revocation item removes it that early), and the next read is Denied.
    B: the same through the running facade (its cache is also 30 s): GET /session answers 200 while the session
       lives, and 401 within `bound_s` of the sign-out.
    """
    notes = []
    # A
    cred = ops.issue_session("alice")
    redact.add(cred)
    lookup = HttpSessionLookup(core_url, token_file, timeout_s=2.0, feed_silence_s=50.0)
    resolver = SessionResolver(lookup, cache_s=30.0, feed_retry_s=0.5)
    try:
        deadline = time.monotonic() + 10
        while True:
            answer = await resolver.resolve(cred, "read")
            if not isinstance(answer, Caller):
                raise CaseFailed(f"A: a live session was answered {answer!r}")
            if resolver.feed_up and cred in resolver._cache:
                break
            if time.monotonic() > deadline:
                raise CaseFailed("A: the session was never cached (the feed never said subscribed?)")
            await asyncio.sleep(0.2)
        t0 = time.monotonic()
        await asyncio.to_thread(ops.revoke_session, cred)
        while cred in resolver._cache and time.monotonic() - t0 < bound_s:
            await asyncio.sleep(0.05)
        dropped = time.monotonic() - t0
        if cred in resolver._cache:
            raise CaseFailed(f"A: still cached {dropped:.1f}s after the sign-out (the feed did not drop it)")
        nxt = await resolver.resolve(cred, "read")
        if nxt != Denied("revoked"):
            raise CaseFailed(f"A: the next read after the sign-out gave {nxt!r}, expected Denied('revoked')")
        notes.append(f"A cache dropped {dropped:.2f}s after sign-out, next read revoked")
    finally:
        if resolver._feed_task is not None:
            resolver._feed_task.cancel()
        await lookup.aclose()
    # B
    if facade_url:
        cred2 = ops.issue_session("alice")
        redact.add(cred2)
        async with httpx.AsyncClient(base_url=facade_url, trust_env=False, timeout=5,
                                     headers={"Cookie": f"{COOKIE}={cred2}"}) as c:
            for _ in range(8):  # the first request starts the facade's feed; later ones are cached once it is up
                r = await c.get(SESSION_PATH)
                if r.status_code != 200:
                    raise CaseFailed(f"B: a live session gave {r.status_code} through the facade")
                await asyncio.sleep(0.4)
            t0 = time.monotonic()
            await asyncio.to_thread(ops.revoke_session, cred2)
            status = 200
            while status == 200 and time.monotonic() - t0 < bound_s:
                status = (await c.get(SESSION_PATH)).status_code
                await asyncio.sleep(0.1)
            took = time.monotonic() - t0
            if status != 401:
                raise CaseFailed(f"B: the facade still answered {status} {took:.1f}s after the sign-out, expected 401")
            notes.append(f"B facade 401 {took:.2f}s after sign-out")
    else:
        notes.append("B skipped (no FACADE_URL)")
    return "; ".join(notes)


# ---- the run ----

def scrub(text: str, secrets_: set[str]) -> str:
    for s in secrets_:
        if len(s) >= 8:
            text = text.replace(s, "<redacted>")
    return text


async def main() -> int:
    core_url = os.environ["CORE_LOOKUP_URL"].rstrip("/")
    token_file = os.environ["SERVICE_TOKEN_FILE"]
    facade_url = os.environ.get("FACADE_URL")
    bound_s = float(os.environ.get("REVOCATION_BOUND_S", "5"))
    only = {x for x in os.environ.get("ONLY", "").split(",") if x}
    ops = OpsClient(os.environ["OPS_SOCKET"])
    ops.setup()
    desc = ops.describe()
    divergences = {(d["case"], d["pointer"]): d["reason"] for d in desc.get("known_divergences", [])}
    cases = [c for _, c in LOOKUP.load_cases()]
    results: list[tuple[str, str, str]] = []
    redact: set[str] = set()
    with tempfile.TemporaryDirectory() as td:
        for case in cases:
            if only and case["id"] not in only:
                continue
            tmp = pathlib.Path(td) / case["id"]
            tmp.mkdir()
            r = InteropReplay(case, tmp, ops, core_url, token_file, divergences, redact)
            try:
                await asyncio.wait_for(r.run(), CASE_TIMEOUT_S)
                held = [p for (c, p) in divergences if c == case["id"]]
                if held:
                    results.append((case["id"], "XFAIL", "; ".join(f"{p}: {divergences[(case['id'], p)]}" for p in held)))
                else:
                    results.append((case["id"], "PASS", case["title"]))
            except NotApplicable as e:
                results.append((case["id"], "NA", str(e)))
            except (CaseFailed, AssertionError) as e:
                results.append((case["id"], "FAIL", str(e)))
            except Exception as e:  # noqa: BLE001 - an unexpected error is a failure, never a pass
                results.append((case["id"], "FAIL", f"{type(e).__name__}: {e}"))
        if not only or REVOCATION_CASE in only:
            try:
                note = await asyncio.wait_for(revocation_case(ops, core_url, token_file, facade_url, bound_s, redact), 60)
                results.append((REVOCATION_CASE, "PASS", note))
            except OpNotApplicable as e:
                results.append((REVOCATION_CASE, "NA", str(e)))
            except Exception as e:  # noqa: BLE001
                results.append((REVOCATION_CASE, "FAIL", f"{type(e).__name__}: {e}"))
    counts = {k: sum(1 for _, s, _ in results if s == k) for k in ("PASS", "FAIL", "NA", "XFAIL")}
    for cid, status, detail in results:
        print(scrub(f"{status:<5} {cid}: {detail}", redact))
    expected = (len(only) if only else len(cases) + 1)
    print(f"TOTAL cases={len(results)} PASS={counts['PASS']} FAIL={counts['FAIL']} NA={counts['NA']} "
          f"XFAIL={counts['XFAIL']} (expected {expected} cases)")
    if len(results) != expected:
        print("FAIL: not every case was accounted for")
        return 1
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
