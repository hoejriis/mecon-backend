"""The HTTP session-lookup adapter's own mapping, against scripted answers on a real loopback socket.

Every answer that is not a valid Caller (200) or Denied (403) must become core_unavailable: a core that
cannot answer, or refuses the facade's service token, never signs anyone out.
"""
import asyncio
import copy
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import pytest

from mecon_reader_backend.http_lookup import HttpSessionLookup, _Malformed, parse_caller, parse_denied, \
    parse_revocation_item
from mecon_reader_backend.ports import Caller, Denied, Revocation, Subscribed
from mecon_reader_backend.sessions import SessionResolver
from lookup_replay import LOOKUP
from stub_core import HEARTBEAT, respond, serve, sse, stream_until_disconnect

TOKEN = "synthetic-service-token-for-adapter-tests-7f3a"
CALLER = {"user_id": "usr_synthetic_0001", "session_ref": "ses_synthetic_0001", "role": "user",
          "break_glass": False, "display_name": "Alice (synthetic)",
          "capabilities": {"devices": "available", "messaging": "available", "send": "available",
                           "events": "available", "observations": "unavailable"},
          "expires_at": "2030-01-15T10:00:00Z"}
UNAVAILABLE = Denied("core_unavailable")
CRED = "synthetic_cookie_value_alice_0123456789"


class Scripted:
    """An ASGI app answering every request with `handler(path, request)`; records what it received."""

    def __init__(self, handler):
        self.handler = handler
        self.seen = []

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return
        body = b""
        if scope["method"] == "POST":
            while True:
                msg = await receive()
                body += msg.get("body", b"")
                if not msg.get("more_body"):
                    break
        req = {"path": scope["path"], "method": scope["method"],
               "headers": {k.decode(): v.decode() for k, v in scope["headers"]},
               "body": json.loads(body) if body else None}
        self.seen.append(req)
        await self.handler(req, receive, send)


def answer(status, body, content_type="application/json", extra=None):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()

    async def handler(req, receive, send):
        await respond(send, status, raw, content_type, extra)
    return handler


def token_file(tmp_path, value=TOKEN):
    p = tmp_path / "service.token"
    p.write_text(value + "\n")
    os.chmod(p, 0o600)
    return p


def run(coro, bound=20):
    return asyncio.run(asyncio.wait_for(coro, bound))


async def lookup_once(tmp_path, handler, purpose="read", timeout_s=2.0, **kw):
    got, seen = await lookup_many(tmp_path, [handler], purpose, timeout_s, **kw)
    return got[0], seen


async def lookup_many(tmp_path, handlers, purpose="read", timeout_s=2.0, **kw):
    """One server, one lookup per handler, in order."""
    pending = list(handlers)

    async def handler(req, receive, send):
        await pending.pop(0)(req, receive, send)
    app = Scripted(handler)
    got = []
    async with serve(app) as base:
        a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=timeout_s)
        try:
            for _ in handlers:
                got.append(await a.resolve(CRED, purpose, **kw))
        finally:
            await a.aclose()
    return got, app.seen


# ---- 200 ----

def test_a_valid_caller_is_a_caller(tmp_path):
    got, seen = run(lookup_once(tmp_path, answer(200, CALLER)))
    assert isinstance(got, Caller)
    assert (got.user_id, got.session_ref, got.role, got.break_glass, got.display_name) == \
        ("usr_synthetic_0001", "ses_synthetic_0001", "user", False, "Alice (synthetic)")
    assert got.expires_at == datetime(2030, 1, 15, 10, tzinfo=timezone.utc)
    assert got.capabilities == CALLER["capabilities"] and got.csrf_token is None


def test_a_session_lookup_caller_carries_its_csrf_token(tmp_path):
    body = dict(CALLER, csrf_token="synthetic_csrf_token_alice")
    got, _ = run(lookup_once(tmp_path, answer(200, body), purpose="session"))
    assert isinstance(got, Caller) and got.csrf_token == "synthetic_csrf_token_alice"


def _bad_callers():
    out = {"extra member": dict(CALLER, fleets=["x"]), "extra capability": copy.deepcopy(CALLER),
           "not an object": [CALLER], "role outside the enum": dict(CALLER, role="owner"),
           "break_glass not a boolean": dict(CALLER, break_glass=0), "empty user_id": dict(CALLER, user_id=""),
           "empty session_ref": dict(CALLER, session_ref=""), "no offset on expires_at":
           dict(CALLER, expires_at="2030-01-15T10:00:00"), "date only": dict(CALLER, expires_at="2030-01-15"),
           "capability outside the enum": copy.deepcopy(CALLER), "empty csrf_token": dict(CALLER, csrf_token=""),
           "display_name not a string": dict(CALLER, display_name=None),
           "user_id over 128": dict(CALLER, user_id="u" * 129), "csrf_token under 16": dict(CALLER, csrf_token="t" * 15),
           "csrf_token over 512": dict(CALLER, csrf_token="t" * 513)}
    out["extra capability"]["capabilities"]["fleets"] = "available"
    out["capability outside the enum"]["capabilities"]["send"] = "maybe"
    for k in CALLER:
        out[f"missing {k}"] = {m: v for m, v in CALLER.items() if m != k}
    for k in CALLER["capabilities"]:
        d = copy.deepcopy(CALLER)
        del d["capabilities"][k]
        out[f"missing capability {k}"] = d
    return out


BAD_CALLERS = _bad_callers()


def test_a_200_that_is_not_a_valid_caller_is_core_unavailable(tmp_path):
    whys = sorted(BAD_CALLERS)
    got, _ = run(lookup_many(tmp_path, [answer(200, BAD_CALLERS[w]) for w in whys]))
    assert {w: g for w, g in zip(whys, got) if g != UNAVAILABLE} == {}


def test_a_malformed_body_is_core_unavailable(tmp_path):
    raws = [b"", b"{", b"not json", b'{"user_id":', b"\xff\xfe", b"null", b"[]"]
    got, _ = run(lookup_many(tmp_path, [answer(200, r) for r in raws]))
    assert got == [UNAVAILABLE] * len(raws)


def test_an_oversized_answer_is_core_unavailable(tmp_path):
    got, _ = run(lookup_once(tmp_path, answer(200, dict(CALLER, display_name="x" * 100_000))))
    assert got == UNAVAILABLE


def test_the_caller_check_agrees_with_the_document():
    val = LOOKUP.schema_validator("Caller")
    bodies = [CALLER, dict(CALLER, csrf_token="t" * 16), dict(CALLER, csrf_token="t" * 512),
              dict(CALLER, user_id="u" * 128), dict(CALLER, role="instance_admin", break_glass=True)]
    bodies += [b for k, b in BAD_CALLERS.items() if "expires_at" not in k and "date only" not in k]
    disagreements = [(b, val.is_valid(b)) for b in bodies if val.is_valid(b) != (parse_caller(b) is not None)]
    assert not disagreements, disagreements[:2]
    assert any(val.is_valid(b) for b in bodies) and not all(val.is_valid(b) for b in bodies)


def test_the_denied_check_agrees_with_the_document():
    val = LOOKUP.schema_validator("Denied")
    reasons = ["expired", "revoked", "unknown", "csrf_failed", "origin_rejected", "core_unavailable", "other", ""]
    bodies = [{"reason": r, "retryable": False} for r in reasons]
    bodies += [{"reason": "expired", "retryable": True}, {"reason": "expired"}, {"retryable": False},
               {"reason": "expired", "retryable": False, "extra": 1}, ["expired"], None]
    disagreements = [b for b in bodies if val.is_valid(b) != (parse_denied(b) is not None)]
    assert not disagreements, disagreements


# ---- 403 ----

def test_a_403_denied_keeps_its_reason(tmp_path):
    reasons = ["expired", "revoked", "unknown", "csrf_failed", "origin_rejected"]
    got, _ = run(lookup_many(tmp_path, [answer(403, {"reason": r, "retryable": False}) for r in reasons]))
    assert got == [Denied(r) for r in reasons]


BAD_DENIED = {"unknown reason": {"reason": "logged_out", "retryable": False},
              "core_unavailable at 403": {"reason": "core_unavailable", "retryable": False},
              "retryable": {"reason": "expired", "retryable": True},
              "extra member": {"reason": "expired", "retryable": False, "hint": "x"},
              "no retryable": {"reason": "expired"}, "no reason": {"code": "forbidden"}, "not json": b"not json"}


def test_a_403_that_is_not_a_valid_denied_is_core_unavailable(tmp_path):
    whys = sorted(BAD_DENIED)
    got, _ = run(lookup_many(tmp_path, [answer(403, BAD_DENIED[w]) for w in whys]))
    assert {w: g for w, g in zip(whys, got) if g != UNAVAILABLE} == {}


# ---- every other status ----

def test_a_503_is_core_unavailable_even_with_a_caller_body(tmp_path):
    bodies = [{"reason": "core_unavailable", "retryable": True}, CALLER, {"reason": "unknown", "retryable": False}]
    got, _ = run(lookup_many(tmp_path, [answer(503, b) for b in bodies]))
    assert got == [UNAVAILABLE] * 3, "a 503 is never a Caller and never clears the cookie"


def test_a_refused_service_token_is_core_unavailable_never_a_session_denial(tmp_path):
    bodies = [{"code": "service_unauthorized"}, {"reason": "unknown", "retryable": False}, CALLER]
    got, _ = run(lookup_many(tmp_path, [answer(401, b) for b in bodies]))
    assert got == [UNAVAILABLE] * 3


def test_any_other_status_is_core_unavailable(tmp_path):
    statuses = [201, 204, 400, 404, 409, 418, 422, 429, 500, 502, 504]
    handlers = [answer(s, b"" if s == 204 else CALLER if s < 300 else {"reason": "unknown", "retryable": False})
                for s in statuses]
    got, _ = run(lookup_many(tmp_path, handlers))
    assert dict(zip(statuses, got)) == {s: UNAVAILABLE for s in statuses}


def test_a_redirect_is_not_followed(tmp_path):
    async def handler(req, receive, send):
        if req["path"] == "/lookup":
            await respond(send, 307, b"", extra=[(b"location", b"/elsewhere")])
        else:
            await respond(send, 200, json.dumps(CALLER).encode())
    got, seen = run(lookup_once(tmp_path, handler))
    assert got == UNAVAILABLE
    assert [r["path"] for r in seen] == ["/lookup"], "the redirect target was never asked"


def test_a_timeout_is_core_unavailable(tmp_path):
    async def slow(req, receive, send):
        await asyncio.sleep(1.0)
        await respond(send, 200, json.dumps(CALLER).encode())

    async def go():
        async with serve(Scripted(slow)) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=0.2)
            t0 = time.monotonic()
            got = await a.resolve(CRED, "read")
            took = time.monotonic() - t0
            await a.aclose()
        return got, took
    got, took = run(go())
    assert got == UNAVAILABLE
    assert took < 0.9, took


def test_a_refused_connection_is_core_unavailable(tmp_path):
    async def go():
        async with serve(Scripted(answer(200, CALLER))) as base:
            pass  # the server is gone: its port refuses
        a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=1.0)
        try:
            return await a.resolve(CRED, "read")
        finally:
            await a.aclose()
    assert run(go()) == UNAVAILABLE


# ---- the request ----

def test_the_request_carries_the_token_and_the_documented_body(tmp_path):
    async def go():
        app = Scripted(answer(200, CALLER))
        async with serve(app) as base:
            a = HttpSessionLookup(base + "/", token_file(tmp_path), timeout_s=2.0)
            await a.resolve(CRED, "read", csrf_token="ignored-on-a-read", origin=None, sec_fetch_site="same-origin")
            await a.resolve(CRED, "write", csrf_token="synthetic_csrf", origin="https://reader.example.test",
                            sec_fetch_site="cross-site")
            await a.resolve(CRED, "write", csrf_token=None, origin="o" * 3000, sec_fetch_site="s" * 40)
            await a.aclose()
        return app.seen
    seen = run(go())
    val = LOOKUP.schema_validator("LookupRequest")
    assert [r["path"] for r in seen] == ["/lookup"] * 3 and all(r["method"] == "POST" for r in seen)
    assert all(r["headers"].get("authorization") == "Bearer " + TOKEN for r in seen)
    assert seen[0]["body"] == {"credential": CRED, "purpose": "read", "origin": None, "sec_fetch_site": "same-origin"}
    assert seen[1]["body"] == {"credential": CRED, "purpose": "write", "origin": "https://reader.example.test",
                               "sec_fetch_site": "cross-site", "csrf_token": "synthetic_csrf"}
    assert seen[2]["body"] == {"credential": CRED, "purpose": "write", "origin": None, "sec_fetch_site": None}
    for r in seen:
        assert val.is_valid(r["body"]), r["body"]


def test_a_credential_no_session_can_have_is_unknown_without_asking(tmp_path):
    async def go():
        app = Scripted(answer(200, CALLER))
        async with serve(app) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0)
            got = [await a.resolve("", "read"), await a.resolve("c" * 4097, "read")]
            await a.aclose()
        return got, app.seen
    got, seen = run(go())
    assert got == [Denied("unknown")] * 2 and seen == []


def test_the_token_file_is_read_again_when_it_changes(tmp_path):
    async def go():
        app = Scripted(answer(200, CALLER))
        async with serve(app) as base:
            p = token_file(tmp_path)
            a = HttpSessionLookup(base, p, timeout_s=2.0)
            await a.resolve(CRED, "read")
            p.write_text("synthetic-rotated-token-0002\n")
            st = p.stat()
            os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
            await a.resolve(CRED, "read")
            await a.aclose()
        return app.seen
    seen = run(go())
    assert [r["headers"]["authorization"] for r in seen] == ["Bearer " + TOKEN, "Bearer synthetic-rotated-token-0002"]


@pytest.mark.parametrize("content", [None, "", "   \n", "two words"], ids=["missing", "empty", "blank", "spaces"])
def test_no_usable_token_is_core_unavailable_and_nothing_is_sent(tmp_path, content):
    async def go():
        app = Scripted(answer(200, CALLER))
        async with serve(app) as base:
            p = tmp_path / "service.token"
            if content is not None:
                p.write_text(content)
            a = HttpSessionLookup(base, p, timeout_s=2.0)
            got = await a.resolve(CRED, "read")
            await a.aclose()
        return got, app.seen
    got, seen = run(go())
    assert got == UNAVAILABLE and seen == []


def test_the_token_and_the_credential_never_reach_the_logs(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)

    async def go():
        statuses = iter([200, 401, 503, 500, 403])
        out = []

        async def handler(req, receive, send):
            if req["path"] == "/revocations":
                return await respond(send, 401, b'{"code":"service_unauthorized"}')
            st = next(statuses)
            body = CALLER if st == 200 else {"reason": "unknown", "retryable": False}
            await respond(send, st, json.dumps(body).encode())
        app = Scripted(handler)
        async with serve(app) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0)
            for _ in range(5):
                out.append(await a.resolve(CRED, "read"))
            out += [x async for x in a.revocations()]
            out.append(repr(a))
            await a.aclose()
        b = HttpSessionLookup(base, token_file(tmp_path), timeout_s=0.5)  # the port is closed now
        out.append(await b.resolve(CRED, "read"))
        await b.aclose()
        return out, app.seen
    out, seen = run(go())
    assert seen and all(r["headers"]["authorization"] == "Bearer " + TOKEN for r in seen), "the token was sent"
    assert caplog.records, "the failures were logged"
    assert TOKEN not in caplog.text and CRED not in caplog.text
    assert all(TOKEN not in repr(x) for x in out)


# ---- the revocation feed ----

def feed(chunks, *, then_silent=False, heartbeat_s=None):
    """A /revocations handler sending `chunks` (bytes, or a float to sleep) then idling."""
    async def handler(req, receive, send):
        pending = list(chunks)

        async def next_chunk():
            while pending:
                c = pending.pop(0)
                if isinstance(c, float):
                    await asyncio.sleep(c)
                    continue
                return c
            if then_silent:
                await asyncio.Event().wait()
            return None
        await stream_until_disconnect(receive, send, next_chunk, heartbeat_s=heartbeat_s)
    return handler


async def collect(tmp_path, handler, *, silence=5.0, bound=5.0, subscribe=30.0):
    app = Scripted(handler)
    items = []
    async with serve(app) as base:
        a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0, feed_silence_s=silence,
                              subscribe_timeout_s=subscribe)
        t0 = time.monotonic()

        async def drain():
            async for item in a.revocations():
                items.append(item)
        try:
            await asyncio.wait_for(drain(), bound)
            ended = True
        except asyncio.TimeoutError:
            ended = False
        took = time.monotonic() - t0
        await a.aclose()
    return items, ended, took, app.seen


def test_the_feed_yields_subscribed_then_revocations_and_skips_comments(tmp_path):
    chunks = [sse({"type": "subscribed"}), HEARTBEAT, b": another comment\n\n", b"event: revocation\nid: 7\n",
              sse({"type": "revocation", "session_ref": "ses_synthetic_0001", "reason": "revoked"}),
              b'data: {"type":"revocation",\r\ndata: "session_ref":"ses_synthetic_0002","reason":"expired"}\r\n\r\n']
    items, ended, _, seen = run(collect(tmp_path, feed(chunks)))
    assert items == [Subscribed(), Revocation("ses_synthetic_0001", "revoked"),
                     Revocation("ses_synthetic_0002", "expired")]
    assert ended, "the feed ends when the core ends the stream"
    assert seen[0]["path"] == "/revocations" and seen[0]["headers"]["authorization"] == "Bearer " + TOKEN


def test_a_split_frame_is_reassembled(tmp_path):
    frame = sse({"type": "revocation", "session_ref": "ses_synthetic_0003", "reason": "revoked"})
    chunks = [sse({"type": "subscribed"}), frame[:7], 0.05, frame[7:20], 0.05, frame[20:]]
    items, _, _, _ = run(collect(tmp_path, feed(chunks)))
    assert items == [Subscribed(), Revocation("ses_synthetic_0003", "revoked")]


def test_the_feed_ends_after_silence_past_its_bound(tmp_path):
    items, ended, took, _ = run(collect(tmp_path, feed([sse({"type": "subscribed"})], then_silent=True),
                                        silence=0.3, bound=3.0))
    assert items == [Subscribed()]
    assert ended, "a silent feed must end (the facade then counts it down)"
    assert 0.25 <= took < 2.0, took


def test_heartbeats_keep_the_feed_up_past_the_silence_bound(tmp_path):
    rev = sse({"type": "revocation", "session_ref": "ses_synthetic_0004", "reason": "revoked"})
    chunks = [sse({"type": "subscribed"})] + [0.1, HEARTBEAT] * 8 + [rev]
    items, ended, took, _ = run(collect(tmp_path, feed(chunks), silence=0.4, bound=5.0))
    assert items == [Subscribed(), Revocation("ses_synthetic_0004", "revoked")]
    assert took >= 0.8, "the feed outlived twice its silence bound on heartbeats alone"


@pytest.mark.parametrize("status", [401, 403, 404, 500, 503])
def test_a_feed_that_is_not_200_ends_at_once(tmp_path, status):
    items, ended, took, _ = run(collect(tmp_path, answer(status, {"code": "service_unauthorized"})))
    assert items == [] and ended and took < 2.0


def test_a_feed_that_is_not_an_event_stream_ends(tmp_path):
    items, ended, _, _ = run(collect(tmp_path, answer(200, {"type": "subscribed"})))
    assert items == [] and ended


@pytest.mark.parametrize("bad", [b"data: {not json\n\n", b'data: {"type":"revocation","reason":"revoked"}\n\n',
                                 b'data: ["subscribed"]\n\n', b"data: " + b"x" * 70_000,
                                 b'data: {"type":"future_kind"}\n\n',
                                 b'data: {"type":"revocation","session_ref":"s","reason":"logged_out"}\n\n',
                                 b'data: {"type":"revocation","session_ref":"s","reason":"revoked","x":1}\n\n'],
                         ids=["not json", "revocation without session_ref", "not an object", "line too long",
                              "unknown type", "reason outside the enum", "extra member"])
def test_a_malformed_feed_item_ends_the_feed(tmp_path, bad):
    items, ended, _, _ = run(collect(tmp_path, feed([sse({"type": "subscribed"}), bad], then_silent=True)))
    assert items == [Subscribed()] and ended


def test_a_feed_that_cannot_connect_ends(tmp_path):
    async def go():
        async with serve(Scripted(answer(200, CALLER))) as base:
            pass
        a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=1.0)
        items = [x async for x in a.revocations()]
        await a.aclose()
        return items
    assert run(go()) == []


def test_the_resolver_marks_the_feed_down_when_it_goes_silent(tmp_path):
    """End to end with the facade's resolver: up on subscribed, down after the silence bound, caching off."""
    async def go():
        app = Scripted(feed([sse({"type": "subscribed"})], then_silent=True))
        async with serve(app) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0, feed_silence_s=0.3)
            r = SessionResolver(a, feed_retry_s=30)
            r.ensure_feed()
            for _ in range(100):
                if r.feed_up:
                    break
                await asyncio.sleep(0.01)
            assert r.feed_up, "subscribed marks the feed up"
            await asyncio.sleep(0.8)
            assert not r.feed_up, "silence past the bound marks it down"
            r._feed_task.cancel()
            await a.aclose()
    run(go())


def test_the_bound_defaults_to_fifty_seconds(tmp_path):
    a = HttpSessionLookup("http://127.0.0.1:9", token_file(tmp_path), timeout_s=1.0)
    assert a.feed_silence_s == 50.0
    asyncio.run(a.aclose())


# ---- a refused service token is a configuration fault ----

def _errors(caplog):
    return [r for r in caplog.records if r.name == "mecon_reader_backend.http_lookup" and r.levelno == logging.ERROR]


def test_a_refused_token_is_logged_at_error_once_per_change_of_state(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    statuses = [401, 401, 401, 200, 200, 401, 401, 503]

    async def go():
        pending = list(statuses)

        async def handler(req, receive, send):
            st = pending.pop(0)
            body = CALLER if st == 200 else {"code": "service_unauthorized"} if st == 401 else \
                {"reason": "core_unavailable", "retryable": True}
            await respond(send, st, json.dumps(body).encode())
        states, answers = [], []
        async with serve(Scripted(handler)) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0)
            states.append(a.health_state)
            for _ in statuses:
                answers.append(await a.resolve(CRED, "read"))
                states.append(a.health_state)
            await a.aclose()
        return states, answers
    states, answers = run(go())
    assert states == ["unknown", "service_unauthorized", "service_unauthorized", "service_unauthorized", "ok", "ok",
                      "service_unauthorized", "service_unauthorized", "unavailable"]
    assert [x == UNAVAILABLE for x in answers] == [s != 200 for s in statuses], "a 401 still answers core_unavailable"
    errors = [r.getMessage() for r in _errors(caplog)]
    assert len(errors) == 4, errors  # starts, stops (ok), starts again, stops (unavailable)
    assert "refuses" in errors[0] and "again" in errors[1] and "refuses" in errors[2] and "again" in errors[3]
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings == ["session lookup answered 503"], "the 401s are not logged as an outage, the 503 is"


def test_a_feed_refused_its_token_reports_the_state_once(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)

    async def go():
        async with serve(Scripted(answer(401, {"code": "service_unauthorized"}))) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0)
            for _ in range(3):
                assert [x async for x in a.revocations()] == []
            await a.aclose()
        return a.health_state
    assert run(go()) == "service_unauthorized"
    assert len(_errors(caplog)) == 1


def test_the_health_output_reports_the_lookup_state(tmp_path):
    from mecon_reader_backend import FacadeConfig, create_app
    from mecon_reader_backend.app import PREFIX
    from mecon_reader_backend.fakes import build
    import httpx
    from replay import BASE, WORLDS, schema_validator

    statuses = [401, 200, 503]

    async def go():
        pending = list(statuses)

        async def handler(req, receive, send):
            st = pending.pop(0)
            body = CALLER if st == 200 else {"code": "service_unauthorized"} if st == 401 else {}
            await respond(send, st, json.dumps(body).encode())
        bodies = []
        _, fake_lookup, core = build(WORLDS["worlds"]["two-fleets"])
        async with serve(Scripted(handler)) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0)
            app = create_app(a, core, FacadeConfig())
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE) as c:
                bodies.append((await c.get(PREFIX + "/health")).json())
                for _ in statuses:
                    await a.resolve(CRED, "read")
                    bodies.append((await c.get(PREFIX + "/health")).json())
            await a.aclose()
        fake_app = create_app(fake_lookup, core, FacadeConfig())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=fake_app), base_url=BASE) as c:
            fake_body = (await c.get(PREFIX + "/health")).json()
        return bodies, fake_body
    bodies, fake_body = run(go())
    assert [b["session_lookup"] for b in bodies] == ["unknown", "service_unauthorized", "ok", "unavailable"]
    val = schema_validator("Health")
    assert all(val.is_valid(b) for b in bodies + [fake_body])
    assert "session_lookup" not in fake_body, "a lookup without a state adds nothing"


# ---- the wait for subscribed is bounded ----

def test_a_feed_that_heartbeats_but_never_subscribes_ends(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    items, ended, took, _ = run(collect(tmp_path, feed([], then_silent=True, heartbeat_s=0.05),
                                        silence=5.0, subscribe=0.3, bound=3.0))
    assert items == [] and ended, "no subscribed within the bound ends the feed"
    assert 0.25 <= took < 2.0, took
    assert any("no subscribed" in r.getMessage() and r.levelno == logging.WARNING for r in caplog.records)


def test_a_feed_that_subscribes_in_time_stays_up_past_the_subscribe_bound(tmp_path):
    rev = sse({"type": "revocation", "session_ref": "ses_synthetic_0005", "reason": "revoked"})
    chunks = [HEARTBEAT, 0.1, sse({"type": "subscribed"})] + [0.1, HEARTBEAT] * 6 + [rev]
    items, ended, took, _ = run(collect(tmp_path, feed(chunks), silence=5.0, subscribe=0.3))
    assert items == [Subscribed(), Revocation("ses_synthetic_0005", "revoked")] and took >= 0.6


def test_the_resolver_resubscribes_a_feed_that_never_subscribes(tmp_path):
    async def go():
        app = Scripted(feed([], then_silent=True, heartbeat_s=0.05))
        async with serve(app) as base:
            a = HttpSessionLookup(base, token_file(tmp_path), timeout_s=2.0, feed_silence_s=5.0,
                                  subscribe_timeout_s=0.2)
            r = SessionResolver(a, feed_retry_s=0.05)
            r.ensure_feed()
            await asyncio.sleep(1.0)
            up = r.feed_up
            r._feed_task.cancel()
            await a.aclose()
        return up, sum(1 for s in app.seen if s["path"] == "/revocations")
    up, subscriptions = run(go())
    assert not up and subscriptions >= 3, subscriptions


def test_the_subscribe_bound_defaults_to_thirty_seconds(tmp_path):
    a = HttpSessionLookup("http://127.0.0.1:9", token_file(tmp_path), timeout_s=1.0)
    assert a.subscribe_timeout_s == 30.0 and a.health_state == "unknown"
    asyncio.run(a.aclose())


def test_the_feed_item_check_agrees_with_the_document():
    val = LOOKUP.schema_validator("RevocationItem")
    items = [{"type": "subscribed"}, {"type": "subscribed", "x": 1}, {"type": "revocation"},
             {"type": "revocation", "session_ref": "s", "reason": "revoked"},
             {"type": "revocation", "session_ref": "s", "reason": "expired"},
             {"type": "revocation", "session_ref": "", "reason": "revoked"},
             {"type": "revocation", "session_ref": "s", "reason": "other"},
             {"type": "revocation", "session_ref": 1, "reason": "revoked"},
             {"type": "revocation", "session_ref": "s", "reason": "revoked", "x": 1},
             {"type": "future_kind"}, {"type": 1}, {}, [], None, "subscribed"]

    def readable(item):
        try:
            parse_revocation_item(item)
            return True
        except _Malformed:
            return False
    disagreements = [i for i in items if val.is_valid(i) != readable(i)]
    assert not disagreements, disagreements
