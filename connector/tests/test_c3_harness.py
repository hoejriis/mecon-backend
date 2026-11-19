"""The C3 harness's own guards: the Backend stand-in can publish only two read requests, and the observer
never shows payload content."""

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

import c3_observer  # noqa: E402
import c3_standin  # noqa: E402

from mecon_connector.bridge import GATE_ID_RE  # noqa: E402

SECRET = "SECRETCONTENT-9f3a"


class FakeClient:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload, qos, retain):
        self.published.append((topic, payload, qos, retain))
        return "info"


def test_standin_vocabulary_is_exactly_two_read_requests():
    assert list(c3_standin.READ_ONLY_REQUESTS) == ["hello", "deployment.get"]
    assert json.loads(c3_standin.build_request("hello")) == {"v": 1, "id": "c3-hello-1", "op": "hello"}
    assert json.loads(c3_standin.build_request("deployment.get")) == {"v": 1, "id": "c3-dg-1", "op": "deployment.get"}


@pytest.mark.parametrize("op", ["device.reset", "deployment.provision", "deployment.reset", "identity.key.export", "ble.pin.get",
                                "password.set", "channel.put", "config.get", "status.get", "", "HELLO", "hello ", "hello\n"])
def test_standin_refuses_everything_else_and_sends_nothing(op):
    c = FakeClient()
    with pytest.raises(c3_standin.RefusedRequest):
        c3_standin.publish_request(c, "mecon/x", op)
    assert c.published == []


def test_standin_publishes_qos0_not_retained_to_req_only():
    c = FakeClient()
    for op in c3_standin.READ_ONLY_REQUESTS:
        c3_standin.publish_request(c, "mecon/x", op)
    assert [(t, q, r) for t, _p, q, r in c.published] == [("mecon/x/req", 0, False)] * 2


def test_standin_ids_never_use_the_connectors_reserved_prefix():
    for rid in c3_standin.READ_ONLY_REQUESTS.values():
        assert not GATE_ID_RE.match(rid) and not rid.startswith("cg-")


def test_standin_ops_are_read_class_ops_the_gate_already_uses():
    # hello and deployment.get are the two the contract names as read-class; the Connector's gate sends deployment.get
    mapping = json.loads((pathlib.Path(__file__).resolve().parents[2] / "contracts/connector/v1/mapping.json").read_text())
    assert mapping["enrolment_gate"]["request"]["op"] == "deployment.get"
    assert "read" in mapping["enrolment_gate"]["request"]["class"]


ROOT = "mecon/00112233445566778899aabbccddeeff"


def test_observer_output_has_no_payload_content():
    obs = c3_observer.Observer(ROOT)
    payloads = [
        (f"{ROOT}/resp", json.dumps({"v": 1, "id": SECRET, "status": "ok", "result": {"name": SECRET}, "usig": "x"}).encode()),
        (f"{ROOT}/resp", json.dumps({"v": 1, "id": "c3-hello-1", "result": {"name": SECRET}, "usig": "x"}).encode()),
        (f"{ROOT}/ev/health", json.dumps({"v": 1, "ev": "health", "data": {"text": SECRET}, "usig": "x"}).encode()),
        (f"{ROOT}/req", json.dumps({"v": 1, "id": SECRET, "op": SECRET}).encode()),
        (f"{ROOT}/status", b'{"online":true}'),
        (f"{ROOT}/other", SECRET.encode()),
    ]
    lines = [obs.line(obs.add(t, p, False, 1)) for t, p in payloads]
    everything = "\n".join(lines) + json.dumps(obs.summary()) + json.dumps(c3_observer.checklist(obs.summary(), True, 1))
    assert SECRET not in everything
    assert "id=c3-hello-1" in everything  # the stand-in's own ids are the one thing echoed
    assert "op=hello" not in everything and "op=other" in everything


def test_observer_classifies_topics_and_flags_surprises():
    c = c3_observer.classify
    assert c(ROOT, f"{ROOT}/resp") == "resp" and c(ROOT, f"{ROOT}/ev/rf") == "ev/rf" and c(ROOT, f"{ROOT}/status") == "status"
    for bad in (f"{ROOT}/up", f"{ROOT}/ev/a/b", f"{ROOT}/ev/", f"{ROOT}x/resp", "other/resp", f"{ROOT}/connector/status"):
        assert c(ROOT, bad) == "unexpected"
    obs = c3_observer.Observer(ROOT)
    obs.add(f"{ROOT}/up", b"{}", False, 1)
    obs.add(f"{ROOT}/resp", b'{"v":1}', False, 1)  # a response with no id is malformed
    obs.add(f"{ROOT}/ev/health", b'{"ev":"radio","usig":"x"}', False, 1)  # topic and ev disagree
    assert obs.summary()["malformed"] == 3


def test_observer_checklist_fails_on_unsigned_or_missing_answers():
    obs = c3_observer.Observer(ROOT)
    obs.add(f"{ROOT}/status", b'{"online":true}', True, 0)
    obs.add(f"{ROOT}/ev/health", b'{"ev":"health"}', False, 1)  # no usig
    s = obs.summary()
    s["late_status"] = (True, True)
    res = {t: ok for t, ok, _d in c3_observer.checklist(s, True, 1)}
    assert not res["every response and event carries a usig member (the device signed it)"]
    assert not res["both read requests were answered on resp, matched by their ids"]
    s["late_status"] = (True, False)
    assert not c3_observer.checklist(s, False, 0)[0][1]  # not retained
