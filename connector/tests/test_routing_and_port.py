"""Routing of uplink envelopes to resp / ev/<name>, the retained status, and explicit port selection."""

import json
import os
import pathlib
import stat

import pytest

from conftest import Rig, make_cfg
from mecon_connector import __main__ as entry
from mecon_connector.bridge import route_topic, status_payload
from mecon_connector.config import ConfigError, Selector
from mecon_connector.serial_link import PortInfo, matches, open_path
from mecon_connector.transport import SerialUnavailable

RESP, EV = "r/resp", "r/ev"


# ---- routing: the topic is chosen from the parsed envelope ---------------------------------


@pytest.mark.parametrize(
    "obj,want",
    [
        ({"v": 1, "id": "a", "status": "ok"}, RESP),
        ({"v": 1, "id": 7}, RESP),
        ({"v": 1, "id": 0}, RESP),
        ({"v": 1, "ev": "health"}, f"{EV}/health"),
        ({"v": 1, "ev": "rf", "seq": 1}, f"{EV}/rf"),
        ({"v": 1, "ev": "a_b-C9"}, f"{EV}/a_b-C9"),
        ({"ev": "power", "id": "x"}, f"{EV}/power"),  # an event beats an id
        ({"v": 1}, None),
        ({"v": 1, "id": ""}, None),
        ({"v": 1, "id": None}, None),
        ({"v": 1, "id": True}, None),
        ({"v": 1, "id": ["a"]}, None),
        ({"v": 1, "ev": ""}, None),
        ({"v": 1, "ev": 5}, None),
        ({"v": 1, "ev": None, "id": "a"}, None),  # a bad ev never falls back to resp
        ({"v": 1, "ev": "a/b"}, None),
        ({"v": 1, "ev": "+"}, None),
        ({"v": 1, "ev": "#"}, None),
        ({"v": 1, "ev": "a b"}, None),
        ({"v": 1, "ev": "x" * 33, "id": "a"}, None),
        ({"v": 1, "ev": "x" * 32}, f"{EV}/{'x' * 32}"),
        (None, None),
    ],
)
def test_route_topic(obj, want):
    assert route_topic(obj, RESP, EV) == want


def feed(rig, msg: bytes, xid=100):
    from mecon_connector.framing import encode_mecon_frames, encode_serial_frame

    rig.dev.feed_bytes(b"".join(encode_serial_frame(f, 0x3E) for f in encode_mecon_frames(xid, msg)))
    rig.step(6)


def test_event_and_response_land_on_their_topics_with_the_exact_bytes():
    rig = Rig()
    rig.settle()
    ev = b'{ "ev":"health" , "epoch":1,\n "seq": 1 ,"usig":"x" }  '
    rs = b'{"usig":"x",  "id":"hello-1","status":"ok"}\r\n'
    feed(rig, ev, 101)
    feed(rig, rs, 102)
    got = [(r.topic, r.payload, r.qos, r.retain) for r in rig.net.brokers["primary"].received if r.topic != rig.status]
    assert got == [(f"{rig.ev}/health", ev, 1, False), (rig.up, rs, 1, False)]


def test_unroutable_is_dropped_and_counted_never_published():
    rig = Rig()
    rig.settle()
    for i, bad in enumerate([b'{"v":1}', b"[1]", b"nope", b'{"ev":"a/b"}', b'{"ev":"#"}']):
        feed(rig, bad, 110 + i)
    assert rig.published() == []
    assert rig.metrics.get("upstream_dropped_total", "unroutable") == 5
    assert rig.bridge.accounting_gap() == 0
    feed(rig, b'{"id":"ok"}', 120)
    assert rig.published() == [b'{"id":"ok"}']


def test_the_connectors_own_deployment_get_is_still_not_published():
    rig = Rig()
    rig.settle()
    assert rig.published() == [] and rig.dev.probe_writes  # asked, answered, nothing relayed upstream


# ---- status ------------------------------------------------------------------------------


def test_status_payload_is_exactly_the_backends_shape():
    assert status_payload(True) == b'{"online":true}' and status_payload(False) == b'{"online":false}'


def test_status_follows_broker_and_serial():
    rig = Rig(plugged=False)
    rig.step(5)
    assert json.loads(rig.net.brokers["primary"].retained[rig.status]) == {"online": False}  # no serial yet
    rig.opener.plug()
    rig.step(200, dt=0.05)
    assert rig.net.brokers["primary"].retained[rig.status] == b'{"online":true}'
    st = rig.net.brokers["primary"].on_topic(rig.status)[-1]
    assert (st.qos, st.retain) == (0, True)
    rig.opener.unplug()
    rig.step(5)
    assert rig.net.brokers["primary"].retained[rig.status] == b'{"online":false}'


def test_the_will_is_the_same_bytes_as_the_offline_status():
    rig = Rig()
    rig.settle()
    will = rig.transport._will
    assert (will.topic, will.payload, will.qos, will.retain) == (rig.status, b'{"online":false}', 0, True)
    rig.bridge.stop()
    assert rig.net.brokers["primary"].retained[rig.status] == will.payload


def test_publishes_only_on_topics_the_login_acl_allows():
    rig = Rig()
    rig.settle()
    for i, m in enumerate([b'{"id":"a"}', b'{"ev":"health"}', b'{"ev":"rf"}', b"bad", b'{"ev":"a/b"}']):
        feed(rig, m, 130 + i)
    rig.transport.deliver(rig.down, b'{"id":"c","op":"hello"}')
    rig.step(3)
    root = "test/dev-0000"
    allowed = {f"{root}/resp", f"{root}/status"}
    for r in rig.net.brokers["primary"].received:
        assert r.topic in allowed or (r.topic.startswith(f"{root}/ev/") and r.topic.count("/") == root.count("/") + 2), r.topic
    assert rig.transport._subs == [(f"{root}/req", 0)]


# ---- explicit port -----------------------------------------------------------------------


def test_path_selector_matches_by_device_only():
    p = PortInfo("/dev/ttyACM0", 1, 2, "S", ("usb-X-if00",))
    assert matches(p, Selector(path="/dev/ttyACM0")) and not matches(p, Selector(path="/dev/other"))


def test_open_path_needs_a_character_device(tmp_path):
    missing = Selector(path=str(tmp_path / "nope"))
    with pytest.raises(SerialUnavailable, match="does not exist"):
        open_path(missing)
    f = tmp_path / "regular"
    f.write_text("x")
    with pytest.raises(SerialUnavailable, match="not a character device"):
        open_path(Selector(path=str(f)))
    link = tmp_path / "link"
    link.symlink_to("/dev/null")  # a symlink to a character device, like a udev rule makes
    assert stat.S_ISCHR(os.stat(link).st_mode)
    assert open_path(Selector(path=str(link))) == str(link)


CONFIG = """
[device]
mode = "companion"
select = { by_id = "usb-X-*" }
[mqtt]
client_id = "c1"
topic_root = "mecon/00112233445566778899aabbccddeeff"
[[mqtt.brokers]]
name = "l"
host = "127.0.0.1"
port = 1883
tls = false
insecure_allow_plain = true
"""


def run_main(tmp_path, *args):
    cfg = tmp_path / "c.toml"
    cfg.write_text(CONFIG)
    return entry.main(["--config", str(cfg), "--check-config", *args])


def test_port_option_validates(tmp_path, capsys):
    assert run_main(tmp_path, "--port", "/dev/bench/board0") == 0
    for bad in ("/dev/ttyUSB0", "/dev/bench/*", "relative", "/tmp/x"):
        assert run_main(tmp_path, "--port", bad) == 2
        assert "--port" in capsys.readouterr().err


def test_port_option_replaces_the_config_selector(tmp_path):
    cfg = tmp_path / "c.toml"
    cfg.write_text(CONFIG)
    from mecon_connector.config import load

    new = entry.with_port(load(cfg), "/dev/bench/board0")
    assert new.device.selector == Selector(path="/dev/bench/board0")
    with pytest.raises(ConfigError):
        entry.with_port(load(cfg), "/dev/ttyACM0")
