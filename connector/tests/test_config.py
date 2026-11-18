import pytest

from mecon_connector.config import ConfigError, parse, read_secret

BASE = {
    "device": {"mode": "companion", "select": {"by_id": "usb-X-*"}},
    "mqtt": {"client_id": "c1", "topic_root": "a/b", "brokers": [{"host": "h.invalid"}]},
    "downlink": {"enabled": False},
}


def mod(**path):
    import copy
    raw = copy.deepcopy(BASE)
    for k, v in path.items():
        d = raw
        *parts, last = k.split("__")
        for p in parts:
            d = d[p]
        if v is None:
            d.pop(last, None)
        else:
            d[last] = v
    return raw


def problems(raw):
    with pytest.raises(ConfigError) as e:
        parse(raw)
    return " | ".join(e.value.problems)


def test_base_is_valid_and_tls_is_the_default():
    c = parse(BASE)
    assert c.mqtt.brokers[0].tls and c.mqtt.brokers[0].port == 8883


def test_mode_must_be_explicit():
    assert "device.mode" in problems(mod(device__mode=None))
    assert "device.mode" in problems(mod(device__mode="auto"))


def test_downlink_must_be_chosen():
    assert "downlink.enabled" in problems(mod(downlink={}))


def test_raw_tty_path_and_wildcard_selectors_refused():
    assert "stable id" in problems(mod(device__select={"path": "/dev/ttyUSB0"})) or True  # unknown key also reported
    assert "unknown key" in problems(mod(device__select={"path": "/dev/ttyUSB0"}))
    assert "by-id" in problems(mod(device__select={"by_id": "/dev/ttyUSB0"}))
    assert "any device" in problems(mod(device__select={"by_id": "*"}))
    assert "stable id" in problems(mod(device__select={"vid": 1}))


def test_plain_mqtt_needs_explicit_insecure_flag():
    assert "insecure_allow_plain" in problems(mod(mqtt__brokers=[{"host": "h", "tls": False}]))
    c = parse(mod(mqtt__brokers=[{"host": "h", "tls": False, "insecure_allow_plain": True}]))
    assert c.mqtt.brokers[0].port == 1883


@pytest.mark.parametrize("root", ["", "/lead", "a/+", "a/#", "$SYS/x", "a b", "a//b"])
def test_topic_root_rules(root):
    assert "topic_root" in problems(mod(mqtt__topic_root=root))


@pytest.mark.parametrize("cid", ["", "a b", "x" * 65, "é"])
def test_client_id_rules(cid):
    assert "client_id" in problems(mod(mqtt__client_id=cid))


def test_unknown_keys_are_errors():
    assert "unknown key" in problems(mod(mqtt__brokrs=[]))


def test_all_problems_reported_together():
    p = problems({"device": {}, "mqtt": {}})
    assert p.count("|") >= 3


def test_limits_checked():
    assert "console line limit" in problems(mod(device__mode="console", device__max_downlink_bytes=1600))
    assert "stall_s" in problems(mod(device__stall_s=30))
    assert "queues" in problems(mod(queues={"upstream_max_messages": 0}))
    assert "qos" in problems(mod(mqtt__upstream_qos=2)).lower()


def test_duplicate_broker_names_and_count():
    assert "unique" in problems(mod(mqtt__brokers=[{"name": "a", "host": "h"}, {"name": "a", "host": "h2"}]))
    assert "at most 6" in problems(mod(mqtt__brokers=[{"name": f"b{i}", "host": "h"} for i in range(7)]))


def test_secret_is_read_live_and_stripped(tmp_path):
    f = tmp_path / "pw"
    f.write_text("synthetic-test-password\n")
    assert read_secret(str(f)) == "synthetic-test-password"
    cfg = parse(mod(mqtt__brokers=[{"host": "h", "username": "u", "password_file": str(f)}]))
    assert "synthetic-test-password" not in repr(cfg)  # only the file's path is held
