"""Hold configuration, the entry point's exit status, health, and the unit file's restart rule."""

import json
import os
import pathlib
import urllib.error
import urllib.request

import pytest

import mecon_connector.__main__ as entry
from fakes.fake_hold_server import TOKEN, FakeHoldServer
from fakes.fake_serial import FakeOpener
from hold_rig import HoldRig
from mecon_connector.config import ConfigError, parse, read_token
from mecon_connector.health import make_server, serve_in_thread

BASE = {
    "transport": "hold",
    "device": {"mode": "companion", "select": {"by_id": "usb-X-*"}},
    "hold": {"base_url": "https://backend.example.invalid", "token_file": "/run/credentials/x/hold-token"},
}


def mod(**path):
    import copy

    raw = copy.deepcopy(BASE)
    for k, v in path.items():
        d = raw
        *parts, last = k.split("__")
        for p in parts:
            d = d.setdefault(p, {})
        if v is None:
            d.pop(last, None)
        else:
            d[last] = v
    return raw


def problems(raw):
    with pytest.raises(ConfigError) as e:
        parse(raw)
    return " | ".join(e.value.problems)


def test_base_is_valid_and_defaults_are_the_safe_ones():
    c = parse(BASE)
    assert c.transport == "hold" and c.mqtt is None
    h = c.hold
    assert h.ws_url == "wss://backend.example.invalid/gateway/ws" and h.token_presentation == "header"
    assert not h.insecure_allow_plain and h.request_timeout_s == 15


def test_mqtt_transport_is_still_the_default():
    from conftest import make_cfg

    c = make_cfg()
    assert c.transport == "mqtt" and c.hold is None and c.mqtt is not None


def test_the_other_transports_table_is_refused():
    assert "not [mqtt]" in problems(mod(mqtt={"client_id": "x"}))
    raw = {"device": BASE["device"], "hold": BASE["hold"], "mqtt": {"client_id": "c", "topic_root": "a/b", "brokers": [{"host": "h.invalid"}]}}
    assert "needs transport = 'hold'" in problems(raw)
    assert "transport must be" in problems(mod(transport="smoke"))


@pytest.mark.parametrize("url", ["http://backend.invalid", "ws://backend.invalid", "backend.invalid", "https://user:pw@h.invalid",
                                 "https://h.invalid?x=1", "https://h.invalid/#f", "ftp://h.invalid", "https://", ""])
def test_base_url_must_be_https_or_wss_without_credentials_query_or_fragment(url):
    assert "hold.base_url" in problems(mod(hold__base_url=url))


def test_plain_needs_the_explicit_flag_and_the_flag_is_meaningless_with_tls():
    c = parse(mod(hold__base_url="http://127.0.0.1:8080", hold__insecure_allow_plain=True))
    assert c.hold.ws_url == "ws://127.0.0.1:8080/gateway/ws"
    assert "meaningless" in problems(mod(hold__insecure_allow_plain=True))
    assert parse(mod(hold__base_url="wss://h.invalid/p/")).hold.ws_url == "wss://h.invalid/p/gateway/ws"


def test_token_file_presentation_and_ranges():
    assert "hold.token_file" in problems(mod(hold__token_file=None))
    assert "hold.token_file" in problems(mod(hold__token_file="relative/path"))
    assert "token_presentation" in problems(mod(hold__token_presentation="query"))
    assert parse(mod(hold__token_presentation="subprotocol")).hold.token_presentation == "subprotocol"
    assert "request_timeout_s" in problems(mod(hold__request_timeout_s=1))
    assert "unknown key hold.password" in problems(mod(hold__password="x"))


def test_token_file_checks(tmp_path):
    f = tmp_path / "t"
    f.write_text(TOKEN + "\r\n")
    f.chmod(0o600)
    assert read_token(str(f)) == TOKEN
    f.chmod(0o604)
    with pytest.raises(ConfigError, match="every user"):
        read_token(str(f))
    f.chmod(0o640)
    assert read_token(str(f)) == TOKEN  # group access is allowed (a root:service 0640 file)
    f.write_text("")
    with pytest.raises(ConfigError, match="usable token"):
        read_token(str(f))
    f.write_text("two words")
    with pytest.raises(ConfigError, match="usable token"):
        read_token(str(f))
    f.write_text("has;semicolon")
    assert read_token(str(f)) == "has;semicolon"
    with pytest.raises(ConfigError, match="subprotocol"):
        read_token(str(f), "subprotocol")  # `;` is not a token character
    with pytest.raises(ConfigError) as e:
        read_token(str(tmp_path / "absent"))
    assert "FileNotFoundError" in str(e.value) and "absent" in str(e.value)


def write_config(tmp_path, url, token_file, presentation="header"):
    cfg = tmp_path / "config.toml"
    cfg.write_text(
        'transport = "hold"\n[device]\nmode = "companion"\n[device.select]\nby_id = "usb-X-*"\n'
        f'[hold]\nbase_url = "{url}"\ninsecure_allow_plain = true\ntoken_file = "{token_file}"\n'
        f'token_presentation = "{presentation}"\nping_interval_s = 0\n[health]\nenabled = false\n'
    )
    return cfg


def test_check_config_notes_an_absent_token_file_and_refuses_an_unreadable_or_world_readable_one(tmp_path, capsys):
    tf = tmp_path / "tok"
    cfg = write_config(tmp_path, "http://127.0.0.1:1", tf)
    assert entry.main(["--check-config", "--config", str(cfg)]) == 0
    assert "does not exist here" in capsys.readouterr().err
    assert entry.main(["--config", str(cfg)]) == 2  # a real start needs it
    assert "token_file" in capsys.readouterr().err
    tf.write_text(TOKEN)
    tf.chmod(0o666)
    assert entry.main(["--check-config", "--config", str(cfg)]) == 2
    err = capsys.readouterr().err
    assert "every user" in err and TOKEN not in err
    tf.chmod(0o600)
    assert entry.main(["--check-config", "--config", str(cfg)]) == 0


@pytest.mark.parametrize("how", ["bad_token", "refused", "http403"])
def test_main_exits_3_when_the_hold_is_stopped_for_good(tmp_path, monkeypatch, capsys, how):
    server = FakeHoldServer()
    if how == "http403":
        server.http_status = 403
    if how == "refused":
        server.on_connect = lambda c: (c.send({"type": "refused", "reason": "another agent holds this device"}), c.close(1008, ""))
    try:
        tf = tmp_path / "tok"
        tf.write_text(TOKEN if how == "refused" else "not-the-token-123")
        tf.chmod(0o600)
        cfg = write_config(tmp_path, server.url, tf)

        def opener(sel, baud):
            o = FakeOpener(mode="companion")
            o.plug().answers_hello = True
            return o

        monkeypatch.setattr(entry, "make_opener", opener)
        monkeypatch.setattr(entry.signal, "signal", lambda *a: None)
        assert entry.main(["--config", str(cfg)]) == 3
        err = capsys.readouterr().err
        assert "hold stopped" in err and TOKEN not in err and "not-the-token-123" not in err
    finally:
        server.shutdown()


def test_healthz_says_why_a_stopped_hold_is_not_ready(tmp_path):
    r = HoldRig(tmp_path, token="not-the-token-123")
    srv = make_server("127.0.0.1", 0, r.metrics, r.bridge.snapshot)
    serve_in_thread(srv)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        r.wait(lambda: r.bridge.hold_stop is not None)
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(base + "/healthz")
        body = json.loads(e.value.read())
        assert e.value.code == 503 and body["hold_stop"] == "bad_token" and body["hold"] == "stopped"
        text = urllib.request.urlopen(base + "/metrics").read().decode()
        assert "mecon_connector_hold_stopped 1" in text
        assert 'mecon_connector_hold_connect_attempts_total{result="bad_token"} 1' in text
    finally:
        srv.shutdown()
        srv.server_close()
        r.close()


def test_healthz_is_ready_while_the_hold_is_open(tmp_path):
    r = HoldRig(tmp_path)
    srv = make_server("127.0.0.1", 0, r.metrics, r.bridge.snapshot)
    serve_in_thread(srv)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        r.up()
        body = json.load(urllib.request.urlopen(base + "/healthz"))
        assert body == {"transport": "hold", "serial": "up", "hold": "connected", "downlink": "open", "ready": True}
        text = urllib.request.urlopen(base + "/metrics").read().decode()
        assert "mecon_connector_hold_connected 1" in text and "mecon_connector_hold_uploads_total{kind=\"hello\"} 1" in text
        assert "mecon_connector_broker_connected" not in text  # no MQTT series in hold mode
    finally:
        srv.shutdown()
        srv.server_close()
        r.close()


UNIT = pathlib.Path(__file__).resolve().parents[1] / "deploy" / "systemd"


def test_unit_does_not_restart_on_a_stopped_hold():
    text = (UNIT / "mecon-connector.service").read_text()
    line = [ln for ln in text.splitlines() if ln.startswith("RestartPreventExitStatus=")]
    assert line == ["RestartPreventExitStatus=2 3"]
    from mecon_connector.hold import EXIT_HOLD_STOPPED

    assert EXIT_HOLD_STOPPED == 3


def test_hold_dropin_example_loads_the_token_as_a_credential_and_holds_no_secret():
    text = (UNIT / "mecon-connector-hold.conf.example").read_text()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert lines == [
        "[Service]",
        "LoadCredential=",
        "LoadCredential=hold-token:/etc/mecon-connector/credentials/hold-token",
    ]


def test_shipped_hold_example_config_is_valid(capsys):
    import tomllib

    raw = tomllib.loads((UNIT.parent / "config.hold.example.toml").read_text())
    c = parse(raw)
    assert c.transport == "hold" and c.hold.token_file == "/run/credentials/mecon-connector.service/hold-token"
    assert c.hold.token_presentation == "header" and not c.hold.insecure_allow_plain
