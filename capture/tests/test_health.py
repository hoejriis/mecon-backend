import json
import urllib.error
import urllib.request

from conftest import sub_fixture
from helpers import make_ingester
from mecon_capture.health import make_server, serve_in_thread
from mecon_capture.ingester import utc_now

PROF = sub_fixture("A")["cases"][2]["value"]


def test_healthz_reports_profiles_and_both_counter_sets_that_match_the_schemas(tmp_path, schemas):
    ig, archive, _t, _l = make_ingester([PROF, dict(PROF, name="second")], tmp_path)
    ig.sessions[0].start()
    ig.sessions[0].on_connack(0)
    ig.sessions[0].on_suback(PROF["topics"], [])
    ig.sessions[1].on_connack(5)
    ig.sessions[0].on_message("packets/a", b"1", False)
    ig.flush_once()
    ig.sessions[0].on_message("packets/b", b"2", False)  # still waiting in the buffer
    server = make_server("127.0.0.1", 0, lambda: {"profiles": ig.statuses(), "counters": archive.counters(),
                                                  "ingester": ig.buffer.counters(utc_now())})
    serve_in_thread(server)
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}"
        assert server.server_address[0] == "127.0.0.1"
        with urllib.request.urlopen(base + "/healthz") as r:
            doc = json.loads(r.read())
            assert r.status == 200 and r.headers["Content-Type"] == "application/json"
        assert [p["name"] for p in doc["profiles"]] == ["open-feed", "second"]
        for p in doc["profiles"]:
            assert schemas["status"].is_valid(p), p
        assert doc["profiles"][0]["state"] == "connected" and doc["profiles"][1]["last_error"] == "not authorised"
        assert schemas["counters"].is_valid(doc["counters"])
        assert doc["counters"]["committed"] == 1
        assert schemas["ingester"].is_valid(doc["ingester"]), doc["ingester"]
        assert {k: doc["ingester"][k] for k in ("received", "handed_on", "buffered", "shed", "oversize")} == {
            "received": 2, "handed_on": 1, "buffered": 1, "shed": 0, "oversize": 0}
        assert doc["ingester"]["oldest_buffered_ms"] is not None
        try:
            urllib.request.urlopen(base + "/other")
            assert False
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        server.shutdown()
        server.server_close()


def test_default_bind_is_loopback():
    from mecon_capture.config import HealthConfig
    assert HealthConfig().bind == "127.0.0.1"
