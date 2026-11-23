"""The facade's own rules, tested apart from the published cases."""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from mecon_reader_backend import FacadeConfig, create_app
from mecon_reader_backend.app import COOKIE, PREFIX
from mecon_reader_backend.fakes import build
from mecon_reader_backend.ports import Denied
from replay import BASE, SAME_ORIGIN, WORLDS, asgi_get_stream, parse_sse, schema_validator

ERROR_KEYS = {"code", "message", "request_id", "retryable"}


class Rig:
    def __init__(self, lookup_wrap=None, **cfg):
        self.world, self.lookup, self.core = build(WORLDS["worlds"]["two-fleets"])
        self.world.reader_origins = (SAME_ORIGIN,)
        self.port = lookup_wrap(self.lookup) if lookup_wrap else self.lookup
        cfg.setdefault("reader_origins", (SAME_ORIGIN,))
        self.app = create_app(self.port, self.core, FacadeConfig(**cfg))

    def client(self, user=None):
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=BASE,
                              headers={"Origin": SAME_ORIGIN})
        if user:
            self.session = self.world.mint_session(user)
            c.cookies.set(COOKIE, self.session.credential, domain="reader.example.test", path="/")
        return c

    async def feed_up(self, c):
        """Start the revocation feed with a first request and wait until it is confirmed (caching on)."""
        await c.get(PREFIX + "/health")
        await c.get(PREFIX + "/session")
        for _ in range(50):
            if self.app.state.sessions.feed_up:
                return
            await asyncio.sleep(0.01)
        raise AssertionError("the revocation feed never subscribed")

    async def csrf(self, c):
        r = await c.get(PREFIX + "/session")
        assert r.status_code == 200
        return r.json()["csrf_token"]


def run(coro):
    return asyncio.run(coro)


class Recording:
    """Wraps a lookup and records every resolve call."""

    def __init__(self, inner):
        self.inner, self.calls = inner, []

    async def resolve(self, credential, purpose, *, csrf_token=None, origin=None):
        self.calls.append({"purpose": purpose, "csrf_token": csrf_token, "origin": origin})
        if purpose == "write":
            return await self.inner.resolve(credential, purpose, csrf_token=csrf_token, origin=origin)
        return await self.inner.resolve(credential, purpose)

    def revocations(self):
        return self.inner.revocations()


def assert_error(r, status, code=None, retryable=None):
    assert r.status_code == status, r.text
    body = r.json()
    assert set(body) == ERROR_KEYS
    assert isinstance(body["retryable"], bool)
    if code is not None:
        assert body["code"] == code
    if retryable is not None:
        assert body["retryable"] is retryable
    assert r.headers.get("cache-control") == "no-store"


# ---- fail closed on every lookup denial ----

@pytest.mark.parametrize("path", ["/session", "/devices", "/conversations", "/leases/keys"])
def test_core_unavailable_is_503_retryable_and_keeps_the_cookie(path):
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            rig.lookup.unavailable = True
            r = await c.get(PREFIX + path)
            assert_error(r, 503, "unavailable", True)
            assert "set-cookie" not in r.headers
    run(go())


def test_core_unavailable_refuses_a_write_and_the_stream():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            token = await rig.csrf(c)
            rig.lookup.unavailable = True
            r = await c.post(PREFIX + "/logout", headers={"X-CSRF-Token": token})
            assert_error(r, 503, "unavailable", True)
            assert rig.world.sessions[rig.session.credential].revoked is False
            status, _, raw = await asgi_get_stream(rig.app, PREFIX + "/events",
                                                   {"Cookie": f"{COOKIE}={rig.session.credential}"},
                                                   bound_s=1.0, until_heartbeat=True)
            assert status == 503 and b"heartbeat" not in raw
    run(go())


class Raising:
    def __init__(self, inner, exc=None, delay=None, answer=None):
        self.inner, self.exc, self.delay, self.answer = inner, exc, delay, answer

    async def resolve(self, credential, purpose, **kw):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        if self.answer is not None:
            return self.answer(await self.inner.resolve(credential, purpose, **kw))
        return await self.inner.resolve(credential, purpose, **kw)

    def revocations(self):
        return self.inner.revocations()


@pytest.mark.parametrize("kind", ["error", "timeout", "malformed", "unknown_reason", "short_csrf"])
def test_lookup_failures_fail_closed(kind):
    wraps = {
        "error": lambda inner: Raising(inner, exc=RuntimeError("down")),
        "timeout": lambda inner: Raising(inner, delay=0.5),
        "malformed": lambda inner: Raising(inner, answer=lambda a: {"user_id": "x"}),
        "unknown_reason": lambda inner: Raising(inner, answer=lambda a: Denied("maybe")),
        "short_csrf": lambda inner: Raising(inner, answer=lambda a: replace(a, csrf_token="short")),
    }

    async def go():
        rig = Rig(lookup_wrap=wraps[kind], lookup_timeout_s=0.1)
        async with rig.client("alice") as c:
            assert_error(await c.get(PREFIX + "/session"), 503, "unavailable", True)
    run(go())


def test_an_expired_caller_is_never_served_and_the_cookie_is_cleared():
    past = datetime.now(timezone.utc) - timedelta(seconds=1)

    async def go():
        rig = Rig(lookup_wrap=lambda inner: Raising(inner, answer=lambda a: replace(a, expires_at=past)))
        async with rig.client("alice") as c:
            r = await c.get(PREFIX + "/devices")
            assert_error(r, 401, "unauthenticated", False)
            assert COOKIE in r.headers.get("set-cookie", "") and "max-age=0" in r.headers["set-cookie"].lower()
    run(go())


@pytest.mark.parametrize("how", ["revoked", "expired", "unknown"])
def test_denials_are_401_and_clear_the_cookie(how):
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            s = rig.session
            if how == "revoked":
                s.revoked = True
            elif how == "expired":
                s.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            else:
                c.cookies.set(COOKIE, "not-a-session", domain="reader.example.test", path="/")
            r = await c.get(PREFIX + "/session")
            assert_error(r, 401, "unauthenticated", False)
            assert "max-age=0" in r.headers.get("set-cookie", "").lower()
    run(go())


# ---- writes always reach the lookup with their CSRF token and Origin ----

def test_every_write_reaches_the_lookup_with_token_and_origin():
    async def go():
        rig = Rig(lookup_wrap=Recording)
        async with rig.client("alice") as c:
            token = await rig.csrf(c)
            await c.get(PREFIX + "/session")  # a cached read
            rig.port.calls.clear()
            r = await c.post(PREFIX + "/leases", headers={"X-CSRF-Token": token})
            assert r.status_code == 200
            r = await c.post(PREFIX + "/leases", headers={"X-CSRF-Token": token})
            assert r.status_code == 200
            assert rig.port.calls == [{"purpose": "write", "csrf_token": token, "origin": SAME_ORIGIN}] * 2
            rig.port.calls.clear()
            r = await c.post(PREFIX + "/logout", headers={"X-CSRF-Token": "w" * 43, "Origin": "https://foreign.example.test"})
            assert_error(r, 403, "origin_rejected")
            assert rig.port.calls == [{"purpose": "write", "csrf_token": "w" * 43, "origin": "https://foreign.example.test"}]
    run(go())


def test_reads_are_cached_briefly_and_dropped_on_logout():
    async def go():
        rig = Rig(lookup_wrap=Recording)
        async with rig.client("alice") as c:
            token = await rig.csrf(c)
            await rig.feed_up(c)
            rig.port.calls.clear()
            await c.get(PREFIX + "/devices")
            await c.get(PREFIX + "/devices")
            reads = [x for x in rig.port.calls if x["purpose"] == "read"]
            assert len(reads) == 1  # the second read came from the cache
            assert (await c.post(PREFIX + "/logout", headers={"X-CSRF-Token": token})).status_code == 204
            c.cookies.set(COOKIE, rig.session.credential, domain="reader.example.test", path="/")
            assert_error(await c.get(PREFIX + "/session"), 401, "unauthenticated")
    run(go())


def test_a_revocation_from_the_feed_drops_the_cached_caller():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            await rig.feed_up(c)
            assert (await c.get(PREFIX + "/session")).status_code == 200  # now cached
            assert rig.session.credential in rig.app.state.sessions._cache
            rig.world.revoke(rig.session)
            await asyncio.sleep(0.05)
            assert_error(await c.get(PREFIX + "/session"), 401, "unauthenticated")
    run(go())


def test_the_cache_bound_is_five_seconds_by_default():
    assert FacadeConfig().lookup_cache_s == 5.0


# ---- Idempotency-Key ----

def _send_body(rig, key="att_k1"):
    w = rig.world
    return {"client_draft_id": "drf_1", "client_attempt_id": key, "identity_id": w.id_of("identities", "alice_id"),
            "target": {"kind": "contact", "id": w.id_of("contacts", "bob")}, "content": {"kind": "text", "text": "hi"}}


@pytest.mark.parametrize("key", [None, "att_other", ""])
def test_idempotency_key_must_equal_the_attempt_id(key):
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            token = await rig.csrf(c)
            headers = {"X-CSRF-Token": token}
            if key is not None:
                headers["Idempotency-Key"] = key
            r = await c.post(PREFIX + "/send-attempts", headers=headers, json=_send_body(rig))
            assert_error(r, 422, "invalid", False)
            assert rig.world.attempts == {}
            headers["Idempotency-Key"] = "att_k1"
            r = await c.post(PREFIX + "/send-attempts", headers=headers, json=_send_body(rig))
            assert r.status_code == 201
    run(go())


# ---- headers, cookie, errors ----

def test_no_store_on_every_answer():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            for path in ("/health", "/session", "/devices", "/identities", "/conversations", "/contacts",
                         "/channels", "/leases/keys", "/conversations/nope"):
                r = await c.get(PREFIX + path)
                assert r.headers.get("cache-control") == "no-store", path
    run(go())


def test_the_session_cookie_is_host_only_secure_httponly():
    async def go():
        rig = Rig()
        async with rig.client() as c:
            r = await c.post(PREFIX + "/login", json={"email": "alice@example.test"})
            req = r.json()["request_id"]
            rig.core.approve_login(req)
            r = await c.get(PREFIX + "/login/" + req)
            assert r.json()["state"] == "approved"
            sc = r.headers["set-cookie"]
            attrs = [a.strip().lower() for a in sc.split(";")]
            assert sc.startswith(COOKIE + "=")
            assert "secure" in attrs and "httponly" in attrs and "path=/" in attrs
            assert not any(a.startswith("domain") for a in attrs)
            assert "samesite=strict" in attrs
    run(go())


@pytest.mark.parametrize("origin", [None, "https://foreign.example.test", "null"])
def test_login_needs_the_readers_origin(origin):
    async def go():
        rig = Rig()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=rig.app), base_url=BASE) as c:
            headers = {"Origin": origin} if origin else {}
            r = await c.post(PREFIX + "/login", headers=headers, json={"email": "alice@example.test"})
            assert_error(r, 403, "origin_rejected")
    run(go())


def test_malformed_poll_ids_read_expired():
    async def go():
        rig = Rig()
        async with rig.client() as c:
            r = await c.get(PREFIX + "/login/short")
            assert r.status_code == 200 and r.json() == {"state": "expired"}
    run(go())


@pytest.mark.parametrize("q", ["limit=0", "limit=201", "limit=x", "cursor=" + "c" * 513])
def test_bad_query_parameters_are_422(q):
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            assert_error(await c.get(PREFIX + "/devices?" + q), 422, "invalid", False)
    run(go())


def test_a_core_error_the_operation_does_not_declare_is_not_passed_on():
    from mecon_reader_backend.ports import CoreError

    async def go():
        rig = Rig()

        async def conflict(*a, **k):
            raise CoreError("conflict")
        rig.core.list_devices = conflict

        async def forbidden(*a, **k):
            raise CoreError("forbidden")
        rig.core.get_conversation = forbidden
        async with rig.client("alice") as c:
            assert_error(await c.get(PREFIX + "/devices"), 503, "unavailable", True)
            assert_error(await c.get(PREFIX + "/conversations/x"), 404, "not_found", False)
    run(go())


# ---- the event stream ----

async def _open_stream(rig, cursor_header=None):
    headers = {"Cookie": f"{COOKIE}={rig.session.credential}"}
    if cursor_header:
        headers["Last-Event-ID"] = cursor_header
    return headers


def test_the_stream_closes_on_revocation_without_replaying_anything():
    async def go():
        rig = Rig(heartbeat_s=0.2)
        async with rig.client("alice"):
            pass
        headers = await _open_stream(rig)

        async def revoke_soon():
            await asyncio.sleep(0.4)
            rig.world.revoke(rig.session)
            rig.world.emit({"alice"}, "attempt_status", "att_after_revocation")
        t = asyncio.ensure_future(revoke_soon())
        status, _, raw, ended = await asgi_get_stream(rig.app, PREFIX + "/events", headers, bound_s=3.0,
                                                      until_heartbeat=False)
        await t
        assert status == 200
        assert ended, "the stream stayed open after its session was revoked"
        frames = parse_sse(raw)
        assert frames and frames[-1]["kind"] == "session_revoked" and frames[-1]["resource_id"] is None
        assert [f["kind"] for f in frames].count("session_revoked") == 1  # sent once
        assert not list(schema_validator("EventEnvelope").iter_errors(frames[-1]))
        assert all(f.get("resource_id") != "att_after_revocation" for f in frames)
        assert not raw.rstrip().endswith(b": heartbeat")
        last = [b for b in raw.split(b"\n\n") if b"data:" in b][-1]
        assert not any(ln.startswith(b"id:") for ln in last.split(b"\n")), "the revocation frame is not a resume point"
    run(go())


def test_another_sessions_revocation_leaves_the_stream_open():
    async def go():
        rig = Rig(heartbeat_s=0.2)
        other = rig.world.mint_session("carol")
        async with rig.client("alice"):
            pass
        headers = await _open_stream(rig)

        async def revoke_soon():
            await asyncio.sleep(0.3)
            rig.world.revoke(other)
        t = asyncio.ensure_future(revoke_soon())
        status, _, raw, ended = await asgi_get_stream(rig.app, PREFIX + "/events", headers, bound_s=1.0,
                                                      until_heartbeat=False)
        await t
        assert status == 200 and not ended
        assert raw.count(b": heartbeat") >= 2  # heartbeats repeat while idle
    run(go())


def test_the_stream_closes_once_the_revocation_feed_is_down_too_long():
    class DeadFeed(Recording):
        async def _dead(self):
            raise ConnectionError("feed down")
            yield  # pragma: no cover

        def revocations(self):
            return self._dead()

    async def go():
        rig = Rig(lookup_wrap=DeadFeed, heartbeat_s=0.2, feed_down_close_s=0.3, feed_retry_s=5.0)
        async with rig.client("alice"):
            pass
        headers = await _open_stream(rig)
        status, _, raw, ended = await asgi_get_stream(rig.app, PREFIX + "/events", headers, bound_s=3.0,
                                                      until_heartbeat=False)
        assert status == 200 and ended
    run(go())


def test_new_events_arrive_on_an_open_stream_with_their_cursor_as_id():
    async def go():
        rig = Rig(heartbeat_s=5)
        async with rig.client("alice"):
            pass
        headers = await _open_stream(rig)

        async def later():
            await asyncio.sleep(0.3)
            rig.world.emit({"alice"}, "attempt_status", "att_x")
            rig.world.emit({"carol"}, "attempt_status", "att_carol")
        t = asyncio.ensure_future(later())
        status, _, raw, _ = await asgi_get_stream(rig.app, PREFIX + "/events", headers, bound_s=1.0,
                                                  until_heartbeat=False)
        await t
        frames = parse_sse(raw)
        assert [f["resource_id"] for f in frames] == ["att_x"]
        assert f"id: {frames[0]['event_id']}".encode() in raw
    run(go())


@pytest.mark.parametrize("how", ["unavailable", "revoked_without_feed"])
def test_a_cached_caller_is_not_served_past_the_cache_bound(how):
    async def go():
        rig = Rig(lookup_cache_s=0.05)
        async with rig.client("alice") as c:
            await rig.feed_up(c)
            assert (await c.get(PREFIX + "/session")).status_code == 200
            assert rig.session.credential in rig.app.state.sessions._cache
            if how == "unavailable":
                rig.lookup.unavailable = True
            else:
                rig.world.sessions[rig.session.credential].revoked = True  # the feed never hears of it
            await asyncio.sleep(0.1)
            r = await c.get(PREFIX + "/session")
            assert r.status_code == (503 if how == "unavailable" else 401)
    run(go())


def test_a_cached_caller_is_not_served_past_its_expiry():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            rig.world.sessions[rig.session.credential].expires_at = datetime.now(timezone.utc) + timedelta(seconds=1)
            await rig.feed_up(c)
            assert (await c.get(PREFIX + "/session")).status_code == 200
            assert rig.session.credential in rig.app.state.sessions._cache
            await asyncio.sleep(1.1)
            assert_error(await c.get(PREFIX + "/session"), 401, "unauthenticated")
    run(go())


# ---- session_ref, never the cookie value ----

def test_streams_are_matched_by_session_ref_never_by_cookie_value():
    from mecon_reader_backend.ports import Revocation

    async def go():
        rig = Rig(heartbeat_s=0.2)
        async with rig.client("alice"):
            pass
        cred = rig.session.credential
        ref = rig.world.session_ref(rig.session)
        assert ref not in (cred, rig.session.id) and cred not in ref
        headers = await _open_stream(rig)
        sessions = rig.app.state.sessions
        seen = {}

        async def drive():
            await asyncio.sleep(0.3)
            seen["keys"] = set(sessions._streams)
            for q in rig.world.revocation_queues:
                q.put_nowait(Revocation(cred))  # a revocation naming the cookie value matches nothing
            await asyncio.sleep(0.3)
            seen["open_after_cookie_revocation"] = ref in sessions._streams
            rig.world.revoke(rig.session)
        t = asyncio.ensure_future(drive())
        status, _, raw, ended = await asgi_get_stream(rig.app, PREFIX + "/events", headers, bound_s=3.0,
                                                      until_heartbeat=False)
        await t
        assert seen["keys"] == {ref}
        assert seen["open_after_cookie_revocation"]
        assert status == 200 and ended and parse_sse(raw)[-1]["kind"] == "session_revoked"
    run(go())


# ---- the login Origin is the core's to check: a listed Origin OR Sec-Fetch-Site same-origin ----

OTHER_LISTED = "https://other-reader.example.test"
FOREIGN = "https://foreign.example.test"
ALLOW = (SAME_ORIGIN, OTHER_LISTED)
LOGIN_ORIGIN_MATRIX = [
    # (Origin, Sec-Fetch-Site, accepted)
    (OTHER_LISTED, "cross-site", True),  # the allow-list branch
    (SAME_ORIGIN, None, True),
    (None, "same-origin", True),  # the Sec-Fetch-Site branch
    (FOREIGN, "same-origin", True),
    (SAME_ORIGIN + "/", None, True),  # trailing slash stripped
    (OTHER_LISTED + "//", "cross-site", True),
    (None, None, False),
    (FOREIGN, None, False),
    (FOREIGN, "cross-site", False),
    (None, "cross-site", False),
    (FOREIGN + "/", "same-site", False),
    ("null", None, False),
]
MATRIX_IDS = [f"{o or 'absent'}|{f or 'absent'}|{'accept' if a else 'refuse'}" for o, f, a in LOGIN_ORIGIN_MATRIX]


def _login_rig(precheck):
    rig = Rig(login_origin_precheck=precheck, reader_origins=ALLOW)
    rig.core.login_origins = list(ALLOW)
    calls = []
    inner = rig.core.start_login

    async def recording(email, **kw):
        calls.append(kw)
        return await inner(email, **kw)
    rig.core.start_login = recording
    return rig, calls


async def _post_login(rig, origin, sfs):
    headers = {}
    if origin is not None:
        headers["Origin"] = origin
    if sfs is not None:
        headers["Sec-Fetch-Site"] = sfs
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=rig.app), base_url=BASE) as c:
        return await c.post(PREFIX + "/login", headers=headers, json={"email": "alice@example.test"})


@pytest.mark.parametrize("origin,sfs,accepted", LOGIN_ORIGIN_MATRIX, ids=MATRIX_IDS)
def test_the_core_applies_the_login_origin_rule_on_its_own(origin, sfs, accepted):
    async def go():
        rig, calls = _login_rig(precheck=False)
        r = await _post_login(rig, origin, sfs)
        assert calls == [{"origin": origin, "sec_fetch_site": sfs}]  # every request reached the core
        if accepted:
            assert r.status_code == 202 and len(rig.world.logins) == 1
        else:
            assert_error(r, 403, "origin_rejected", False)
            assert rig.world.logins == {}
    run(go())


@pytest.mark.parametrize("origin,sfs,accepted", LOGIN_ORIGIN_MATRIX, ids=MATRIX_IDS)
def test_the_facade_precheck_applies_the_same_rule(origin, sfs, accepted):
    async def go():
        rig, calls = _login_rig(precheck=True)
        r = await _post_login(rig, origin, sfs)
        if accepted:
            assert r.status_code == 202, r.text  # the pre-check never refuses what the core accepts
            assert calls == [{"origin": origin, "sec_fetch_site": sfs}]
        else:
            assert_error(r, 403, "origin_rejected", False)
            assert calls == []  # refused by the facade, before the core
    run(go())


def test_the_core_allow_list_defaults_to_the_readers_own_origin():
    async def go():
        rig = Rig(login_origin_precheck=False)
        assert rig.core.login_origins is None
        assert (await _post_login(rig, SAME_ORIGIN + "/", None)).status_code == 202
        assert_error(await _post_login(rig, OTHER_LISTED, None), 403, "origin_rejected")
    run(go())


def test_a_write_is_never_served_from_the_read_cache():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            await rig.feed_up(c)
            assert (await c.get(PREFIX + "/session")).status_code == 200
            assert rig.session.credential in rig.app.state.sessions._cache  # a cached caller exists
            assert_error(await c.post(PREFIX + "/logout"), 403, "csrf_failed")
            assert_error(await c.post(PREFIX + "/leases", headers={"Origin": "https://foreign.example.test"}),
                         403, "origin_rejected")
            assert rig.world.sessions[rig.session.credential].revoked is False
    run(go())
