import pytest

from mecon_connector.config import ConfigError, parse, read_secret

BASE = {
    "device": {"mode": "companion", "select": {"by_id": "usb-X-*"}},
    "mqtt": {"client_id": "c1", "topic_root": "a/b", "brokers": [{"host": "h.invalid"}]},
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


def test_downlink_switch_is_gone_and_gate_limits_are_bounded():
    assert "was removed" in problems(mod(downlink={"enabled": True}))
    assert "recheck_s" in problems(mod(downlink={"gate": {"recheck_s": 5}}))
    c = parse(BASE)
    assert (c.gate.recheck_s, c.gate.retry_s, c.gate.timeout_s) == (600, 30, 8)


def test_raw_tty_path_and_wildcard_selectors_refused():
    for raw_tty in ("/dev/ttyUSB0", "/dev/ttyACM3", "/dev/ttyS0", "/dev/ttyAMA0", "/dev/" "cu.synthetic"):
        assert "kernel tty node" in problems(mod(device__select={"path": raw_tty}))
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
    assert "console line limit" in problems(mod(device__mode="console", device__max_downlink_bytes=1601))
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


# ---- explicit port path (udev symlink) ---------------------------------------------------


def test_path_selector_accepts_a_udev_symlink():
    c = parse(mod(device__select={"path": "/dev/bench/board0"}))
    assert c.device.selector.path == "/dev/bench/board0" and c.device.selector.by_id is None


@pytest.mark.parametrize(
    "bad", ["bench/board0", "/tmp/x", "/dev/bench/*", "/dev/bench/../ttyUSB0", "/dev/bench/", "/dev/bench/a b", "/dev/b?nch/x", ""]
)
def test_path_selector_refuses_unsafe_paths(bad):
    assert "device.select.path" in problems(mod(device__select={"path": bad}))


def test_exactly_one_selector_kind():
    assert "only one" in problems(mod(device__select={"path": "/dev/bench/x", "by_id": "usb-X-*"}))
    assert "only one" in problems(mod(device__select={"path": "/dev/bench/x", "vid": 1, "pid": 2}))
    assert "exactly one" in problems(mod(device__select={}))
    assert "usb_serial needs" in problems(mod(device__select={"path": "/dev/bench/x", "usb_serial": "S"}))


def test_event_topics_are_a_prefix_and_must_not_nest():
    c = parse(BASE)
    assert (c.mqtt.topic_resp, c.mqtt.topic_ev, c.mqtt.topic_req, c.mqtt.topic_status) == tuple(
        f"{c.mqtt.topic_root}/{x}" for x in ("resp", "ev", "req", "status")
    )
    assert "must not be below" in problems(mod(mqtt__topics={"resp": "ev/x"}))
    assert "must differ" in problems(mod(mqtt__topics={"req": "resp"}))


def test_gate_busy_retry_and_failed_threshold_defaults_and_bounds():
    from conftest import make_cfg

    c = make_cfg()
    assert (c.gate.busy_retry_s, c.gate.failed_threshold) == (3.0, 3)
    c = make_cfg(downlink={"gate": {"busy_retry_s": 1, "failed_threshold": 10}})
    assert (c.gate.busy_retry_s, c.gate.failed_threshold) == (1.0, 10)
    for bad in ({"busy_retry_s": 0.5}, {"busy_retry_s": 61}, {"failed_threshold": 0}, {"failed_threshold": 11},
                {"failed_threshold": 2.5}, {"failed_threshold": True}, {"busy_retry_s": "3"}):
        with pytest.raises(ConfigError):
            make_cfg(downlink={"gate": bad})


def test_gate_busy_backoff_after_default_and_bounds():
    from conftest import make_cfg

    assert make_cfg().gate.busy_backoff_after == 3
    assert make_cfg(downlink={"gate": {"busy_backoff_after": 1}}).gate.busy_backoff_after == 1
    for bad in ({"busy_backoff_after": 0}, {"busy_backoff_after": 101}, {"busy_backoff_after": 1.5}, {"busy_backoff_after": True}):
        with pytest.raises(ConfigError):
            make_cfg(downlink={"gate": bad})
