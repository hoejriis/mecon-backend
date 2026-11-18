"""Drives every synthetic contract fixture through the real bridge with fake endpoints."""

import pytest

from conftest import Rig, load_fixture, make_cfg

UP = load_fixture("upstream.json")["cases"]
DOWN = load_fixture("downlink.json")["cases"]


def _runs():
    for c in UP:
        for ch in c["chunkings"]:
            yield pytest.param(c, ch, id=f'{c["id"]}[{ch}]')


@pytest.mark.parametrize("case,chunking", list(_runs()))
def test_upstream_fixture(case, chunking):
    # A silent device: the enrolment gate stays closed and sends nothing of its own, so these
    # cases show uplink is identical whatever the gate does (the gate has its own tests).
    rig = Rig(cfg=make_cfg(mode=case["mode"]), enrolment="silent")
    rig.settle()
    raw = b"".join(bytes.fromhex(h) for h in case["serial_chunks_hex"])
    rig.dev.feed_bytes(raw, chunking)
    rig.step(len(raw) + 10)
    want = [bytes.fromhex(p["payload_hex"]) for p in case["expect"]["publishes"]]
    assert rig.published() == want
    for p in case["expect"]["publishes"]:
        assert p["topic"] == "{up}" and p["qos"] == 1 and p["retain"] is False
    for r in rig.net.brokers["primary"].on_topic(rig.up):
        assert r.qos == 1 and r.retain is False
    for key, val in case["expect"]["metrics"].items():
        name, _, label = key.partition("/")
        assert rig.metrics.get(name, label or None) == val, key
    assert rig.bridge.accounting_gap() == 0


@pytest.mark.parametrize("case", DOWN, ids=[c["id"] for c in DOWN])
def test_downlink_fixture(case):
    rig = Rig(cfg=make_cfg(mode=case["mode"]))
    rig.settle()
    inb = case["inbound"]
    assert inb["topic"] == "{down}"
    rig.transport.deliver(rig.down, bytes.fromhex(inb["payload_hex"]), retain=inb["retain"])
    rig.step(3)
    exp = case["expect"]
    if exp["serial_written_hex"] is None:
        assert rig.dev.written == []
        assert rig.metrics.get("downlink_dropped_total", exp["dropped_reason"]) == 1
    else:
        assert rig.dev.written_bytes.hex() == exp["serial_written_hex"]
        assert len(rig.dev.written) == 1  # one write per message
        assert rig.metrics.get("downlink_written_total") == 1


GATE = load_fixture("gate.json")["cases"]


@pytest.mark.parametrize("case", GATE, ids=[c["id"] for c in GATE])
def test_gate_fixture(case):
    rig = Rig(cfg=make_cfg(mode=case["mode"]), enrolment=case["enrolment"])
    rig.step(int(10 / 0.05), dt=0.05)
    exp = case["expect"]
    assert rig.dev.probe_writes[0].hex() == exp["probe_request_hex"]
    assert (rig.metrics.get("downlink_gate_open") == 1) == exp["gate_open"]
    assert rig.metrics.get("downlink_gate_probes_total", exp["probe_result"]) >= 1
    assert len(rig.published()) == exp["upstream_publishes"]
    sent = []
    for step in case["then"]:
        if step["enrolment_after"]:
            rig.dev.enrolment = step["enrolment_after"]
        kind = step["uplink"]
        if kind == "new_epoch_event":
            rig.dev.epoch = 2
        ev = rig.dev.event(signed=kind != "unsigned_event", epoch=2 if kind == "new_epoch_event" else None)
        sent.append(ev)
        rig.dev.say(ev)
        rig.step(6)
        assert (rig.metrics.get("downlink_gate_open") == 1) == step["gate_open_after"], kind
    if case["then"]:
        assert rig.published() == sent  # forwarded unchanged, in order
