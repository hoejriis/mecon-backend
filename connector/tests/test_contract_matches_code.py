"""The code and contracts/connector/v1/mapping.json must say the same thing."""

import json

from conftest import FIXTURES, make_cfg
from mecon_connector import CONTRACT_VERSION, framing
from mecon_connector.metrics import PREFIX, REASONS, REGISTRY

MAPPING = json.loads((FIXTURES.parent / "mapping.json").read_text())


def test_version_matches():
    assert MAPPING["version"] == CONTRACT_VERSION
    for f in FIXTURES.glob("*.json"):
        assert json.loads(f.read_text())["contract"] == f"mecon-usb-connector/{CONTRACT_VERSION}"


def test_metric_registry_equals_contract():
    assert PREFIX == MAPPING["metrics_prefix"]
    contract = {m["name"]: m for m in MAPPING["metrics"]}
    assert set(contract) == set(REGISTRY)
    for name, (typ, _help, labels) in REGISTRY.items():
        assert contract[name]["type"] == typ
        assert set(contract[name]["labels"]) == set(labels) or (not labels and not contract[name]["labels"])
        if labels:
            assert set(next(iter(contract[name]["labels"].values()))) == REASONS[name]


def test_framing_constants_equal_contract():
    s = MAPPING["serial"]
    assert framing.MAX_FRAME_SIZE == s["companion"]["wrapper"]["max_payload"]
    assert framing.MECON_FRAME_BODY == s["companion"]["mecon_frame"]["body_max"]
    assert [1, framing.MECON_MAX_FRAMES] == s["companion"]["mecon_frame"]["count"]
    assert framing.MECON_MAX_MESSAGE == s["companion"]["mecon_frame"]["message_max"]
    assert framing.MECON_INCOMPLETE_S == s["companion"]["mecon_frame"]["incomplete_timeout_s"]
    assert framing.CONSOLE_MAX_LINE == s["console"]["max_line_bytes"]
    assert framing.CONSOLE_JSON_PREFIX.decode() == s["console"]["accepted_prefix"]
    assert f"0x{framing.MARKER_FROM_DEVICE:02X}" == s["companion"]["wrapper"]["device_to_host_marker"]
    assert f"0x{framing.MARKER_TO_DEVICE:02X}" == s["companion"]["wrapper"]["host_to_device_marker"]


def test_defaults_equal_contract():
    c = make_cfg()
    q, m = MAPPING["queues"], MAPPING["mqtt"]
    assert c.queues.upstream_max_messages == q["upstream"]["max_messages_default"]
    assert c.queues.upstream_max_bytes == q["upstream"]["max_bytes_default"]
    assert c.queues.upstream_ttl_s == q["upstream"]["ttl_s_default"]
    assert c.queues.upstream_max_inflight == q["upstream"]["max_inflight_default"]
    assert c.queues.downlink_max_messages == q["downlink"]["max_messages_default"]
    assert c.queues.downlink_ttl_s == q["downlink"]["ttl_s_default"]
    assert c.mqtt.keepalive_s == m["keepalive_s_default"]
    assert c.mqtt.hold_down_s == m["brokers"]["hold_down_s_default"]
    assert c.mqtt.connect_timeout_s == m["reconnect"]["connect_timeout_s_default"]
    assert c.mqtt.upstream_qos == m["topics"]["resp"]["qos"] == m["topics"]["ev"]["qos"]
    assert c.device.stall_s == MAPPING["serial"]["stall_s_default"]
    bo = m["reconnect"]["backoff"]
    assert (c.mqtt.backoff_base_s, c.mqtt.backoff_max_s, c.mqtt.backoff_jitter) == (
        bo["network_or_timeout"]["base_s"], bo["network_or_timeout"]["max_s"], bo["jitter"])
    assert c.mqtt.stable_after_s == bo["reset_after_stable_s"]
    assert c.device.max_downlink_bytes == MAPPING["serial"]["companion"]["downlink"]["max_message_bytes_default"]
    cons = make_cfg(mode="console")
    assert cons.device.max_downlink_bytes == MAPPING["serial"]["console"]["downlink"]["max_message_bytes_default"]


def test_topic_templates_equal_contract():
    c = make_cfg()
    t = MAPPING["mqtt"]["topics"]
    for key, got in (
        ("resp", c.mqtt.topic_resp), ("ev", c.mqtt.topic_ev + "/{ev}"), ("req", c.mqtt.topic_req),
        ("status", c.mqtt.topic_status),
    ):
        assert got == t[key]["template"].replace("{topic_root}", c.mqtt.topic_root)


def test_metrics_identity_is_what_the_code_checks():
    assert "upstream_envelopes_total" in MAPPING["metrics_identity"]


def test_gate_contract_matches_code():
    g = MAPPING["enrolment_gate"]
    c = make_cfg()
    assert g["timeout_s_default"] == c.gate.timeout_s == 8
    assert json.loads(g["request"]["text"].replace("<n>", "1")) == {"v": 1, "id": "cg-1", "op": "deployment.get"}
    assert g["request"]["id_prefix_reserved"] == "cg-"
    assert (c.gate.recheck_s, c.gate.retry_s) == (600, 30)
    answered = {q["id"] for q in MAPPING["open_questions"] if q["status"] == "answered"}
    assert {"Q1", "Q2", "Q3", "Q5"} <= answered
