"""The SQLite ReceptionStore over a real processing store, and the whole app over it (synthetic data only)."""
import asyncio
import importlib.util
import json
import pathlib
import re
import sqlite3
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from mecon_reader_backend import FacadeConfig, create_app
from mecon_reader_backend.app import COOKIE
from mecon_reader_backend.fakes import build
from mecon_reader_backend.observations import PREFIX
from mecon_reader_backend.ports import Caller, CoreError, ScopedObserver
from mecon_reader_backend.sqlite_receptions import ObserverInfo, SqliteReceptionStore
from replay import BASE, OBSERVATIONS, SAME_ORIGIN, asgi_get_stream, parse_sse

_STORE_PY = pathlib.Path(__file__).resolve().parents[2] / "processing" / "src" / "mecon_processing" / "store.py"
_spec = importlib.util.spec_from_file_location("processing_store_under_test", _STORE_PY)
processing_store = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(processing_store)

NOW = datetime(2030, 1, 15, 10, 0, 0, tzinfo=timezone.utc)
KEY = b"synthetic-test-key-0123456789abcdef"
FORBIDDEN_KEYS = {"hash", "packet_hash", "packet_id", "path", "hop", "hop_count", "route", "route_type", "relay",
                  "raw", "payload", "text", "content", "transmitter", "capture_id", "source", "observer_key"}


def stamp(ago_s: float) -> str:
    return (NOW - timedelta(seconds=ago_s)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def caller(uid="usr_alice"):
    return Caller("sr_" + uid, uid, uid, "user", False, {"observations": "available"},
                  NOW + timedelta(hours=1), "c" * 16)


class Rig:
    """A processing store with: observer A and B (source s1) and C (source s2), and four packets."""

    def __init__(self, tmp_path, **kw):
        self.path = str(tmp_path / "processing.sqlite")
        self.store = processing_store.Store(self.path)
        self.next_capture = 1
        self.reader = SqliteReceptionStore(self.path, key=KEY, clock=lambda: NOW, poll_s=0.01, **kw)
        self.ids = self.ids_for("usr_alice")

    def ids_for(self, uid):
        """Each observer's id as the caller `uid` sees it (scoped to the caller)."""
        return {n: self.reader.observer_id(uid, s, k) for n, (s, k) in
                {"a": ("s1", "KEYA"), "b": ("s1", "KEYB"), "c": ("s2", "KEYC")}.items()}

    def add(self, observer, packet_id, ago_s, *, ptype="ADVERT", rssi=-90.4, snr=5.0, device=True, hops=3, route=1):
        source, key = {"a": ("s1", "KEYA"), "b": ("s1", "KEYB"), "c": ("s2", "KEYC"), "none": ("s1", None)}[observer]
        at = stamp(ago_s)
        with self.store.batch() as b:
            b.see_packet(packet_id, ptype, at)
            b.add_reception({"capture_id": self.next_capture, "packet_id": packet_id, "source": source,
                             "observer_key": key, "received_at": at,
                             "device_observed_at": int((NOW - timedelta(seconds=ago_s + 1)).timestamp()) if device else None,
                             "rssi": rssi, "snr": snr, "hop_count": hops, "route_type": route})
        self.next_capture += 1
        return self.next_capture - 1

    def scope(self, *names, prov="own_fleet", precision=50.0, uid="usr_alice"):
        ids = self.ids_for(uid)
        return [ScopedObserver(ids[n], prov, precision) for n in names]


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


def run(coro):
    return asyncio.run(coro)


def walk_keys(node, out=None):
    out = set() if out is None else out
    if isinstance(node, dict):
        for k, v in node.items():
            out.add(k)
            walk_keys(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_keys(v, out)
    return out


def assert_clean(body, *secrets):
    keys = walk_keys(body)
    assert not keys & FORBIDDEN_KEYS, keys & FORBIDDEN_KEYS
    assert not [k for k in keys if re.search(r"hash|path|hop|route|relay|raw", k, re.I)], keys
    text = json.dumps(body)
    for s in secrets:
        assert s not in text, f"{s!r} appears in the response"


# ---- scope ----

def test_only_observers_in_the_scope_are_listed_and_read(rig):
    rig.add("a", "AAAA000000000001", 60)
    rig.add("b", "AAAA000000000002", 50)
    rig.add("c", "AAAA000000000003", 40)
    obs = run(rig.reader.observers(caller(), rig.scope("a", "c"), None, 50)).items
    assert {o["observer_id"] for o in obs} == {rig.ids["a"], rig.ids["c"]}
    snap = run(rig.reader.snapshot(caller(), rig.scope("a", "c"), None, 50))
    assert {i["observer_id"] for i in snap.items} == {rig.ids["a"], rig.ids["c"]}
    ev = run(rig.reader.events_after(caller(), rig.scope("a", "c"), snap.cursor and None, 0)).events
    assert ev == []  # from now


def test_an_empty_scope_reads_nothing_and_never_errors(rig):
    rig.add("a", "AAAA000000000001", 60)
    assert run(rig.reader.observers(caller(), [], None, 50)).items == []
    snap = run(rig.reader.snapshot(caller(), [], None, 50))
    assert snap.items == []
    assert run(rig.reader.events_after(caller(), [], snap.cursor, 0)).events == []


def test_a_scope_id_that_names_no_observer_reads_nothing(rig):
    rig.add("a", "AAAA000000000001", 60)
    ghost = [ScopedObserver("obs_not_an_observer", "own_fleet", 10.0)]
    assert run(rig.reader.snapshot(caller(), ghost, None, 50)).items == []


def test_a_reception_with_no_observer_is_never_served(rig):
    rig.add("none", "AAAA000000000001", 60)
    rig.add("a", "AAAA000000000002", 50)
    snap = run(rig.reader.snapshot(caller(), rig.scope("a"), None, 50))
    assert len(snap.items) == 1


# ---- what is carried ----

def test_receptions_carry_nothing_forbidden_and_the_fields_are_mapped(rig):
    rig.add("a", "BEEF000000000001", 60, ptype="GROUP_TEXT", rssi=-90.4, snr=5.0, hops=7, route=2)
    snap = run(rig.reader.snapshot(caller(), rig.scope("a"), None, 50))
    [item] = snap.items
    assert_clean(item, "BEEF000000000001", "KEYA", "s1")
    assert set(item) == {"event_id", "packet_correlation_id", "reception_id", "observer_id", "observed_at", "received_at",
                         "clock_confidence", "packet_kind", "transport", "rssi", "snr", "provenance"}
    assert (item["packet_kind"], item["transport"], item["rssi"], item["snr"], item["provenance"]) == (
        "channel_message", "mqtt", -90, 5.0, "own_fleet")
    assert not list(OBSERVATIONS.schema_validator("Reception").iter_errors(item))


@pytest.mark.parametrize("ptype,kind", [("TEXT_MESSAGE", "direct_message"), ("GROUP_TEXT", "channel_message"),
                                        ("GROUP_DATA", "channel_message"), ("ADVERT", "advert"),
                                        ("ACK", "acknowledgement"), ("CONTROL", "control"), ("TRACE", "unknown"),
                                        ("PATH", "unknown"), ("RESPONSE", "unknown"), ("UNKNOWN_0x0c", "unknown")])
def test_packet_kind_mapping(rig, ptype, kind):
    rig.add("a", "AAAA000000000001", 60, ptype=ptype)
    assert run(rig.reader.snapshot(caller(), rig.scope("a"), None, 5)).items[0]["packet_kind"] == kind


@pytest.mark.parametrize("raw,want", [(-90.4, -90), (-90.5, -90), (-90.6, -91), (0.0, 0), (-200.0, -200), (-200.6, None),
                                      (0.4, 0), (0.6, None), (5.0, None), (-250.0, None), (None, None)])
def test_rssi_is_rounded_into_range_or_null(rig, raw, want):
    rig.add("a", "AAAA000000000001", 60, rssi=raw)
    assert run(rig.reader.snapshot(caller(), rig.scope("a"), None, 5)).items[0]["rssi"] == want


def test_snr_out_of_range_is_null(rig):
    rig.add("a", "AAAA000000000001", 60, snr=61.0)
    assert run(rig.reader.snapshot(caller(), rig.scope("a"), None, 5)).items[0]["snr"] is None


def test_clock_confidence(rig):
    rig.add("a", "AAAA000000000001", 60, device=True)
    rig.add("a", "AAAA000000000002", 50, device=False)
    items = run(rig.reader.snapshot(caller(), rig.scope("a"), None, 5)).items
    assert [i["clock_confidence"] for i in items] == ["high", "unknown"]
    assert items[1]["observed_at"] == items[1]["received_at"]
    # A device time a day and more behind the receipt is not trusted.
    with rig.store.batch() as b:
        b.see_packet("AAAA000000000009", "ADVERT", stamp(5))
        b.add_reception({"capture_id": 99, "packet_id": "AAAA000000000009", "source": "s1", "observer_key": "KEYA",
                         "received_at": stamp(5), "device_observed_at": int((NOW - timedelta(days=3)).timestamp()),
                         "rssi": -80, "snr": 1.0, "hop_count": 0, "route_type": 1})
    last = run(rig.reader.snapshot(caller(), rig.scope("a"), None, 5)).items[-1]
    assert last["clock_confidence"] == "low"


def test_the_correlation_id_is_opaque_shared_per_packet_and_never_the_hash_or_another_callers(rig):
    rig.add("a", "AAAA000000000001", 60)
    rig.add("b", "AAAA000000000001", 59)
    rig.add("a", "AAAA000000000002", 58)
    a = run(rig.reader.snapshot(caller("usr_alice"), rig.scope("a", "b"), None, 5)).items
    c = run(rig.reader.snapshot(caller("usr_carol"), rig.scope("a", "b", uid="usr_carol"), None, 5)).items
    assert a[0]["packet_correlation_id"] == a[1]["packet_correlation_id"] != a[2]["packet_correlation_id"]
    assert a[0]["packet_correlation_id"] != c[0]["packet_correlation_id"]
    for item in a + c:
        assert "AAAA000000000001" not in json.dumps(item) and "AAAA000000000002" not in json.dumps(item)
    assert {x["reception_id"] for x in a}.isdisjoint({x["reception_id"] for x in c})
    assert {x["event_id"] for x in a}.isdisjoint({x["event_id"] for x in c})


def test_the_observer_id_hides_the_key_and_source(rig):
    for oid in rig.ids.values():
        assert "KEY" not in oid and "s1" not in oid and re.fullmatch(r"ob_[A-Za-z0-9_-]{22}", oid)
    other = SqliteReceptionStore(rig.path, key=b"another-key-0123456789abcdef!!")
    assert other.observer_id("usr_alice", "s1", "KEYA") != rig.ids["a"]
    # Scoped to the caller: another caller gets other ids for the same observers.
    assert not set(rig.ids_for("usr_carol").values()) & set(rig.ids.values())


# ---- observers ----

def test_observers_labels_locations_and_freshness(tmp_path):
    rig = Rig(tmp_path)
    rig.reader.directory = {rig.ids["a"]: ObserverInfo("Mast (synthetic)", 10.5, -30.25),
                            rig.ids["b"]: ObserverInfo("Attic (synthetic)")}
    rig.add("a", "AAAA000000000001", 60)       # live
    rig.add("b", "AAAA000000000002", 3600)     # stale
    rig.add("c", "AAAA000000000003", 90000)    # offline
    obs = {o["observer_id"]: o for o in run(rig.reader.observers(caller(), rig.scope("a", "b", "c"), None, 50)).items}
    assert obs[rig.ids["a"]]["label"] == "Mast (synthetic)"
    assert obs[rig.ids["a"]]["location"] == {"lat": 10.5, "lon": -30.25, "precision_m": 50.0}
    assert obs[rig.ids["b"]]["location"] is None
    assert obs[rig.ids["c"]]["label"].startswith("Observer ")
    assert [obs[rig.ids[n]]["freshness"]["state"] for n in "abc"] == ["live", "stale", "offline"]
    for o in obs.values():
        assert not list(OBSERVATIONS.schema_validator("Observer").iter_errors(o))


def test_a_location_the_scope_withholds_is_null_even_when_the_directory_has_one(tmp_path):
    rig = Rig(tmp_path)
    rig.reader.directory = {rig.ids["a"]: ObserverInfo("Mast", 10.5, -30.25)}
    rig.add("a", "AAAA000000000001", 60)
    [o] = run(rig.reader.observers(caller(), rig.scope("a", precision=None), None, 5)).items
    assert o["location"] is None


def test_observer_paging_and_a_cursor_for_another_caller(rig):
    for n in "abc":
        rig.add(n, "AAAA00000000000" + str("abc".index(n)), 60)
    first = run(rig.reader.observers(caller(), rig.scope("a", "b", "c"), None, 2))
    assert len(first.items) == 2 and first.next_cursor
    rest = run(rig.reader.observers(caller(), rig.scope("a", "b", "c"), first.next_cursor, 2))
    assert len(rest.items) == 1 and rest.next_cursor is None
    with pytest.raises(CoreError) as e:
        run(rig.reader.observers(caller("usr_carol"), rig.scope("a", "b", "c"), first.next_cursor, 2))
    assert e.value.kind == "gone"


# ---- cursors ----

def test_snapshot_limit_since_and_the_cursor_continues_without_a_gap(rig):
    for i in range(5):
        rig.add("a", f"AAAA00000000000{i}", 100 - i)
    scope = rig.scope("a")
    newest = run(rig.reader.snapshot(caller(), scope, None, 2))
    assert [i["rssi"] for i in newest.items] == [-90, -90] and len(newest.items) == 2
    full = run(rig.reader.snapshot(caller(), scope, None, 50))
    assert len(full.items) == 5
    # Page forward through `since` with a small limit: every reception exactly once, in order.
    seen, since = [], None
    for _ in range(10):
        page = run(rig.reader.snapshot(caller(), scope, since, 2)) if since else None
        if page is None:
            page = run(rig.reader.snapshot(caller(), scope, rig.reader.cursor(caller(), 0), 2))
        seen += [i["event_id"] for i in page.items]
        if len(page.items) < 2:
            break
        since = page.cursor
    assert seen == [i["event_id"] for i in full.items]
    # The head cursor streams nothing old and then the next reception.
    rig.add("a", "AAAA000000000099", 1)
    ev = run(rig.reader.events_after(caller(), scope, full.cursor, 0)).events
    assert len(ev) == 1 and ev[0]["reception"]["event_id"] == ev[0]["event_id"]
    assert not list(OBSERVATIONS.schema_validator("ObservationEvent").iter_errors(ev[0]))


@pytest.mark.parametrize("bad", ["", "x", "obc_", "obc_1", "obc_1_", "obc_x_abc", "obc_1_AAAAAAAAAAAA", "obc_-1_AAAAAAAAAAAA",
                                 "obc_99999999999999999999999_a", "ctl_abcdef"])
def test_a_malformed_or_forged_cursor_is_gone(rig, bad):
    rig.add("a", "AAAA000000000001", 60)
    for call in (lambda: rig.reader.snapshot(caller(), rig.scope("a"), bad, 5),
                 lambda: rig.reader.events_after(caller(), rig.scope("a"), bad, 0)):
        with pytest.raises(CoreError) as e:
            run(call())
        assert e.value.kind == "gone"


def test_a_cursor_issued_to_another_caller_is_gone(rig):
    rig.add("a", "AAAA000000000001", 60)
    cur = run(rig.reader.snapshot(caller("usr_alice"), rig.scope("a"), None, 5)).cursor
    with pytest.raises(CoreError) as e:
        run(rig.reader.events_after(caller("usr_carol"), rig.scope("a"), cur, 0))
    assert e.value.kind == "gone"


def test_a_cursor_beyond_the_head_is_gone(rig):
    rig.add("a", "AAAA000000000001", 60)
    with pytest.raises(CoreError) as e:
        run(rig.reader.events_after(caller(), rig.scope("a"), rig.reader.cursor(caller(), 99), 0))
    assert e.value.kind == "gone"


def test_a_cursor_older_than_retention_is_gone_and_old_receptions_are_not_served(tmp_path):
    rig = Rig(tmp_path, retention_s=3600)
    old = rig.add("a", "AAAA000000000001", 7200)
    rig.add("a", "AAAA000000000002", 7100)
    rig.add("a", "AAAA000000000003", 60)
    snap = run(rig.reader.snapshot(caller(), rig.scope("a"), None, 50))
    assert len(snap.items) == 1  # only the one inside retention
    with pytest.raises(CoreError) as e:
        run(rig.reader.snapshot(caller(), rig.scope("a"), rig.reader.cursor(caller(), old), 5))
    assert e.value.kind == "gone"


def test_events_wait_for_a_new_reception(rig):
    rig.add("a", "AAAA000000000001", 60)
    scope = rig.scope("a")
    head = run(rig.reader.events_after(caller(), scope, None, 0)).cursor

    async def go():
        waiter = asyncio.ensure_future(rig.reader.events_after(caller(), scope, head, 3.0))
        await asyncio.sleep(0.1)
        assert not waiter.done()
        rig.add("a", "AAAA000000000002", 1)
        return await asyncio.wait_for(waiter, 3.0)
    batch = run(go())
    assert len(batch.events) == 1


def test_events_hold_back_receptions_outside_the_scope_but_advance_the_cursor(rig):
    rig.add("a", "AAAA000000000001", 60)
    scope = rig.scope("a")
    head = run(rig.reader.events_after(caller(), scope, None, 0)).cursor
    rig.add("b", "AAAA000000000002", 50)
    batch = run(rig.reader.events_after(caller(), scope, head, 0))
    assert batch.events == [] and batch.cursor != head


def test_the_connection_is_read_only(rig):
    conn = rig.reader._connect()
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("DELETE FROM receptions")
    finally:
        conn.close()


def test_a_missing_database_is_unavailable_not_an_answer(tmp_path):
    reader = SqliteReceptionStore(str(tmp_path / "nope.sqlite"), key=KEY)
    with pytest.raises(CoreError) as e:
        run(reader.snapshot(caller(), [], None, 5))
    assert e.value.kind == "unavailable"


# ---- the whole app over the SQLite store ----

class IdScope:
    """A scope that gives each user a fixed list of observers (the real one is the core's)."""

    def __init__(self, by_user):
        self.by_user = by_user
        self.world = None

    async def visible_observers(self, c):
        return self.by_user.get(c.user_id, [])


def make_app(rig, world, lookup, core, by_user):
    return create_app(lookup, core, FacadeConfig(reader_origins=(SAME_ORIGIN,), heartbeat_s=0.2, observation_poll_s=0.05),
                      observation_scope=IdScope(by_user), reception_store=rig.reader)


def test_every_response_over_the_sqlite_store_is_clean_and_scoped(rig):
    world, lookup, core, _ = OBSERVATIONS.build(OBSERVATIONS.worlds["worlds"]["two-fleets-observed"])
    alice = world.users["alice"]
    rig.add("a", "BEEF000000000001", 60, ptype="TEXT_MESSAGE")
    rig.add("b", "BEEF000000000001", 59, ptype="TEXT_MESSAGE")
    rig.add("c", "BEEF000000000002", 58)
    app = make_app(rig, world, lookup, core, {alice.id: rig.scope("a", "b", uid=alice.id)})
    ids = rig.ids_for(alice.id)
    session = world.mint_session("alice")

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE) as c:
            c.cookies.set(COOKIE, session.credential, domain="reader.example.test", path="/")
            obs = await c.get(PREFIX + "/observers?scope=self")
            snap = await c.get(PREFIX + "/snapshot?scope=self")
            assert obs.status_code == snap.status_code == 200
            assert obs.headers["cache-control"] == snap.headers["cache-control"] == "no-store"
            cookie = f"{COOKIE}={session.credential}"
            status, _, raw = await asgi_get_stream(app, PREFIX + "/events?scope=self&cursor=" + snap.json()["cursor"],
                                                   {"Cookie": cookie}, bound_s=2.0, until_heartbeat=True)
            return obs.json(), snap.json(), status, raw
    obs, snap, status, raw = run(go())
    assert not list(OBSERVATIONS.schema_validator("ObserverList").iter_errors(obs))
    assert not list(OBSERVATIONS.schema_validator("Snapshot").iter_errors(snap))
    assert len(snap["items"]) == 2 and {i["observer_id"] for i in snap["items"]} == {ids["a"], ids["b"]}
    assert snap["items"][0]["packet_correlation_id"] == snap["items"][1]["packet_correlation_id"]
    for body in (obs, snap):
        assert_clean({k: v for k, v in body.items()}, "BEEF000000000001", "BEEF000000000002", "KEYA", "KEYC")
    assert status == 200 and parse_sse(raw) == []

    # A new reception by an observer in scope and one outside it, on an open stream.
    async def live():
        cookie = f"{COOKIE}={session.credential}"

        async def add_soon():
            await asyncio.sleep(0.3)
            rig.add("a", "BEEF000000000003", 0)
            rig.add("c", "BEEF000000000004", 0)
        t = asyncio.ensure_future(add_soon())
        res = await asgi_get_stream(app, PREFIX + "/events?scope=self&cursor=" + snap["cursor"], {"Cookie": cookie},
                                    bound_s=1.5, until_heartbeat=False)
        await t
        return res
    status, _, raw, _ = run(live())
    frames = parse_sse(raw)
    assert len(frames) == 1 and frames[0]["reception"]["observer_id"] == ids["a"]
    assert_clean(frames[0], "BEEF000000000003", "BEEF000000000004", "KEYA")
    assert f"id: {frames[0]['event_id']}\n".encode() in raw


def test_a_cursor_never_shows_the_store_position_and_round_trips_per_caller():
    """The position is a place in the whole store, which moves with other fleets' traffic: it must not be readable
    from a cursor or an event id, nor its gaps; the cursor still decodes for its own caller and nobody else."""
    import random

    from mecon_reader_backend.sqlite_receptions import SqliteReceptionStore

    store = SqliteReceptionStore.__new__(SqliteReceptionStore)
    store._key = b"k" * 32
    alice = type("C", (), {"user_id": "u-alice"})()
    carol = type("C", (), {"user_id": "u-carol"})()
    rng = random.Random(7)
    for pos in [0, 1, 2, 3, 1000, 1001, 2**40 + 5] + [rng.randrange(2**63) for _ in range(200)]:
        c = store.cursor(alice, pos)
        assert c.split("_")[1] != format(pos, "016x")
        assert store._position(alice, c) == pos
        try:
            store._position(carol, c)
            raise AssertionError("another caller decoded the cursor")
        except Exception as e:  # noqa: BLE001
            assert "cursor_expired" in str(e) or e.__class__.__name__ == "CoreError"
    seq = [int(store.cursor(alice, p).split("_")[1], 16) for p in range(100, 110)]
    assert seq != sorted(seq) and len(set(seq)) == 10, "consecutive positions must not stay ordered or adjacent"


def _many(tmp_path, n_in=300, n_out=50, per_out=40):
    """A store with n_in observers in scope (one reception each) and n_out out of scope (per_out each), mixed."""
    import random

    r = Rig(tmp_path)
    rng = random.Random(11)
    rows = [("in", i) for i in range(n_in)] + [("out", i) for i in range(n_out) for _ in range(per_out)]
    rng.shuffle(rows)
    with r.store.batch() as b:
        b.see_packet("PKT", "ADVERT", stamp(60))
        for cid, (kind, i) in enumerate(rows, start=1):
            b.add_reception({"capture_id": cid, "packet_id": "PKT", "source": "s1", "observer_key": f"{kind}-{i}",
                             "received_at": stamp(60), "device_observed_at": None, "rssi": -80, "snr": 1.0,
                             "hop_count": 1, "route_type": 1})
    allowed = {("s1", f"in-{i}"): None for i in range(n_in)}
    return r, allowed


@pytest.mark.parametrize("after,limit,newest", [(0, 1000, False), (0, 7, False), (900, 50, False), (0, 1000, True),
                                                (0, 9, True), (1500, 40, True)])
def test_the_sql_scope_filter_answers_what_a_full_scan_filtered_in_python_would(tmp_path, after, limit, newest):
    """The scope filter moved into SQL (chunked IN over source and observer key) must give the same rows, in the
    same order, as reading every reception and filtering: including a scope larger than one chunk."""
    import sqlite3

    r, allowed = _many(tmp_path)
    assert len(allowed) > r.reader.SCOPE_CHUNK
    conn = sqlite3.connect(r.path)
    got = r.reader._scan(conn, allowed, after=after, limit=limit, newest_first=newest)
    every = conn.execute(r.reader._SELECT + "ORDER BY r.capture_id" + (" DESC" if newest else "")).fetchall()
    if newest:
        head, floor = r.reader._head(conn) + 1, max(after, r.reader._floor(conn))
        want = [x for x in every if floor < x[0] < head and (x[2], x[3]) in allowed][:limit]
    else:
        want = [x for x in every if x[0] > after and (x[2], x[3]) in allowed][:limit]
    assert got == want and got, (len(got), len(want))


def test_receptions_outside_the_scope_are_not_read_the_index_serves_the_scope(tmp_path):
    """A reception of an observer outside the scope is never read: the statements _scan really runs (recorded with
    the trace callback, bound values expanded) go through the observer index, never a scan of every reception."""
    import sqlite3

    r, allowed = _many(tmp_path, n_in=3)
    conn = sqlite3.connect(r.path)
    ran: list[str] = []
    conn.set_trace_callback(ran.append)
    for newest in (False, True):
        r.reader._scan(conn, allowed, after=0, limit=10, newest_first=newest)
    conn.set_trace_callback(None)
    scans = [q for q in ran if "FROM receptions r JOIN packets" in q]
    assert len(scans) == 2, ran
    for q in scans:
        plan = " | ".join(str(row[-1]) for row in conn.execute("EXPLAIN QUERY PLAN " + q).fetchall())
        assert "receptions_observer" in plan, plan
        assert "SCAN r " not in plan + " " and "SCAN receptions" not in plan, plan
