"""The session lookup's CSRF token only behind GET /session, and Sec-Fetch-Site on every write lookup.

The session lookup contract returns the CSRF token only on the lookup that serves GET /session, and applies the
Origin rule (an allow-listed Origin, or Sec-Fetch-Site "same-origin") to writes as well as to login start.
"""
from dataclasses import replace

import httpx

from mecon_reader_backend.app import COOKIE, PREFIX
from replay import BASE

from test_facade import Raising, Recording, Rig, assert_error, run


def _client_without_origin(rig, user):
    """A client that sends no Origin by default (the rig's client always sends the Reader's own)."""
    c = httpx.AsyncClient(transport=httpx.ASGITransport(app=rig.app), base_url=BASE)
    rig.session = rig.world.mint_session(user)
    c.cookies.set(COOKIE, rig.session.credential, domain="reader.example.test", path="/")
    return c


def test_a_caller_without_a_csrf_token_serves_every_other_request():
    async def go():
        rig = Rig(lookup_wrap=Recording)
        async with rig.client("alice") as c:
            r = await c.get(PREFIX + "/devices")
            assert r.status_code == 200, r.text
            reads = [e for e in rig.port.extra if not e["include_csrf"]]
            assert reads, "an ordinary read asks for no token"
    run(go())


def test_get_session_asks_for_the_token_and_returns_it():
    async def go():
        rig = Rig(lookup_wrap=Recording)
        async with rig.client("alice") as c:
            r = await c.get(PREFIX + "/session")
            assert r.status_code == 200, r.text
            assert isinstance(r.json()["csrf_token"], str) and len(r.json()["csrf_token"]) >= 16
            assert rig.port.extra[-1]["include_csrf"] is True
    run(go())


def test_get_session_fails_closed_when_the_token_does_not_come_back():
    async def go():
        rig = Rig(lookup_wrap=lambda inner: Raising(inner, answer=lambda a: replace(a, csrf_token=None)
                                                     if hasattr(a, "csrf_token") else a))
        async with rig.client("alice") as c:
            assert_error(await c.get(PREFIX + "/session"), 503, "unavailable", True)
            assert (await c.get(PREFIX + "/devices")).status_code == 200  # other requests still served
    run(go())


def test_get_session_never_answers_from_a_cached_caller_without_the_token():
    async def go():
        rig = Rig(lookup_wrap=Recording)
        async with rig.client("alice") as c:
            await rig.feed_up(c)
            await c.get(PREFIX + "/devices")  # caches a Caller that carries no token
            rig.port.extra.clear()
            r = await c.get(PREFIX + "/session")
            assert r.status_code == 200 and r.json()["csrf_token"]
            assert rig.port.extra and rig.port.extra[-1]["include_csrf"] is True, "asked the core again"
    run(go())


def test_every_write_lookup_carries_sec_fetch_site():
    async def go():
        rig = Rig(lookup_wrap=Recording)
        async with rig.client("alice") as c:
            token = (await c.get(PREFIX + "/session")).json()["csrf_token"]
            rig.port.extra.clear()
            r = await c.post(PREFIX + "/leases", headers={"X-CSRF-Token": token, "Sec-Fetch-Site": "same-origin"})
            assert r.status_code == 200, r.text
            assert rig.port.extra == [{"sec_fetch_site": "same-origin", "include_csrf": False}]
    run(go())


def test_a_same_origin_write_without_an_origin_header_is_accepted():
    """The OR's Sec-Fetch-Site branch: no Origin, but the browser says same-origin."""
    async def go():
        rig = Rig()
        async with _client_without_origin(rig, "alice") as c:
            token = (await c.get(PREFIX + "/session")).json()["csrf_token"]
            r = await c.post(PREFIX + "/leases", headers={"X-CSRF-Token": token, "Sec-Fetch-Site": "same-origin"})
            assert r.status_code == 200, r.text
            r = await c.post(PREFIX + "/leases", headers={"X-CSRF-Token": token, "Sec-Fetch-Site": "cross-site"})
            assert_error(r, 403, "origin_rejected")
            r = await c.post(PREFIX + "/leases", headers={"X-CSRF-Token": token})
            assert_error(r, 403, "origin_rejected")
    run(go())
