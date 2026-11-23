"""The observation module's own rules, apart from the published cases (synthetic world, fake ports)."""
import asyncio

import httpx
import pytest

from mecon_reader_backend import FacadeConfig, create_app
from mecon_reader_backend.app import COOKIE
from mecon_reader_backend.observations import PREFIX
from mecon_reader_backend.ports import CoreError
from replay import BASE, OBSERVATIONS, SAME_ORIGIN, asgi_get_stream, parse_sse

ERROR_KEYS = {"code", "message", "request_id", "retryable"}


def run(coro):
    return asyncio.run(coro)


class Rig:
    def __init__(self, world="two-fleets-observed", **cfg):
        self.world, self.lookup, self.core, ports = OBSERVATIONS.build(OBSERVATIONS.worlds["worlds"][world])
        self.world.reader_origins = (SAME_ORIGIN,)
        self.scope, self.store = ports["observation_scope"], ports["reception_store"]
        cfg.setdefault("heartbeat_s", 0.2)
        cfg.setdefault("observation_poll_s", 0.05)
        self.app = create_app(self.lookup, self.core, FacadeConfig(reader_origins=(SAME_ORIGIN,), **cfg), **ports)

    def client(self, user):
        self.session = self.world.mint_session(user)
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=BASE)
        c.cookies.set(COOKIE, self.session.credential, domain="reader.example.test", path="/")
        return c

    def cookie(self):
        return {"Cookie": f"{COOKIE}={self.session.credential}"}

    async def stream(self, query="scope=self", headers=None, bound_s=1.0, until_heartbeat=False):
        return await asgi_get_stream(self.app, f"{PREFIX}/events?{query}", (headers or {}) | self.cookie(),
                                     bound_s=bound_s, until_heartbeat=until_heartbeat)


def assert_error(r, status, code, retryable=None):
    assert r.status_code == status, r.text
    body = r.json()
    assert set(body) == ERROR_KEYS and body["code"] == code
    if retryable is not None:
        assert body["retryable"] is retryable
    assert r.headers["cache-control"] == "no-store"


OPS = ["observers", "snapshot", "events"]


async def get_all(c, query="scope=self"):
    return [await c.get(f"{PREFIX}/{p}?{query}") for p in ("observers", "snapshot")]


# ---- access ----

def test_a_session_without_the_grant_gets_403_from_every_operation_and_never_a_body():
    async def go():
        rig = Rig()
        async with rig.client("dora") as c:
            for r in await get_all(c):
                assert_error(r, 403, "forbidden", False)
            status, headers, raw = await rig.stream(until_heartbeat=True)
            assert status == 403 and b"heartbeat" not in raw and headers["cache-control"] == "no-store"
    run(go())


def test_observations_unavailable_is_503_retryable_on_every_operation():
    async def go():
        rig = Rig()
        orig = rig.lookup.capabilities
        rig.lookup.capabilities = lambda u: orig(u) | {"observations": "unavailable"}
        async with rig.client("alice") as c:
            for r in await get_all(c):
                assert_error(r, 503, "unavailable", True)
            status, _, raw = await rig.stream(until_heartbeat=True)
            assert status == 503
    run(go())


@pytest.mark.parametrize("which", ["scope", "store"])
def test_a_failing_port_is_503_never_an_empty_answer(which):
    async def go():
        rig = Rig()
        getattr(rig, which).unavailable = True
        async with rig.client("alice") as c:
            for r in await get_all(c):
                assert_error(r, 503, "unavailable", True)
            status, _, raw = await rig.stream(until_heartbeat=True)
            assert status == 503
    run(go())


def test_an_unexpected_exception_in_a_port_is_503():
    async def go():
        rig = Rig()

        async def boom(*a, **k):
            raise RuntimeError("boom")
        rig.scope.visible_observers = boom
        async with rig.client("alice") as c:
            for r in await get_all(c):
                assert_error(r, 503, "unavailable", True)
    run(go())


def test_a_session_lookup_outage_is_503_and_no_session_is_401_on_every_operation():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            rig.lookup.unavailable = True
            for r in await get_all(c):
                assert_error(r, 503, "unavailable", True)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=rig.app), base_url=BASE) as anon:
            rig.lookup.unavailable = False
            for r in await get_all(anon):
                assert_error(r, 401, "unauthenticated")
    run(go())


def test_the_grant_is_read_from_the_session_on_every_request():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            assert (await c.get(f"{PREFIX}/observers?scope=self")).status_code == 200
            rig.world.users["alice"].observations = "forbidden"
            rig.app.state.sessions.drop_cache()  # as the 5 s read cache ending would
            assert_error(await c.get(f"{PREFIX}/observers?scope=self"), 403, "forbidden")
            status, _, _ = await rig.stream(until_heartbeat=True)
            assert status == 403
    run(go())


def test_nothing_visible_is_200_and_empty_and_the_stream_holds_heartbeats_only():
    async def go():
        rig = Rig("unobserved")
        async with rig.client("erin") as c:
            o, s = await get_all(c)
            assert o.status_code == s.status_code == 200
            assert o.json()["items"] == [] and s.json()["items"] == []
            assert o.headers["cache-control"] == s.headers["cache-control"] == "no-store"
        status, _, raw, ended = await rig.stream(bound_s=1.0)
        assert status == 200 and not ended and parse_sse(raw) == [] and raw.count(b": heartbeat") >= 2
    run(go())


# ---- scope comes from the port ----

def test_the_scope_is_asked_on_every_request_and_the_store_gets_exactly_its_answer():
    async def go():
        rig = Rig()
        calls = []
        orig = rig.store.snapshot

        async def spy(caller, scope, since, limit):
            calls.append([s.observer_id for s in scope])
            return await orig(caller, scope, since, limit)
        rig.store.snapshot = spy
        async with rig.client("alice") as c:
            await c.get(f"{PREFIX}/snapshot?scope=self")
            await c.get(f"{PREFIX}/snapshot?scope=self")
        assert len(calls) == 2 and len(calls[0]) == 3  # alice: two north observers and the public one
    run(go())


def test_a_client_cannot_widen_the_scope():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            for q in ("scope=all", "scope=fleet:south", "scope=", ""):
                assert (await c.get(f"{PREFIX}/observers?{q}")).status_code == 422
            labels = {i["label"] for i in (await c.get(f"{PREFIX}/observers?scope=self&fleet=south")).json()["items"]}
            assert "South hill (synthetic)" not in labels
    run(go())


def test_the_scope_shrinking_mid_stream_stops_what_is_sent():
    async def go():
        rig = Rig()
        async with rig.client("alice"):
            pass
        ids = [s.observer_id for s in await rig.scope.visible_observers(
            await rig.lookup.resolve(rig.session.credential, "read"))]
        mast = rig.world.id_of("observers", "north_mast")
        orig = rig.scope.visible_observers

        async def shrinking(caller):
            return [s for s in await orig(caller) if s.observer_id != mast] if rig.world.shrunk else await orig(caller)
        rig.world.shrunk = False
        rig.scope.visible_observers = shrinking

        async def act():
            await asyncio.sleep(0.3)
            rig.world.shrunk = True
            await asyncio.sleep(0.3)  # the read in flight when the scope shrank has ended
            rig.world.add_reception("north_mast", "p1", -55)
            rig.world.add_reception("north_attic", "p1", -56)
        t = asyncio.ensure_future(act())
        status, _, raw, _ = await rig.stream(bound_s=1.2)
        await t
        assert mast in ids
        assert [f["reception"]["rssi"] for f in parse_sse(raw)] == [-56]
    run(go())


# ---- parameters and cursors ----

@pytest.mark.parametrize("path,query", [("observers", "scope=self&limit=0"), ("observers", "scope=self&limit=501"),
                                        ("snapshot", "scope=self&limit=x"), ("snapshot", "limit=5")])
def test_malformed_scope_or_limit_is_422_invalid(path, query):
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            assert_error(await c.get(f"{PREFIX}/{path}?{query}"), 422, "invalid")
    run(go())


def test_limits_apply_and_a_page_continues():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            first = (await c.get(f"{PREFIX}/observers?scope=self&limit=2")).json()
            assert len(first["items"]) == 2 and first["next_cursor"]
            rest = (await c.get(f"{PREFIX}/observers?scope=self&limit=2&cursor={first['next_cursor']}")).json()
            assert len(rest["items"]) == 1 and rest["next_cursor"] is None
            assert len((await c.get(f"{PREFIX}/snapshot?scope=self&limit=1")).json()["items"]) == 1
    run(go())


def test_a_cursor_longer_than_the_schema_allows_is_410_and_an_empty_one_is_none():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            assert_error(await c.get(f"{PREFIX}/snapshot?scope=self&since={'x' * 513}"), 410, "cursor_expired")
            assert (await c.get(f"{PREFIX}/snapshot?scope=self&since=")).status_code == 200
            assert_error(await c.get(f"{PREFIX}/observers?scope=self&cursor=junk"), 410, "cursor_expired")
        status, _, raw, _ = await rig.stream(f"scope=self&cursor={'x' * 513}")
        assert status == 410
    run(go())


def test_a_snapshot_since_continues_where_it_ended_and_expires_at_is_in_the_future():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            snap = (await c.get(f"{PREFIX}/snapshot?scope=self")).json()
            assert not list(OBSERVATIONS.schema_validator("Snapshot").iter_errors(snap))
            rig.world.add_reception("north_mast", "p3", -77)
            more = (await c.get(f"{PREFIX}/snapshot?scope=self&since={snap['cursor']}")).json()
            assert [i["rssi"] for i in more["items"]] == [-77]
            none = (await c.get(f"{PREFIX}/snapshot?scope=self&since={more['cursor']}")).json()
            assert none["items"] == []
    run(go())


def test_last_event_id_wins_over_the_cursor_parameter_in_both_directions():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            cp = (await c.get(f"{PREFIX}/snapshot?scope=self")).json()["cursor"]
        rig.world.add_reception("north_mast", "p3", -77)
        # A good header with a bad query serves from the header; a bad header with a good query is 410.
        status, _, raw, _ = await rig.stream("scope=self&cursor=junk", {"Last-Event-ID": cp}, bound_s=0.5)
        assert status == 200 and [f["reception"]["rssi"] for f in parse_sse(raw)] == [-77]
        status, _, raw, _ = await rig.stream(f"scope=self&cursor={cp}", {"Last-Event-ID": "junk"}, bound_s=0.5)
        assert status == 410
    run(go())


# ---- the stream ----

def test_the_stream_sends_frames_with_ids_a_heartbeat_and_no_store():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            cp = (await c.get(f"{PREFIX}/snapshot?scope=self")).json()["cursor"]
        rig.world.add_reception("north_mast", "p3", -77)
        status, headers, raw, _ = await rig.stream(f"scope=self&cursor={cp}", bound_s=0.7)
        assert status == 200 and headers["content-type"].startswith("text/event-stream")
        assert headers["cache-control"] == "no-store"
        [f] = parse_sse(raw)
        assert f"id: {f['event_id']}\ndata: ".encode() in raw
        assert not list(OBSERVATIONS.schema_validator("ObservationEvent").iter_errors(f))
        assert raw.index(b"data:") < raw.index(b": heartbeat")  # the held backlog comes first
        assert raw.count(b": heartbeat") >= 2  # and heartbeats repeat while idle
    run(go())


def test_the_stream_default_heartbeat_is_at_most_25_seconds():
    assert FacadeConfig().heartbeat_s <= 25


def test_a_revoked_session_gets_access_revoked_once_then_the_stream_closes_and_nothing_follows():
    async def go():
        rig = Rig()
        async with rig.client("alice"):
            pass

        async def revoke_soon():
            await asyncio.sleep(0.4)
            rig.world.revoke(rig.session)
            rig.world.add_reception("north_mast", "p3", -55)
        t = asyncio.ensure_future(revoke_soon())
        status, _, raw, ended = await rig.stream(bound_s=3.0)
        await t
        assert status == 200 and ended, "the stream stayed open after its session was revoked"
        frames = parse_sse(raw)
        assert [f["kind"] for f in frames] == ["access_revoked"]
        assert not list(OBSERVATIONS.schema_validator("ObservationEvent").iter_errors(frames[0]))
        assert not raw.rstrip().endswith(b": heartbeat")
        assert b"-55" not in raw
        # The control event's id is not a resume point: resuming from it is a 410.
        async with rig.client("alice") as c:
            status, _, _, _ = await rig.stream(headers={"Last-Event-ID": frames[0]["event_id"]}, bound_s=0.5)
            assert status == 410
    run(go())


def test_another_sessions_revocation_leaves_the_stream_open():
    async def go():
        rig = Rig()
        async with rig.client("alice"):
            pass
        other = rig.world.mint_session("carol")

        async def revoke_other():
            await asyncio.sleep(0.3)
            rig.world.revoke(other)
        t = asyncio.ensure_future(revoke_other())
        status, _, raw, ended = await rig.stream(bound_s=1.0)
        await t
        assert status == 200 and not ended and parse_sse(raw) == []
    run(go())


def test_a_cursor_that_ages_out_mid_stream_sends_resync_required_and_closes():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            cp = (await c.get(f"{PREFIX}/snapshot?scope=self")).json()["cursor"]
        orig, calls = rig.store.events_after, []

        async def lagging(caller, scope, cursor, wait_s):
            calls.append(cursor)
            if len(calls) > 3:  # the stream fell behind retention after it started
                raise CoreError("gone", "cursor_expired")
            return await orig(caller, scope, cursor, wait_s)
        rig.store.events_after = lagging
        status, _, raw, ended = await rig.stream(f"scope=self&cursor={cp}", bound_s=3.0)
        assert status == 200 and ended
        frames = parse_sse(raw)
        assert [f["kind"] for f in frames] == ["resync_required"]
        assert not list(OBSERVATIONS.schema_validator("ObservationEvent").iter_errors(frames[0]))
        async with rig.client("alice"):
            status, _, _, _ = await rig.stream(headers={"Last-Event-ID": frames[0]["event_id"]}, bound_s=0.5)
            assert status == 410
    run(go())


def test_the_scope_failing_mid_stream_closes_the_stream_without_a_frame():
    async def go():
        rig = Rig()
        async with rig.client("alice"):
            pass

        async def fail_soon():
            await asyncio.sleep(0.3)
            rig.scope.unavailable = True
            await asyncio.sleep(0.3)
            rig.world.add_reception("north_mast", "p3", -55)
        t = asyncio.ensure_future(fail_soon())
        status, _, raw, ended = await rig.stream(bound_s=3.0)
        await t
        assert status == 200 and ended and parse_sse(raw) == []
    run(go())


def test_only_get_is_served_and_the_routes_are_absent_without_the_ports():
    async def go():
        rig = Rig()
        async with rig.client("alice") as c:
            r = await c.post(f"{PREFIX}/observers?scope=self")
            assert r.status_code == 405
        from mecon_reader_backend.fakes import build
        world, lookup, core = build(OBSERVATIONS.worlds["worlds"]["two-fleets-observed"])
        bare = create_app(lookup, core)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=bare), base_url=BASE) as c:
            assert (await c.get(f"{PREFIX}/observers?scope=self")).status_code == 404
        with pytest.raises(ValueError):
            create_app(lookup, core, observation_scope=rig.scope)
    run(go())


def test_the_session_endpoint_reports_the_grant():
    async def go():
        rig = Rig()
        from mecon_reader_backend.app import PREFIX as READER_PREFIX
        async with rig.client("alice") as c:
            assert (await c.get(READER_PREFIX + "/session")).json()["capabilities"]["observations"] == "available"
        async with rig.client("dora") as c:
            assert (await c.get(READER_PREFIX + "/session")).json()["capabilities"]["observations"] == "forbidden"
    run(go())


def test_one_packet_has_a_different_correlation_id_for_each_caller():
    async def go():
        rig = Rig()
        ids = []
        for user in ("alice", "carol"):  # both may see the approved public source's reception
            async with rig.client(user) as c:
                items = (await c.get(f"{PREFIX}/snapshot?scope=self")).json()["items"]
                [pub] = [i for i in items if i["provenance"] == "approved_public_source"]
                ids.append((pub["packet_correlation_id"], pub["reception_id"]))
        assert all(a != b for a, b in zip(*ids))
    run(go())
