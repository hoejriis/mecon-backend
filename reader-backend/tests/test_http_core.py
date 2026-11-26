"""The HTTP reader-core adapter (`HttpReaderCore`): the published cases replayed through it, and its own mapping.

Every reader-core case runs on the `adapter` target (core_replay.py): raw to the stub core, then through the
adapter against the same stub, and both answers must meet the case's expectation. The unit tests below drive the
adapter against scripted answers on a real loopback socket: every answer that is not one the contract declares,
in the shape it declares, must become core_unavailable, and every refusal must keep its meaning.
"""
import asyncio
import importlib.util
import json
import logging
import os
import pathlib
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from jsonschema import Draft202012Validator, FormatChecker

from mecon_reader_backend import FacadeConfig, create_app
from mecon_reader_backend.__main__ import build, parse
from mecon_reader_backend.app import COOKIE, PREFIX
from mecon_reader_backend.core_schema import valid
from mecon_reader_backend.http_core import _NOT_JSON, HttpReaderCore, _json, refusal_codes
from mecon_reader_backend.http_lookup import HttpSessionLookup, parse_date_time
from mecon_reader_backend.ports import Caller, CoreError, EventBatch, LoginPoll, Page, SendResult, Subscribed
from mecon_reader_backend.reader_core_schemas import OPERATIONS, SCHEMAS, VERSION
from core_replay import ADAPTER, CoreReplay
from stub_core import respond, serve
from stub_reader_core import CORE, StubReaderCore, world_from_core_description
from test_http_lookup import Scripted, answer

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = CORE.root / "fixtures"
TOKEN = "synthetic-reader-core-token-for-adapter-tests-41c9"
CASES = CORE.load_cases()
UNAVAILABLE = ("unavailable", "core_unavailable", True, None)
C = Caller(session_ref="sr_synthetic_0001", user_id="usr_synthetic_0001", display_name="Alice (synthetic)",
           role="user", break_glass=False,
           capabilities={"devices": "available", "messaging": "available", "send": "available",
                         "events": "available", "observations": "unavailable"},
           expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
REF = {"user_id": C.user_id, "session_ref": C.session_ref}
SEND = {"client_draft_id": "drf_1", "client_attempt_id": "cat_1", "identity_id": "idn_1",
        "target": {"kind": "contact", "id": "con_1"}, "content": {"kind": "text", "text": "hello"}}
PAGE = {"items": [], "next_cursor": None, "as_of": "2030-01-01T00:00:00Z"}
BATCH = {"events": [], "cursor": "evc_synthetic_0001"}


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def run(coro, bound=20):
    return asyncio.run(asyncio.wait_for(coro, bound))


def token_file(tmp_path, value=TOKEN, name="core.token"):
    p = tmp_path / name
    if value is not None:
        p.write_text(value + "\n")
        os.chmod(p, 0o600)
    return p


def outcome(x):
    if isinstance(x, CoreError):
        return (x.kind, x.code, x.retryable, x.retry_after_s)
    return x


async def calls(tmp_path, handlers, invocations, *, timeout_s=2.0, events_margin_s=2.0, token=TOKEN):
    """One server; each invocation (method name, args, kwargs) answered by the next handler, in order."""
    pending = list(handlers)

    async def handler(req, receive, send):
        await pending.pop(0)(req, receive, send)
    app = Scripted(handler)
    got = []
    async with serve(app) as base:
        core = HttpReaderCore(base, token_file(tmp_path, token), timeout_s=timeout_s, events_margin_s=events_margin_s)
        try:
            for method, args, kwargs in invocations:
                try:
                    got.append(await getattr(core, method)(*args, **kwargs))
                except CoreError as e:
                    got.append(e)
        finally:
            await core.aclose()
    return [outcome(g) for g in got], app.seen


def one(tmp_path, handler, method, *args, **kwargs):
    got, seen = run(calls(tmp_path, [handler], [(method, args, kwargs)]))
    return got[0], seen


# ---- the published cases, through the adapter ----

@pytest.mark.parametrize("case", [c for _, c in CASES], ids=[c["id"] for _, c in CASES])
def test_core_case_through_the_adapter(case, tmp_path):
    r = CoreReplay(case, ADAPTER, tmp_path)
    asyncio.run(asyncio.wait_for(r.run(), 60))
    requests = [i for i, s in enumerate(case["steps"], 1) if "request" in s]
    invalid = [i for i, s in enumerate(case["steps"], 1) if "request" in s and s["request"].get("invalid")]
    assert r.raw_only_steps == invalid, "only a body that breaks the request schema is sent raw only"
    assert r.adapter_steps == len(requests) - len(invalid)


def test_most_case_requests_go_through_the_adapter():
    steps = [s for _, c in CASES for s in c["steps"] if "request" in s]
    invalid = [s for s in steps if s["request"].get("invalid")]
    assert len(steps) - len(invalid) > 3 * len(invalid)
    used = {s["request"]["operation"] for s in steps if not s["request"].get("invalid")}
    assert used == set(CORE.ops), sorted(set(CORE.ops) - used)


@pytest.mark.parametrize("case_id,step,pointer,wrong", [
    ("reads-05", -2, "/code", "forbidden"),
    ("send-02", -1, None, 201),
])
def test_the_adapter_runner_fails_a_case_whose_expectation_is_not_met(case_id, step, pointer, wrong, tmp_path):
    case = json.loads(json.dumps(next(c for _, c in CASES if c["id"] == case_id)))
    if pointer is None:
        case["steps"][step]["expect"]["status"] = wrong
    else:
        case["steps"][step]["expect"]["body"][pointer] = wrong
    with pytest.raises(AssertionError):
        asyncio.run(CoreReplay(case, ADAPTER, tmp_path).run())


# ---- the copy of the contract the adapter checks against ----

def _generator():
    spec = importlib.util.spec_from_file_location("reader_core_schemas_gen", ROOT / "scripts" / "reader_core_schemas.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_generated_schemas_match_the_document():
    gen = _generator()
    assert (ROOT / "src" / "mecon_reader_backend" / "reader_core_schemas.py").read_text() == gen.render(), \
        "run scripts/reader_core_schemas.py"
    assert VERSION == CORE.openapi["info"]["version"] == "1.0.0-draft.2"
    assert set(OPERATIONS) == set(CORE.ops)
    for op_id, spec in OPERATIONS.items():
        assert (spec["method"], spec["path"]) == (CORE.ops[op_id]["method"], CORE.ops[op_id]["path"])
        assert set(spec["responses"]) == CORE.ops[op_id]["statuses"]


def _reference(name):
    fc = FormatChecker()  # without rfc3339-validator jsonschema checks no date-time; the adapter's own rule here
    fc.checks("date-time")(lambda v: not isinstance(v, str) or parse_date_time(v) is not None)
    return Draft202012Validator({"$ref": f"urn:{CORE.name}#/components/schemas/{name}"}, registry=CORE._registry,
                                format_checker=fc)


def _variants(doc):
    out = [doc]
    if isinstance(doc, dict):
        for k in doc:
            out.append({m: v for m, v in doc.items() if m != k})
            for bad in (None, 0, -1, 1.5, "", "x" * 600, True, [], {}):
                out.append(dict(doc, **{k: bad}))
        out.append(dict(doc, unexpected_member=1))
        for k, v in doc.items():
            for sub in _variants(v)[1:12] if isinstance(v, (dict, list)) else []:
                out.append(dict(doc, **{k: sub}))
    if isinstance(doc, list) and doc:
        out += [[], doc + doc, [None], [_variants(doc[0])[1]] if isinstance(doc[0], dict) else ["x"]]
    return out


def test_the_schema_check_agrees_with_a_real_validator():
    """On every fixture and broken variants of it, against every component schema, as jsonschema decides."""
    docs = [json.loads(p.read_text()) for p in sorted(FIXTURES.glob("*.json"))]
    docs += [PAGE, BATCH, {"state": "approved"}, {"state": "pending", "credential": "x"}, 1, 1.0, True, None, "x"]
    bodies = [v for d in docs for v in _variants(d)]
    disagreements, checked, accepted = [], 0, 0
    for name in SCHEMAS:
        ref = _reference(name)
        for b in bodies:
            want = ref.is_valid(b)
            checked += 1
            accepted += want
            if valid(name, b) != want:
                disagreements.append((name, b, want))
    assert not disagreements, disagreements[:3]
    assert checked > 10_000 and 0 < accepted < checked


def test_the_refusal_codes_cover_every_declared_refusal_and_every_case():
    for op_id, spec in OPERATIONS.items():
        for status in spec["responses"]:
            if status >= 400 and status != 401:
                assert refusal_codes(op_id, status), (op_id, status)
    for _, case in CASES:
        for s in case["steps"]:
            if "request" not in s:
                continue
            status, code = s["expect"]["status"], (s["expect"].get("body") or {}).get("/code")
            if status >= 400 and status != 401 and code is not None:
                assert code in refusal_codes(s["request"]["operation"], status), (case["id"], status, code)


# ---- what the adapter sends ----

INVOCATIONS = [
    ("health", (), {}, "getHealth", None),
    ("start_login", ("a@example.test",), {"origin": "https://reader.example.test", "sec_fetch_site": None,
                                          "client_address": "192.0.2.7"}, "startLogin",
     {"email": "a@example.test", "origin": "https://reader.example.test", "sec_fetch_site": None,
      "client_address": "192.0.2.7"}),
    ("start_login", ("a@example.test",), {"origin": "https://" + "o" * 2050, "sec_fetch_site": "s" * 33,
                                          "client_address": "2001:db8::7"}, "startLogin",
     {"email": "a@example.test", "origin": None, "sec_fetch_site": None, "client_address": "2001:db8::7"}),
    ("poll_login", ("r" * 20,), {"client_address": "192.0.2.7"}, "pollLogin",
     {"request_id": "r" * 20, "client_address": "192.0.2.7"}),
    ("logout", (C,), {}, "logout", {"caller": REF}),
    ("list_devices", (C, None, 50), {}, "listDevices", {"caller": REF, "limit": 50}),
    ("list_identities", (C,), {}, "listIdentities", {"caller": REF}),
    ("list_conversations", (C, "cur_1", 10), {}, "listConversations", {"caller": REF, "cursor": "cur_1", "limit": 10}),
    ("get_conversation", (C, "cnv_1"), {}, "getConversation", {"caller": REF, "conversation_id": "cnv_1"}),
    ("mark_read", (C, "cnv_1", "msg_1"), {}, "markConversationRead",
     {"caller": REF, "conversation_id": "cnv_1", "up_to": "msg_1"}),
    ("list_messages", (C, "cnv_1", None, 20), {}, "listMessages", {"caller": REF, "conversation_id": "cnv_1", "limit": 20}),
    ("list_contacts", (C, "cur_2", 200), {}, "listContacts", {"caller": REF, "cursor": "cur_2", "limit": 200}),
    ("list_channels", (C,), {}, "listChannels", {"caller": REF}),
    ("create_send_attempt", (C, SEND), {}, "createSendAttempt", {"caller": REF, "request": SEND}),
    ("get_send_attempt", (C, "att_1"), {}, "getSendAttempt", {"caller": REF, "attempt_id": "att_1"}),
    ("read_events", (C, None, 0.0), {}, "readEvents", {"caller": REF, "cursor": None, "wait_s": 0.0}),
    ("read_events", (C, "evc_1", 40), {}, "readEvents", {"caller": REF, "cursor": "evc_1", "wait_s": 25.0}),
    ("create_lease", (C,), {}, "createLease", {"caller": REF}),
    ("list_lease_keys", (C,), {}, "listLeaseKeys", {"caller": REF}),
]


def test_every_operation_sends_its_body_with_the_service_token(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    unavailable = answer(503, {"code": "core_unavailable", "retryable": True})
    got, seen = run(calls(tmp_path, [unavailable] * len(INVOCATIONS),
                          [(m, a, k) for m, a, k, _, _ in INVOCATIONS]), bound=60)
    assert got == [UNAVAILABLE] * len(INVOCATIONS)
    assert {op for *_, op, _ in INVOCATIONS} == set(OPERATIONS)
    for (method, _, _, op_id, body), req in zip(INVOCATIONS, seen):
        assert (req["method"], req["path"]) == (OPERATIONS[op_id]["method"], OPERATIONS[op_id]["path"]), method
        assert req["headers"]["authorization"] == "Bearer " + TOKEN
        assert req["body"] == body, method
        if body is not None:
            assert CORE.schema_validator(OPERATIONS[op_id]["request"]).is_valid(req["body"]), method
    assert TOKEN not in caplog.text and "adapter-tests" not in repr(HttpReaderCore("http://x", "t"))


def test_the_base_url_keeps_its_path_prefix(tmp_path):
    seen = []

    async def go():
        app = Scripted(answer(200, fixture("health.json")))
        async with serve(app) as base:
            core = HttpReaderCore(base + "/core-prefix/", token_file(tmp_path))
            try:
                seen.append(await core.health())
            finally:
                await core.aclose()
        return app.seen
    reqs = run(go())
    assert seen == [fixture("health.json")] and reqs[0]["path"] == "/core-prefix/reader/health"


# ---- the service token ----

def test_no_token_file_or_an_empty_one_is_core_unavailable_and_sends_nothing(tmp_path):
    for value in (None, "", "two words"):
        got, seen = run(calls(tmp_path, [], [("list_devices", (C, None, 50), {})], token=value))
        assert got == [UNAVAILABLE] and seen == [], value


def test_a_refused_token_is_core_unavailable_logged_once_until_accepted(tmp_path, caplog):
    caplog.set_level(logging.WARNING)
    world = world_from_core_description(CORE.worlds["worlds"]["two-fleets"])
    stub = StubReaderCore(world)

    async def go():
        async with serve(stub) as base:
            p = token_file(tmp_path, "synthetic-wrong-token-0000")
            core = HttpReaderCore(base, p, timeout_s=2.0)
            try:
                out = [outcome(await _try(core.health())) for _ in range(3)]
                refused = core.token_refused
                p.write_text(stub.token + "\n")  # the file is fixed: read again because it changed
                out.append(await core.health())
                return out, refused, core.token_refused
            finally:
                await core.aclose()
    out, refused, after = run(go())
    assert out[:3] == [UNAVAILABLE] * 3 and out[3]["status"] == "ok"
    assert refused is True and after is False
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 2 and "refuses" in errors[0] and "accepts" in errors[1]
    assert stub.token not in caplog.text and "synthetic-wrong-token-0000" not in caplog.text


async def _try(coro):
    try:
        return await coro
    except CoreError as e:
        return e


# ---- timeouts ----

def stalled(seconds, status=200, body=None):
    async def handler(req, receive, send):
        await asyncio.sleep(seconds)
        await respond(send, status, json.dumps(body if body is not None else fixture("health.json")).encode())
    return handler


def test_a_core_that_stalls_is_core_unavailable_within_the_call_timeout(tmp_path):
    t0 = time.monotonic()
    got, _ = run(calls(tmp_path, [stalled(3.0)], [("health", (), {})], timeout_s=0.5), bound=2.5)
    assert got == [UNAVAILABLE]
    assert time.monotonic() - t0 < 2.0


def test_read_events_is_bounded_by_wait_s_plus_the_margin(tmp_path):
    slow = stalled(0.8, body=BATCH)
    got, seen = run(calls(tmp_path, [slow, slow],
                          [("read_events", (C, None, 0.6), {}), ("read_events", (C, None, 0.1), {})],
                          timeout_s=0.3, events_margin_s=0.4), bound=10)
    assert got[0] == EventBatch(events=[], cursor="evc_synthetic_0001")  # 0.6 + 0.4 > 0.8: answered
    assert got[1] == UNAVAILABLE  # 0.1 + 0.4 < 0.8: bounded
    assert [r["body"]["wait_s"] for r in seen] == [0.6, 0.1]


# ---- answers ----

def test_valid_answers_become_the_port_values(tmp_path):
    poll = fixture("login-poll-approved.json")
    attempt = fixture("send-attempt-queued.json")
    handlers = [answer(200, fixture("health.json")), answer(202, fixture("login-started.json")),
                answer(200, poll), answer(200, fixture("login-poll-pending.json")),
                answer(200, fixture("devices-one.json")), answer(201, attempt), answer(200, attempt),
                answer(200, fixture("event-batch.json")), answer(200, fixture("lease-issued.json")),
                answer(200, fixture("lease-keys.json")), answer(204, b""), answer(204, b"")]
    inv = [("health", (), {}),
           ("start_login", ("a@example.test",), {"origin": None, "sec_fetch_site": "same-origin",
                                                 "client_address": "192.0.2.1"}),
           ("poll_login", ("r" * 20,), {"client_address": "192.0.2.1"}),
           ("poll_login", ("r" * 20,), {"client_address": "192.0.2.1"}),
           ("list_devices", (C, None, 50), {}), ("create_send_attempt", (C, SEND), {}),
           ("create_send_attempt", (C, SEND), {}), ("read_events", (C, None, 0.0), {}),
           ("create_lease", (C,), {}), ("list_lease_keys", (C,), {}), ("logout", (C,), {}),
           ("mark_read", (C, "cnv_1", "msg_1"), {})]
    got, _ = run(calls(tmp_path, handlers, inv), bound=60)
    assert got[0] == fixture("health.json") and got[1] == fixture("login-started.json")
    assert got[2] == LoginPoll("approved", poll_after_ms=poll.get("poll_after_ms"), credential=poll["credential"],
                               expires_at=parse_date_time(poll["expires_at"]))
    assert got[3].state == "pending" and got[3].credential is None and got[3].expires_at is None
    devices = fixture("devices-one.json")
    assert got[4] == Page(items=devices["items"], next_cursor=None, as_of=parse_date_time(devices["as_of"]))
    assert got[5] == SendResult(attempt=attempt, created=True) and got[6] == SendResult(attempt=attempt, created=False)
    assert got[7] == EventBatch(**fixture("event-batch.json"))
    assert got[8] == fixture("lease-issued.json") and got[9] == fixture("lease-keys.json")
    assert got[10] is None and got[11] is None


BAD_2XX = {
    "page without as_of": ("list_devices", (C, None, 50), 200, {"items": [], "next_cursor": None}),
    "page cursor not a string": ("list_devices", (C, None, 50), 200, dict(PAGE, next_cursor=5)),
    "device without its id": ("list_devices", (C, None, 50), 200,
                              dict(PAGE, items=[{k: v for k, v in fixture("devices-one.json")["items"][0].items()
                                                 if k != "id"}])),
    "as_of not a date-time": ("list_channels", (C,), 200, dict(PAGE, as_of="yesterday")),
    "approved without credential": ("poll_login", ("r" * 20,), 200,
                                    {"state": "approved", "expires_at": "2030-01-01T00:00:00Z"}),
    "pending with a credential": ("poll_login", ("r" * 20,), 200, {"state": "pending", "credential": "x"}),
    "unknown login state": ("poll_login", ("r" * 20,), 200, {"state": "maybe"}),
    "health status outside the enum": ("health", (), 200, {"status": "great", "commit": None}),
    "batch without cursor": ("read_events", (C, None, 0.0), 200, {"events": []}),
    "batch with an extra member": ("read_events", (C, None, 0.0), 200, dict(BATCH, scope=["fleet_x"])),
    "envelope of unknown kind": ("read_events", (C, None, 0.0), 200,
                                 dict(BATCH, events=[dict(fixture("event-batch.json")["events"][0], kind="x")])),
    "a session_revoked envelope": ("read_events", (C, None, 0.0), 200,
                                   dict(BATCH, events=[dict(fixture("event-batch.json")["events"][0],
                                                            kind="session_revoked")])),
    "attempt that is empty": ("create_send_attempt", (C, SEND), 201, {}),
    "login started without request_id": ("start_login", ("a@example.test",), 202,
                                         {"poll_after_ms": 2000, "expires_at": "2030-01-01T00:00:00Z"}),
    "not JSON": ("list_identities", (C,), 200, b"not json"),
    "empty body": ("get_conversation", (C, "cnv_1"), 200, b""),
    "JSON null": ("get_send_attempt", (C, "att_1"), 200, b"null"),
    "lease without its token": ("create_lease", (C,), 200, {"expires_at": "2030-01-01T00:00:00Z"}),
    "oversized": ("list_contacts", (C, None, 50), 200, dict(PAGE, padding="x" * (9 * 1024 * 1024))),
}


def test_a_2xx_body_that_breaks_the_schema_is_core_unavailable(tmp_path):
    whys = sorted(BAD_2XX)
    handlers = [answer(BAD_2XX[w][2], BAD_2XX[w][3]) for w in whys]
    got, _ = run(calls(tmp_path, handlers, [(BAD_2XX[w][0], BAD_2XX[w][1], _login_kwargs(BAD_2XX[w][0])) for w in whys]), bound=60)
    assert {w: g for w, g in zip(whys, got) if g != UNAVAILABLE} == {}


UNDECLARED = {
    "404 on listDevices": ("list_devices", (C, None, 50), 404, {"code": "not_found", "retryable": False}),
    "500": ("list_devices", (C, None, 50), 500, {"code": "core_unavailable", "retryable": True}),
    "418": ("get_conversation", (C, "cnv_1"), 418, {}),
    "200 on startLogin (declares 202)": ("start_login", ("a@example.test",), 200, fixture("login-started.json")),
    "202 on getHealth": ("health", (), 202, fixture("health.json")),
    "403 on logout": ("logout", (C,), 403, {"code": "session_ended", "retryable": False}),
    "410 on listMessages": ("list_messages", (C, "cnv_1", None, 50), 410, {"code": "cursor_expired",
                                                                          "retryable": False}),
}


def test_an_undeclared_status_is_core_unavailable(tmp_path):
    whys = sorted(UNDECLARED)
    handlers = [answer(UNDECLARED[w][2], UNDECLARED[w][3]) for w in whys]
    got, _ = run(calls(tmp_path, handlers, [(UNDECLARED[w][0], UNDECLARED[w][1], _login_kwargs(UNDECLARED[w][0]))
                                             for w in whys]), bound=60)
    assert {w: g for w, g in zip(whys, got) if g != UNAVAILABLE} == {}


def test_a_redirect_is_not_followed(tmp_path):
    async def go():
        # Every request is redirected to a path that would answer a valid page.
        async def handler(req, receive, send):
            if req["path"] == "/elsewhere/reader/devices/list":
                return await respond(send, 200, json.dumps(PAGE).encode())
            await respond(send, 307, b"", extra=[(b"location", b"/elsewhere/reader/devices/list")])
        app = Scripted(handler)
        async with serve(app) as base:
            core = HttpReaderCore(base, token_file(tmp_path), timeout_s=2.0)
            try:
                return outcome(await _try(core.list_devices(C, None, 50))), [q["path"] for q in app.seen]
            finally:
                await core.aclose()
    got, paths = run(go())
    assert got == UNAVAILABLE and paths == ["/reader/devices/list"]


def r(code, retryable=False, **extra):
    return dict({"code": code, "retryable": retryable}, **extra)


REFUSALS = {
    "403 session_ended": ("list_devices", (C, None, 50), 403, r("session_ended"),
                          ("forbidden", "session_ended", False, None)),
    "403 session_ended on a send": ("create_send_attempt", (C, SEND), 403, r("session_ended"),
                                    ("forbidden", "session_ended", False, None)),
    "403 session_ended on events": ("read_events", (C, None, 0.0), 403, r("session_ended"),
                                    ("forbidden", "session_ended", False, None)),
    "403 origin_rejected": ("start_login", ("a@example.test",), 403, r("origin_rejected"),
                            ("forbidden", "origin_rejected", False, None)),
    "403 sending_disabled": ("create_send_attempt", (C, SEND), 403, r("sending_disabled"),
                             ("forbidden", "sending_disabled", False, None)),
    "404 not_found": ("get_conversation", (C, "cnv_1"), 404, r("not_found"), ("not_found", "not_found", False, None)),
    "404 not_found on a send": ("create_send_attempt", (C, SEND), 404, r("not_found"),
                                ("not_found", "not_found", False, None)),
    "404 not_found on leases": ("list_lease_keys", (C,), 404, r("not_found"), ("not_found", "not_found", False, None)),
    "409 conflict": ("create_send_attempt", (C, SEND), 409, r("conflict"), ("conflict", "conflict", False, None)),
    "410 cursor_expired": ("read_events", (C, "evc_1", 0.0), 410, r("cursor_expired"),
                           ("gone", "cursor_expired", False, None)),
    "422 invalid cursor": ("list_devices", (C, "cur_x", 50), 422, r("invalid"), ("invalid", "invalid", False, None)),
    "422 validation_failed": ("mark_read", (C, "cnv_1", "msg_9"), 422, r("validation_failed"),
                              ("invalid", "validation_failed", False, None)),
    "422 invalid content": ("create_send_attempt", (C, SEND), 422, r("invalid"), ("invalid", "invalid", False, None)),
    "429 rate_limited on start": ("start_login", ("a@example.test",), 429, r("rate_limited", True, retry_after_s=60),
                                  ("throttled", "rate_limited", True, 60)),
    "429 rate_limited on poll": ("poll_login", ("r" * 20,), 429, r("rate_limited", True, retry_after_s=7),
                                 ("throttled", "rate_limited", True, 7)),
    "429 throttled on a send": ("create_send_attempt", (C, SEND), 429, r("throttled", True, retry_after_s=5),
                                ("throttled", "throttled", True, 5)),
    "429 throttled on a lease": ("create_lease", (C,), 429, r("throttled", True), ("throttled", "throttled", True, None)),
    "503 lease_signing_unavailable": ("create_lease", (C,), 503, r("lease_signing_unavailable"),
                                      ("unavailable", "lease_signing_unavailable", False, None)),
    "503 core_unavailable": ("list_channels", (C,), 503, r("core_unavailable", True), UNAVAILABLE),
    "422 malformed_request": ("list_devices", (C, None, 50), 422, r("malformed_request"), UNAVAILABLE),
    "401 service_unauthorized": ("list_devices", (C, None, 50), 401, {"code": "service_unauthorized"}, UNAVAILABLE),
    # refusals the contract does not declare where they arrive
    "404 carrying session_ended": ("get_conversation", (C, "cnv_1"), 404, r("session_ended"), UNAVAILABLE),
    "403 carrying not_found": ("get_conversation", (C, "cnv_1"), 403, r("not_found"), UNAVAILABLE),
    "403 origin_rejected on a read": ("list_devices", (C, None, 50), 403, r("origin_rejected"), UNAVAILABLE),
    "409 carrying invalid": ("create_send_attempt", (C, SEND), 409, r("invalid"), UNAVAILABLE),
    "422 validation_failed on a page": ("list_devices", (C, None, 50), 422, r("validation_failed"), UNAVAILABLE),
    "429 throttled on login": ("start_login", ("a@example.test",), 429, r("throttled", True, retry_after_s=60),
                               UNAVAILABLE),
    "429 rate_limited without retry_after_s": ("poll_login", ("r" * 20,), 429, r("rate_limited", True), UNAVAILABLE),
    "503 lease_signing_unavailable on a read": ("list_devices", (C, None, 50), 503, r("lease_signing_unavailable"),
                                                UNAVAILABLE),
    "refusal with an extra member": ("get_conversation", (C, "cnv_1"), 404, r("not_found", hint="x"), UNAVAILABLE),
    "refusal without retryable": ("get_conversation", (C, "cnv_1"), 404, {"code": "not_found"}, UNAVAILABLE),
    "refusal of an unknown code": ("get_conversation", (C, "cnv_1"), 404, r("gone"), UNAVAILABLE),
    "refusal not JSON": ("get_conversation", (C, "cnv_1"), 404, b"<html>", UNAVAILABLE),
}


def _login_kwargs(method):
    if method == "start_login":
        return {"origin": None, "sec_fetch_site": "same-origin", "client_address": "192.0.2.1"}
    if method == "poll_login":
        return {"client_address": "192.0.2.1"}
    return {}


def test_each_refusal_keeps_its_meaning(tmp_path):
    whys = sorted(REFUSALS)
    handlers = [answer(REFUSALS[w][2], REFUSALS[w][3]) for w in whys]
    inv = [(REFUSALS[w][0], REFUSALS[w][1], _login_kwargs(REFUSALS[w][0])) for w in whys]
    got, _ = run(calls(tmp_path, handlers, inv), bound=60)
    assert {w: g for w, g in zip(whys, got) if g != REFUSALS[w][4]} == {}


def test_malformed_request_is_logged_once_per_operation_as_an_adapter_bug(tmp_path, caplog):
    caplog.set_level(logging.WARNING)
    m = answer(422, r("malformed_request"))
    got, _ = run(calls(tmp_path, [m, m, m], [("list_devices", (C, None, 50), {}), ("list_devices", (C, None, 50), {}),
                                             ("list_channels", (C,), {})]))
    assert got == [UNAVAILABLE] * 3
    errors = [rec.getMessage() for rec in caplog.records if rec.levelno == logging.ERROR]
    assert len(errors) == 2 and "listDevices" in errors[0] and "listChannels" in errors[1]


def test_against_the_stub_a_malformed_body_and_refused_content_keep_their_meaning(tmp_path):
    world = world_from_core_description(CORE.worlds["worlds"]["two-fleets"])
    stub = StubReaderCore(world)
    s = world.mint_session("alice")
    alice = Caller(session_ref=world.session_ref(s), user_id=world.users["alice"].id, display_name="Alice",
                   role="user", break_glass=False, capabilities=dict(C.capabilities), expires_at=C.expires_at)

    async def go():
        async with serve(stub) as base:
            core = HttpReaderCore(base, token_file(tmp_path, stub.token), timeout_s=2.0)
            try:
                return [outcome(await _try(core.list_devices(alice, None, 0))),  # our bug: limit 0
                        outcome(await _try(core.create_send_attempt(alice, dict(SEND, content={"kind": "text",
                                                                                               "text": ""})))),
                        (await core.list_devices(alice, None, 50)).items != []]
            finally:
                await core.aclose()
    got = run(go())
    assert got == [UNAVAILABLE, ("invalid", "invalid", False, None), True]
    assert [st for _, st in stub.served] == [422, 422, 200]


# ---- through the facade: call_core maps the adapter's errors as it maps the fake's ----

class FixedLookup:
    """A lookup that always resolves the one caller, so only the core can say the session ended."""

    def __init__(self, caller):
        self.caller = caller

    async def resolve(self, credential, purpose, **kw):
        return self.caller

    async def revocations(self):
        yield Subscribed()
        await asyncio.Event().wait()


def test_the_facade_over_the_adapter(tmp_path):
    desc = CORE.worlds["worlds"]["two-fleets"]
    world = world_from_core_description(desc)
    stub = StubReaderCore(world)
    s = world.mint_session("alice")
    alice = Caller(session_ref=world.session_ref(s), user_id=world.users["alice"].id, display_name="Alice",
                   role="user", break_glass=False, capabilities=dict(C.capabilities), expires_at=C.expires_at)
    origin = desc["origin_allow_list"][0]

    async def go():
        async with serve(stub) as base:
            core = HttpReaderCore(base, token_file(tmp_path, stub.token), timeout_s=2.0)
            app = create_app(FixedLookup(alice), core, FacadeConfig(reader_origins=(origin,)))
            out = {}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=origin) as client:
                client.cookies.set(COOKIE, "synthetic-cookie-value", domain=httpx.URL(origin).host, path="/")
                r1 = await client.get(PREFIX + "/devices")
                out["devices"] = (r1.status_code, len(r1.json()["items"]))
                stub.core.exhaust_login_limit("127.0.0.1")
                r2 = await client.post(PREFIX + "/login", json={"email": "alice@example.test"},
                                       headers={"Origin": origin})
                out["login over the limit"] = (r2.status_code, sorted(r2.json()))
                stub.core.unavailable = True
                r3 = await client.get(PREFIX + "/devices")
                out["degraded"] = (r3.status_code, r3.json()["code"], "set-cookie" in r3.headers)
                stub.core.unavailable = False
                world.revoke(s, "ended")
                r4 = await client.get(PREFIX + "/devices")
                out["ended"] = (r4.status_code, r4.json()["code"], 'mecon_session=""' in r4.headers.get("set-cookie", ""))
            await core.aclose()
            return out
    out = run(go(), bound=30)
    assert out == {"devices": (200, 1), "login over the limit": (202, ["expires_at", "poll_after_ms", "request_id"]),
                   "degraded": (503, "unavailable", False), "ended": (401, "unauthenticated", True)}


# ---- the entry point ----

def test_the_entry_point_wires_both_http_adapters(tmp_path, monkeypatch):
    p = token_file(tmp_path)
    args = parse(["--core-url", "http://core.internal:8080/prefix", "--token-file", str(p), "--core-timeout-s", "3",
                  "--events-margin-s", "4", "--lookup-timeout-s", "1.5"])
    app, lookup, core = build(args)
    assert isinstance(core, HttpReaderCore) and isinstance(lookup, HttpSessionLookup)
    assert core.base_url == lookup.base_url == "http://core.internal:8080/prefix"
    assert (core.timeout_s, core.events_margin_s, lookup.timeout_s) == (3.0, 4.0, 1.5)
    assert app.state.config.core_timeout_s > core.timeout_s + core.events_margin_s
    monkeypatch.setenv("MECON_READER_CORE_URL", "http://core.internal:9000")
    monkeypatch.setenv("MECON_READER_LOOKUP_URL", "http://lookup.internal:9001")
    monkeypatch.setenv("MECON_READER_SERVICE_TOKEN_FILE", str(p))
    _, lookup, core = build(parse([]))
    assert (core.base_url, lookup.base_url) == ("http://core.internal:9000", "http://lookup.internal:9001")
    monkeypatch.delenv("MECON_READER_SERVICE_TOKEN_FILE")
    with pytest.raises(SystemExit):
        parse([])
    monkeypatch.delenv("MECON_READER_CORE_URL")
    with pytest.raises(SystemExit):
        parse([])  # neither a world nor a core


# ---- deeply nested input ----

DEEP = b"[" * 200_000 + b"]" * 200_000  # far past the JSON parser's recursion limit


def test_a_body_nested_past_the_parser_limit_is_not_json():
    assert _json(DEEP) is _NOT_JSON
    assert _json(b'{"code":' * 100_000 + b"1" + b"}" * 100_000) is _NOT_JSON


@pytest.mark.parametrize("op,status", [("listDevices", 200), ("getConversation", 404), ("startLogin", 429)])
def test_a_deeply_nested_answer_read_without_the_outer_guard_is_core_unavailable(op, status, tmp_path):
    """`_answer` alone, outside `_call`'s guard: the parse itself must read the body as malformed."""
    core = HttpReaderCore("http://core.invalid", token_file(tmp_path))
    with pytest.raises(CoreError) as e:
        core._answer(op, status, DEEP)
    assert (e.value.kind, e.value.code) == ("unavailable", "core_unavailable")


def test_a_deeply_nested_answer_is_core_unavailable_on_a_2xx_and_on_a_refusal(tmp_path):
    handlers = [answer(200, DEEP), answer(404, DEEP), answer(429, DEEP), answer(201, DEEP)]
    inv = [("list_devices", (C, None, 50), {}), ("get_conversation", (C, "cnv_1"), {}),
           ("start_login", ("a@example.test",), _login_kwargs("start_login")), ("create_send_attempt", (C, SEND), {})]
    got, _ = run(calls(tmp_path, handlers, inv), bound=60)
    assert got == [UNAVAILABLE] * 4


def test_the_schema_check_is_bounded_on_deep_values():
    deep = []
    cur = deep
    for _ in range(50_000):  # built directly, deeper than any parse could give
        nxt = []
        cur.append(nxt)
        cur = nxt
    t0 = time.monotonic()
    assert valid("EventBatch", {"events": deep, "cursor": "c"}) is False  # an envelope must be an object
    assert valid("DeviceList", dict(PAGE, items=[dict(fixture("devices-one.json")["items"][0],
                                                      capability_evidence={"ble": deep})])) is False
    assert valid("Health", {"status": "ok", "commit": None, "extra": deep}) is True  # open object: not descended
    assert time.monotonic() - t0 < 2.0


def test_help_says_the_world_wins_over_the_core_url(tmp_path, monkeypatch, capsys):
    with pytest.raises(SystemExit):
        parse(["--help"])
    assert "--world wins over MECON_READER_CORE_URL" in " ".join(capsys.readouterr().out.split())
    monkeypatch.setenv("MECON_READER_CORE_URL", "http://core.internal:9000")
    world = CORE.root.parent.parent / "reader-api" / "v1" / "cases" / "worlds.json"
    _, _, core = build(parse(["--world", str(world)]))
    assert not isinstance(core, HttpReaderCore)


# ---- patterns: exact, as ECMA-262 means them ----

from mecon_reader_backend.core_schema import check, compiled  # noqa: E402

# Every patterned property of the reader-core schemas, with a value its pattern accepts and a position whose
# character is replaced by a non-ASCII digit (Arabic-Indic three) to make it fail.
PATTERNED = {
    "^[0-9a-f]{2}$": ("a3", 1),
    "^[0-9a-f]{2,16}$": ("0f3a", 2),
    "^[A-Za-z0-9_-]{43}$": ("A" * 20 + "3" + "b_-" + "c" * 19, 20),
    "^1\\.[0-9]+$": ("1.3", 2),
    "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$": ("eyJ3.c2ln3", 3),
}
ARABIC_INDIC_THREE = "\u0663"


def _patterned(schema, where, out):
    if isinstance(schema, dict):
        if "pattern" in schema:
            out.append((where, schema))
        for k, v in schema.items():
            _patterned(v, f"{where}.{k}", out)
    elif isinstance(schema, list):
        for i, v in enumerate(schema):
            _patterned(v, f"{where}[{i}]", out)
    return out


def test_every_patterned_schema_is_exact():
    found = [x for name, s in SCHEMAS.items() for x in _patterned(s, name, [])]
    assert len(found) == 6, [w for w, _ in found]
    for where, sub in found:
        good, pos = PATTERNED[sub["pattern"]]
        assert check(sub, good), where
        assert not check(sub, good + "\n"), f"{where}: a trailing newline must fail"
        assert not check(sub, good[:pos] + ARABIC_INDIC_THREE + good[pos + 1:]), f"{where}: a non-ASCII digit"
        ref = Draft202012Validator(sub)
        assert ref.is_valid(good) and not ref.is_valid(good[:pos] + ARABIC_INDIC_THREE + good[pos + 1:])


def test_a_whole_lease_with_a_trailing_newline_is_refused():
    lease = fixture("lease-issued.json")
    assert valid("LeaseIssued", lease)
    assert not valid("LeaseIssued", dict(lease, lease=lease["lease"] + "\n"))


def test_pattern_classes_are_ascii_and_dollar_is_the_end_of_input():
    # No reader-core pattern uses \\d or \\w yet; the compiler must still read them as ECMA-262 does.
    assert compiled(r"^\d+$").search("123") and not compiled(r"^\d+$").search("1" + ARABIC_INDIC_THREE)
    assert not compiled(r"^\w+$").search("\u00e9t\u00e9")
    assert not compiled(r"^ab$").search("ab\n") and compiled(r"^ab$").search("ab")
    assert compiled(r"^a\$b$").search("a$b") and compiled(r"^[$]$").search("$")  # escaped and in a class: literal
    assert not compiled(r"^(a$|b)c").search("a\nc")
