import io
import json
import urllib.error
import urllib.request

import pytest

from conftest import Rig
from mecon_connector.health import make_server, serve_in_thread
from mecon_connector.logutil import Log
from mecon_connector.metrics import Metrics


def test_log_never_writes_payload_bytes_or_secret_named_fields():
    buf = io.StringIO()
    log = Log(buf)
    log.info("x", data=b"\x00secret-bytes", note="a" * 500)
    rec = json.loads(buf.getvalue())
    assert rec["data"] == "<13 bytes>" and len(rec["note"]) == 203
    for name in ("password", "payload", "token", "api_key"):
        with pytest.raises(ValueError):
            log.info("x", **{name: "v"})


def test_unknown_metric_or_label_raises():
    m = Metrics()
    with pytest.raises(KeyError):
        m.inc("nope")
    with pytest.raises(KeyError):
        m.inc("upstream_dropped_total", 1, "made_up")
    with pytest.raises(KeyError):
        m.inc("upstream_dropped_total")


def test_health_and_metrics_endpoints():
    rig = Rig()
    rig.settle()
    srv = make_server("127.0.0.1", 0, rig.metrics, rig.bridge.snapshot)
    serve_in_thread(srv)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        r = urllib.request.urlopen(base + "/healthz")
        assert r.status == 200 and json.load(r)["ready"] is True
        assert b"mecon_connector_serial_connected 1" in urllib.request.urlopen(base + "/metrics").read()
        rig.opener.unplug()
        rig.step(3)
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(base + "/healthz")
        assert e.value.code == 503
    finally:
        srv.shutdown()
        srv.server_close()
