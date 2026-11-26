"""Replays the published Reader API cases (contracts/reader-api/v1/cases) against the facade.

The case files are read where they are published, never copied. Each case gets a fresh world from
worlds.json behind the fake adapters and is replayed per the cases README: clients are cookie jars,
`${name}` substitutes captures, Origin and CSRF modes are applied, and every expectation is checked
in order; the first unmet one fails the case.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable
from urllib.parse import quote, urlencode

import httpx
import yaml
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from mecon_reader_backend import FacadeConfig, create_app
from mecon_reader_backend.app import COOKIE, PREFIX
from mecon_reader_backend.fakes import build, build_observations
from mecon_reader_backend.observations import PREFIX as OBS_PREFIX

REPO = pathlib.Path(__file__).resolve().parents[2]
BASE = "https://reader.example.test"
SAME_ORIGIN = BASE
FOREIGN_ORIGIN = "https://foreign.example.test"
LEASE_PREFIX = b"MECON-LEASE-1\x00"
NO_SESSION_CSRF = "csrf_synthetic_no_session"


class CaseFailed(AssertionError):
    pass


class NotApplicable(Exception):
    pass


@dataclass
class Contract:
    """One published contract the runner replays: its OpenAPI document, cases directory and case files, the URL
    prefix its operations are served under, the world actions it maps, and how to build a world behind the app."""

    name: str
    root: pathlib.Path
    case_files: tuple[str, ...]
    prefix: str
    actions: tuple[str, ...]
    build: Callable[[dict], tuple[Any, Any, Any, dict]]  # world description -> (world, lookup, core, create_app kwargs)
    cases_dir: pathlib.Path = field(init=False)
    openapi: dict = field(init=False)
    worlds: dict = field(init=False)
    ops: dict[str, dict] = field(init=False)

    def __post_init__(self) -> None:
        self.cases_dir = self.root / "cases"
        self.openapi = yaml.safe_load((self.root / "openapi.yaml").read_text(encoding="utf-8"))
        self.worlds = json.loads((self.cases_dir / "worlds.json").read_text(encoding="utf-8"))
        self._registry = Registry().with_resource(
            f"urn:{self.name}", Resource.from_contents(self.openapi, default_specification=DRAFT202012))
        self.ops = self.operations()

    def schema_validator(self, name: str) -> Draft202012Validator:
        return Draft202012Validator({"$ref": f"urn:{self.name}#/components/schemas/{name}"}, registry=self._registry,
                                    format_checker=Draft202012Validator.FORMAT_CHECKER)

    def operations(self) -> dict[str, dict]:
        """operationId -> {method, path, csrf, statuses}."""
        out = {}
        for path, item in self.openapi["paths"].items():
            for method, op in item.items():
                params = op.get("parameters", [])
                csrf = any(p.get("$ref", "").endswith("/Csrf") or p.get("name") == "X-CSRF-Token" for p in params)
                out[op["operationId"]] = {"method": method.upper(), "path": path, "csrf": csrf,
                                          "statuses": {int(s) for s in op["responses"]}}
        return out

    def streams(self) -> set[str]:
        """The operations whose 200 is a server-sent event stream."""
        return {op_id for path, item in self.openapi["paths"].items() for op in item.values()
                for op_id in [op["operationId"]]
                if "text/event-stream" in op["responses"].get("200", {}).get("content", {})}

    def load_cases(self) -> list[tuple[str, dict]]:
        cases = []
        for f in self.case_files:
            doc = json.loads((self.cases_dir / f"{f}.json").read_text(encoding="utf-8"))
            cases += [(f, c) for c in doc["cases"]]
        return cases

    def case_files_on_disk(self) -> list[str]:
        return sorted(p.stem for p in self.cases_dir.glob("*.json") if p.stem not in ("worlds", "cases.schema"))


READER = Contract("reader-api", REPO / "contracts" / "reader-api" / "v1",
                  ("session", "devices", "messaging", "send", "events", "leases"), PREFIX,
                  ("sign-in", "approve-login", "set-switch", "events-checkpoint", "age-out-events",
                   "rotate-lease-key", "revoke-lease-keys", "end-session", "session-authority-down",
                   "session-authority-up"),
                  lambda desc: (*build(desc), {}))
OBSERVATIONS = Contract("mecon-observations", REPO / "contracts" / "observations" / "v1", ("observations",),
                        OBS_PREFIX, ("sign-in", "end-session", "add-reception", "age-out-events"),
                        build_observations)

# The Reader API's names, kept for the tests written before the runner took a contract.
CONTRACT, CASES_DIR, CASE_FILES = READER.root, READER.cases_dir, READER.case_files
OPENAPI, WORLDS, OPS = READER.openapi, READER.worlds, READER.ops
schema_validator = READER.schema_validator
load_cases, case_files_on_disk = READER.load_cases, READER.case_files_on_disk


# ---- JSON pointers ----

_MISSING = object()


def pointer(doc: Any, ptr: str) -> Any:
    if ptr == "":
        return doc
    cur = doc
    for raw in ptr.split("/")[1:]:
        tok = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            if not tok.isdigit() or int(tok) >= len(cur):
                return _MISSING
            cur = cur[int(tok)]
        elif isinstance(cur, dict):
            if tok not in cur:
                return _MISSING
            cur = cur[tok]
        else:
            return _MISSING
    return cur


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---- the replay ----

class Replay:
    def __init__(self, case: dict, *, contract: Contract = READER, config: FacadeConfig | None = None,
                 stream_bound_s: float = 2.0):
        self.case = case
        self.contract = contract
        desc = contract.worlds["worlds"][case["world"]]
        self.world, self.lookup, self.core, ports = contract.build(desc)
        self.world.reader_origins = (SAME_ORIGIN,)
        self.app = create_app(self.lookup, self.core, config or FacadeConfig(reader_origins=(SAME_ORIGIN,)), **ports)
        self.captures: dict[str, Any] = {}
        self.clients: dict[str, httpx.AsyncClient] = {}
        self.stream_bound_s = stream_bound_s
        self.log: list[str] = []
        self.operations_seen: set[str] = set()
        self.csrf_tokens: dict[int, str] = {}  # per client: the last token GET /session returned

    def client(self, name: str | None) -> httpx.AsyncClient:
        if name is None:
            return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=BASE)
        if name not in self.clients:
            self.clients[name] = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=BASE)
        return self.clients[name]

    # substitution
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

    def fail(self, step: int, msg: str) -> None:
        raise CaseFailed(f"{self.case['id']} step {step}: {msg}\n" + "\n".join(self.log[-6:]))

    # actions (each contract names the ones it maps: Contract.actions)
    def act(self, step: dict) -> None:
        name, args = step["action"], self.sub(step.get("args", {}))
        w = self.world
        if name not in self.contract.actions:
            raise NotApplicable(f"action {name} is not mapped for {self.contract.name}")
        if name == "sign-in":
            s = w.mint_session(args["user"])
            c = self.client(args["client"])
            c.cookies.set(COOKIE, s.credential, domain="reader.example.test", path="/")
        elif name == "approve-login":
            self.core.approve_login(args["request_id"])
        elif name == "set-switch":
            if args["switch"] not in ("sending", "lease_signing"):
                raise NotApplicable(f"unknown switch {args['switch']}")
            w.switches[args["switch"]] = args["value"]
        elif name == "events-checkpoint":
            self.captures[step["capture"]] = self.core.checkpoint()
        elif name == "add-reception":
            w.add_reception(args["observer"], args["packet"], args["rssi"])
        elif name == "age-out-events":
            w.age_out()
        elif name == "rotate-lease-key":
            w.rotate_lease_key()
        elif name == "revoke-lease-keys":
            w.revoke_lease_keys()
        elif name == "end-session":
            # The session this client's cookie names ends on the server; the client keeps the cookie.
            cred = self.client(args["client"]).cookies.get(COOKIE)
            if cred is None or cred not in w.sessions:
                raise CaseFailed(f"end-session: client {args['client']} holds no session")
            w.revoke(w.sessions[cred], "ended")
        elif name == "session-authority-down":
            self.lookup.unavailable = True
            self.app.state.sessions.drop_cache()  # cached answers are dropped, as if they had timed out
        elif name == "session-authority-up":
            self.lookup.unavailable = False
        else:
            raise NotApplicable(f"action {name} is not mapped")
        if "capture" in step and name != "events-checkpoint":
            raise NotApplicable(f"action {name} does not capture")

    async def csrf_token(self, client: httpx.AsyncClient) -> str | None:
        # The client's token from GET /session; the last one it read when GET /session cannot answer.
        r = await client.get(PREFIX + "/session", headers={"Origin": SAME_ORIGIN})
        if r.status_code == 200:
            self.csrf_tokens[id(client)] = r.json()["csrf_token"]
            return self.csrf_tokens[id(client)]
        if r.status_code == 401:
            self.csrf_tokens.pop(id(client), None)
            return None
        return self.csrf_tokens.get(id(client))

    async def request(self, i: int, step: dict) -> None:
        req = step["request"]
        op_id = req["operation"]
        op = self.contract.ops[op_id]
        self.operations_seen.add(op_id)
        anon = "as" not in step
        client = self.client(step.get("as"))
        try:
            path = op["path"]
            for k, val in (req.get("path") or {}).items():
                path = path.replace("{" + k + "}", quote(str(self.sub(val)), safe=""))
            url = self.contract.prefix + path
            query = {k: str(self.sub(x)) for k, x in (req.get("query") or {}).items()}
            if query:
                url += "?" + urlencode(query)
            headers = {k: str(self.sub(x)) for k, x in (req.get("headers") or {}).items()}
            origin = req.get("origin", "same")
            if origin == "same":
                headers["Origin"] = SAME_ORIGIN
            elif origin == "foreign":
                headers["Origin"] = FOREIGN_ORIGIN
            if op["csrf"]:
                mode = req.get("csrf", "valid")
                token = await self.csrf_token(client)
                if token is None and mode in ("valid", "wrong"):
                    # No session to take a token from: a made-up one of valid form, which a Backend cannot
                    # judge without resolving the session (the cases pin no CSRF-versus-session order).
                    headers["X-CSRF-Token"] = NO_SESSION_CSRF
                elif mode == "valid":
                    headers["X-CSRF-Token"] = token
                elif mode == "wrong":
                    headers["X-CSRF-Token"] = ("x" if token[0] != "x" else "y") + token[1:]
            content = None
            if "body" in req:
                content = json.dumps(self.sub(req["body"])).encode()
                headers["Content-Type"] = "application/json"
            expect = step["expect"]
            if op_id in self.contract.streams():
                status, resp_headers, raw = await self.stream(client, url, headers)
                self.log.append(f"{op_id} {url} -> {status}")
                await self.check_stream(i, op, expect, status, resp_headers, raw)
                body = None
            else:
                r = await client.request(op["method"], url, headers=headers, content=content)
                self.log.append(f"{op['method']} {url} -> {r.status_code} {r.text[:300]}")
                body = self.check(i, op, expect, r.status_code, r.headers, r.content)
            if "capture" in step:
                for name, sel in step["capture"].items():
                    self.captures[name] = self.select(i, body, sel)
        finally:
            if anon:
                await client.aclose()

    async def stream(self, client: httpx.AsyncClient, url: str, headers: dict[str, str]):
        cookie = "; ".join(f"{c.name}={c.value}" for c in client.cookies.jar)
        hdrs = dict(headers)
        if cookie:
            hdrs["Cookie"] = cookie
        return await asgi_get_stream(self.app, url, hdrs, bound_s=self.stream_bound_s, until_heartbeat=True)

    # checks
    def check_headers(self, i: int, expect: dict, headers) -> None:
        for name, want in (expect.get("headers") or {}).items():
            got = headers.get(name)
            if want == "present":
                if got is None:
                    self.fail(i, f"header {name} absent, expected present")
            elif want == "absent":
                if got is not None:
                    self.fail(i, f"header {name} present ({got!r}), expected absent")
            elif got != self.sub(want):
                self.fail(i, f"header {name} is {got!r}, expected {want!r}")

    def check(self, i: int, op: dict, expect: dict, status: int, headers, raw: bytes) -> Any:
        if status != expect["status"]:
            self.fail(i, f"status {status}, expected {expect['status']}")
        if status not in op["statuses"]:
            self.fail(i, f"status {status} is not declared by the operation")
        body = None
        if expect["schema"] is None:
            if raw:
                self.fail(i, f"a body where none is declared: {raw[:100]!r}")
        else:
            try:
                body = json.loads(raw)
            except ValueError:
                self.fail(i, f"body is not JSON: {raw[:100]!r}")
            errs = sorted(self.contract.schema_validator(expect["schema"]).iter_errors(body), key=str)
            if errs:
                self.fail(i, f"body fails {expect['schema']}: {errs[0].message}")
        self.check_headers(i, expect, headers)
        for ptr, want in (expect.get("body") or {}).items():
            got = pointer(body, ptr)
            if got is _MISSING or got != self.sub(want):
                self.fail(i, f"body {ptr} is {got if got is not _MISSING else '(missing)'!r}, expected {self.sub(want)!r}")
        for m in expect.get("match") or []:
            self.check_match(i, pointer(body, m["at"]), m)
        for c in expect.get("ids") or []:
            self.check_ids(i, body, c)
        if "lease" in expect:
            self.check_lease(i, body, expect["lease"])
        return body

    def check_ids(self, i: int, body: Any, c: dict) -> None:
        """The observation cases' `ids` expectation (contracts/observations/v1/cases/README.md, "Id form checks")."""
        arr = pointer(body, c["at"])
        if not isinstance(arr, list):
            self.fail(i, f"ids at {c['at']!r}: not an array")
        pairs = [(item, pointer(item, c["field"])) for item in arr]
        pairs = [(item, v) for item, v in pairs if v is not _MISSING]
        if not pairs:
            self.fail(i, f"ids: no item at {c['at']!r} has {c['field']!r}")
        if c.get("unsequenced"):
            values = sorted({str(v) for _, v in pairs})
            if len(values) < 2:
                self.fail(i, f"ids: unsequenced needs two distinct ids, got {values!r}")
            common = os.path.commonprefix(values)
            if all(v[len(common):] == "" or v[len(common):].isdecimal() for v in values):
                self.fail(i, f"ids {values!r} differ only by a counter")
        for other in c.get("unlike") or []:
            for item, v in pairs:
                o = pointer(item, other)
                if o is not _MISSING and id_form(str(v)) == id_form(str(o)):
                    self.fail(i, f"ids: {c['field']} {v!r} shares its form with {other} {o!r}")

    def check_match(self, i: int, arr: Any, m: dict) -> None:
        if not isinstance(arr, list):
            self.fail(i, f"match at {m['at']!r}: not an array")
        where = self.sub(m["where"])
        n = sum(1 for item in arr if all(pointer(item, p) is not _MISSING and pointer(item, p) == val
                                         for p, val in where.items()))
        if "count" in m and n != m["count"]:
            self.fail(i, f"match {where} counts {n}, expected {m['count']}")
        if "at_least" in m and n < m["at_least"]:
            self.fail(i, f"match {where} counts {n}, expected at least {m['at_least']}")

    async def check_stream(self, i: int, op: dict, expect: dict, status: int, headers, raw: bytes) -> None:
        if status != expect["status"]:
            self.fail(i, f"status {status}, expected {expect['status']}")
        if status != 200:
            self.check(i, op, expect, status, headers, raw)
            return
        self.check_headers(i, expect, headers)
        ctype = headers.get("content-type", "")
        if not ctype.startswith("text/event-stream"):
            self.fail(i, f"content-type {ctype!r}")
        frames = parse_sse(raw)
        val = self.contract.schema_validator(expect["schema"])
        for f in frames:
            errs = list(val.iter_errors(f))
            if errs:
                self.fail(i, f"frame fails {expect['schema']}: {errs[0].message}")
        for m in (expect.get("stream") or {}).get("match") or []:
            self.check_match(i, frames, m)

    def check_lease(self, i: int, body: Any, rule: dict) -> None:
        rule = self.sub(rule)
        token = rule.get("token", pointer(body, "/lease"))
        keys = rule["keys"]
        keys = pointer(body, keys) if isinstance(keys, str) and keys.startswith("/") else keys
        if not isinstance(token, str) or token.count(".") != 1:
            self.fail(i, "lease token malformed")
        p64, s64 = token.split(".")
        payload_bytes, sig = b64u_decode(p64), b64u_decode(s64)
        # The key id is read before verification only to pick the key; nothing else is trusted yet.
        kid = json.loads(payload_bytes).get("key_id")
        key = next((k for k in keys if k.get("key_id") == kid), None)
        if key is None:
            self.fail(i, f"lease key {kid!r} is not in the served keys")
        try:
            Ed25519PublicKey.from_public_bytes(b64u_decode(key["public_key"])).verify(sig, LEASE_PREFIX + payload_bytes)
        except InvalidSignature:
            self.fail(i, "lease signature does not verify")
        payload = json.loads(payload_bytes)
        errs = list(self.contract.schema_validator("LeasePayload").iter_errors(payload))
        if errs:
            self.fail(i, f"lease payload fails LeasePayload: {errs[0].message}")
        if "user_id" in rule and payload["user_id"] != rule["user_id"]:
            self.fail(i, f"lease user_id {payload['user_id']!r}, expected {rule['user_id']!r}")
        life = (datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
                - datetime.fromisoformat(payload["issued_at"].replace("Z", "+00:00"))).total_seconds()
        if "max_lifetime_s" in rule and not 0 < life <= rule["max_lifetime_s"]:
            self.fail(i, f"lease lifetime {life}s, expected at most {rule['max_lifetime_s']}")
        for ident in payload["identities"]:
            ops = set(ident["operations"])
            missing = set(rule.get("operations_include", [])) - ops
            extra = set(rule.get("operations_exclude", [])) & ops
            if missing:
                self.fail(i, f"lease identity lacks {sorted(missing)}")
            if extra:
                self.fail(i, f"lease identity has {sorted(extra)}")
        if rule.get("operations_include") and not payload["identities"]:
            self.fail(i, "lease has no identities to include operations in")

    def select(self, i: int, body: Any, sel: Any) -> Any:
        if isinstance(sel, str):
            got = pointer(body, sel)
        else:
            arr = pointer(body, sel["at"])
            where = self.sub(sel["where"])
            item = next((x for x in arr or [] if all(pointer(x, p) == val for p, val in where.items())), _MISSING)
            got = _MISSING if item is _MISSING else pointer(item, sel["field"])
        if got is _MISSING:
            self.fail(i, f"capture {sel!r} found nothing")
        return got

    async def run(self) -> None:
        try:
            for i, step in enumerate(self.case["steps"], 1):
                if "action" in step:
                    self.act(step)
                else:
                    await self.request(i, step)
        finally:
            for c in self.clients.values():
                await c.aclose()


def id_form(value: str) -> tuple[str, int]:
    """An id's form for `unlike`: its prefix up to and including the first `_` or `-` (empty without one), and its length."""
    cut = min((i for i in (value.find("_"), value.find("-")) if i >= 0), default=-1)
    return (value[: cut + 1] if cut >= 0 else "", len(value))


def parse_sse(raw: bytes) -> list[dict]:
    frames = []
    for block in raw.decode("utf-8").split("\n\n"):
        data = [ln[5:].lstrip(" ") for ln in block.split("\n") if ln.startswith("data:")]
        if data:
            frames.append(json.loads("\n".join(data)))
    return frames


async def asgi_get_stream(app, url: str, headers: dict[str, str], *, bound_s: float, until_heartbeat: bool,
                          on_open=None):
    """Drive one GET through the ASGI app and read its body as it streams.

    Stops at the first heartbeat (the stream has caught up) when `until_heartbeat`, else when the app
    ends the response; either way after `bound_s` at most. Then the client disconnects.
    Returns (status, headers, body bytes, ended_by_app).
    """
    path, _, qs = url.partition("?")
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "https",
             "path": path, "raw_path": path.encode(), "query_string": qs.encode(), "root_path": "",
             "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
             + [(b"host", b"reader.example.test")],
             "client": ("127.0.0.1", 50000), "server": ("reader.example.test", 443)}
    sent_request = False
    disconnect = asyncio.Event()
    stop = asyncio.Event()
    start: dict = {}
    body = bytearray()
    ended = {"by_app": False}

    async def receive():
        nonlocal sent_request
        if not sent_request:
            sent_request = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(msg):
        if msg["type"] == "http.response.start":
            start.update(msg)
            if on_open is not None:
                on_open()
        elif msg["type"] == "http.response.body":
            body.extend(msg.get("body", b""))
            if until_heartbeat and b": heartbeat" in body:
                stop.set()
            if not msg.get("more_body", False):
                ended["by_app"] = True
                stop.set()

    task = asyncio.ensure_future(app(scope, receive, send))
    waiter = asyncio.ensure_future(stop.wait())
    await asyncio.wait({task, waiter}, timeout=bound_s, return_when=asyncio.FIRST_COMPLETED)
    waiter.cancel()
    disconnect.set()
    try:
        await asyncio.wait_for(task, 2.0)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        task.cancel()
    hdrs = httpx.Headers([(k.decode(), v.decode()) for k, v in start.get("headers", [])])
    if until_heartbeat:
        return start.get("status"), hdrs, bytes(body)
    return start.get("status"), hdrs, bytes(body), ended["by_app"]
