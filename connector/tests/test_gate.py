"""The enrolment gate: downlink is open only while the device says it holds a Deployment record."""

import json

import pytest

from conftest import Rig, make_cfg

CMD = b'{"v":1,"id":"syn-cmd","op":"clock.get"}'
PROBE = b'{"v":1,"id":"cg-1","op":"deployment.get"}'


def send_cmd(rig, n=1):
    for _ in range(n):
        rig.transport.deliver(rig.down, CMD)
    rig.step(2)


def gate_open(rig):
    return rig.metrics.get("downlink_gate_open") == 1


def probes(rig, label):
    return rig.metrics.get("downlink_gate_probes_total", label)


# ---- closed until provisioned, and closed on anything else --------------------------------


def test_closed_before_the_device_answers_then_open_on_provisioned():
    rig = Rig()
    rig.step(1)  # the request is out, the answer has not been read
    send_cmd(rig)
    assert rig.dev.written == [] and rig.metrics.get("downlink_closed_total") == 1
    rig.step(3)
    assert gate_open(rig) and probes(rig, "provisioned") == 1
    send_cmd(rig)
    assert len(rig.dev.written) == 1 and rig.bridge.snapshot()["downlink"] == "open"


@pytest.mark.parametrize("state", ["none", "corrupt", "silent", "garbage", "refused", "bad_state", "wrong_id"])
def test_every_other_answer_or_none_keeps_it_closed(state):
    rig = Rig(enrolment=state)
    rig.step(int(10 / 0.05), dt=0.05)  # past the 8 s timeout
    assert not gate_open(rig)
    send_cmd(rig, 3)
    assert rig.dev.written == []
    assert rig.metrics.get("downlink_closed_total") == 3
    assert rig.metrics.get("downlink_received_total") == 3
    assert rig.metrics.get("downlink_written_total") == 0


def test_probe_outcomes_are_counted_by_kind():
    for state, label in [("none", "none"), ("corrupt", "corrupt"), ("refused", "refused"), ("bad_state", "malformed"),
                         ("silent", "timeout"), ("garbage", "timeout")]:
        rig = Rig(enrolment=state)
        rig.step(int(10 / 0.05), dt=0.05)
        assert probes(rig, label) >= 1, state


# ---- the Connector's own request ----------------------------------------------------------


def test_probe_is_one_read_request_and_never_goes_upstream():
    rig = Rig()
    rig.settle()
    assert len(rig.dev.probe_writes) == 1
    assert rig.dev._decode(rig.dev.probe_writes[0]) == PROBE
    assert rig.published() == []  # the device's answer to it is the Connector's traffic, not the device's
    assert rig.metrics.get("upstream_envelopes_total") == 0
    assert rig.metrics.get("downlink_written_total") == 0  # and it is not counted as a downlink message


def test_console_mode_probe_and_gate():
    rig = Rig(cfg=make_cfg(mode="console"))
    rig.settle()
    assert rig.dev.probe_writes == [b"mecon> " + PROBE + b"\r"]
    assert gate_open(rig) and rig.published() == []
    rig.dev.enrolment = "none"
    rig.dev.say(rig.dev.event(signed=False))
    rig.step(2)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "unsigned_uplink") == 1


def test_late_answer_to_an_old_request_is_dropped_not_forwarded():
    rig = Rig(enrolment="silent")
    rig.step(int(10 / 0.05), dt=0.05)
    rig.dev.say(b'{"v":1,"id":"cg-1","status":"ok","result":{"state":"provisioned"}}')
    rig.step(3)
    assert not gate_open(rig) and probes(rig, "late") == 1 and rig.published() == []


# ---- close at once on an unsigned uplink --------------------------------------------------


def test_signed_uplink_keeps_it_open_and_is_forwarded_unchanged():
    rig = Rig()
    rig.settle()
    ev = rig.dev.event()
    rig.dev.say(ev)
    rig.step(3)
    assert gate_open(rig) and rig.published() == [ev]


def test_first_unsigned_uplink_closes_at_once_and_is_still_forwarded_unchanged():
    rig = Rig()
    rig.settle()
    send_cmd(rig)
    assert len(rig.dev.written) == 1
    ev = rig.dev.event(signed=False)
    rig.dev.enrolment = "none"  # what follows a deployment.reset
    rig.dev.say(ev)
    rig.step(1)
    assert not gate_open(rig)
    assert rig.metrics.get("downlink_gate_closes_total", "unsigned_uplink") == 1
    assert rig.published() == [ev]  # uplink is byte for byte, always
    send_cmd(rig)
    assert len(rig.dev.written) == 1  # the second command did not go out
    assert rig.metrics.get("downlink_closed_total") == 1


def test_unparseable_uplink_counts_as_unsigned():
    rig = Rig()
    rig.settle()
    rig.dev.enrolment = "none"
    rig.dev.say(b"not json at all")
    rig.step(2)
    assert not gate_open(rig) and rig.published() == []  # no route: dropped and counted, not guessed
    assert rig.metrics.get("upstream_dropped_total", "unroutable") == 1


def test_it_reopens_only_after_a_fresh_provisioned_answer():
    rig = Rig()
    rig.settle()
    rig.dev.enrolment = "none"
    rig.dev.say(rig.dev.event(signed=False))
    rig.step(5)
    assert probes(rig, "none") == 1 and not gate_open(rig)
    rig.dev.enrolment = "provisioned"  # re-enrolled, but the Connector has not asked yet
    send_cmd(rig)
    assert rig.dev.written == []
    rig.step(int(31 / 0.05), dt=0.05)  # retry interval while closed
    assert gate_open(rig)
    send_cmd(rig)
    assert len(rig.dev.written) == 1


# ---- reboot, periodic re-check, reconnect -------------------------------------------------


def test_a_new_epoch_closes_and_re_checks():
    rig = Rig()
    rig.settle()
    before = len(rig.dev.probe_writes)
    rig.dev.epoch = 2
    rig.dev.say(rig.dev.event(epoch=2))  # signed, so only the epoch gives the reboot away
    rig.step(1)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "epoch_changed") == 1
    rig.step(4)
    assert len(rig.dev.probe_writes) == before + 1 and gate_open(rig)


def test_epoch_read_from_a_result_envelopes_top_level_too():
    rig = Rig()
    rig.settle()
    rig.dev.say(json.dumps({"v": 1, "id": "r-1", "status": "ok", "epoch": 9, "result": {}, "usig": "x"}).encode())
    rig.step(2)
    assert rig.metrics.get("downlink_gate_closes_total", "epoch_changed") == 1


def test_only_the_top_level_epoch_counts_not_result_epoch_authority_epoch_or_usig_boot():
    # Issue 91: inside an answer `result.epoch` / `authority_epoch` mean something else and `usig_boot` is a
    # separate signing counter. Differing values there, with the envelope's own `epoch` unchanged, are no reboot.
    rig = Rig()
    rig.settle()
    e = rig.dev.epoch
    rig.dev.say(json.dumps({"v": 1, "id": "r-1", "status": "ok", "epoch": e, "usig_boot": e + 40, "usig_seq": 3,
                            "result": {"epoch": e + 7, "authority_epoch": e + 3}, "usig": "x"}).encode())
    # and an answer carrying no top-level epoch at all: nothing in it may be taken as the boot epoch
    rig.dev.say(json.dumps({"v": 1, "id": "r-2", "status": "ok", "usig_boot": e + 40, "usig_seq": 4,
                            "result": {"epoch": e + 7}, "usig": "x"}).encode())
    rig.dev.say(rig.dev.event(epoch=e))
    rig.step(2)
    assert rig.metrics.get("downlink_gate_closes_total", "epoch_changed") == 0 and gate_open(rig)


def test_periodic_recheck_keeps_it_open_while_provisioned():
    rig = Rig()
    rig.settle()
    rig.step(int(605 / 0.5), dt=0.5)
    assert len(rig.dev.probe_writes) == 2 and gate_open(rig)
    assert probes(rig, "provisioned") == 2


def test_periodic_recheck_closes_when_the_record_is_gone():
    rig = Rig()
    rig.settle()
    rig.dev.enrolment = "none"
    rig.step(int(605 / 0.5), dt=0.5)
    assert not gate_open(rig)
    assert rig.metrics.get("downlink_gate_closes_total", "not_provisioned") == 1


def test_periodic_recheck_with_no_answer_closes():
    rig = Rig()
    rig.settle()
    rig.dev.enrolment = "silent"
    rig.step(int(620 / 0.5), dt=0.5)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "probe_failed") == 1


def test_recheck_interval_is_configurable():
    rig = Rig(cfg=make_cfg(downlink={"gate": {"recheck_s": 30}}))
    rig.settle()
    rig.step(int(65 / 0.5), dt=0.5)
    assert len(rig.dev.probe_writes) >= 3


def test_broker_reconnect_closes_and_asks_again():
    rig = Rig()
    rig.settle()
    n = len(rig.dev.probe_writes)
    rig.transport.drop_session()
    rig.step(2)
    rig.step(int(5 / 0.05), dt=0.05)
    assert rig.metrics.get("downlink_gate_closes_total", "reconnect") == 1
    assert len(rig.dev.probe_writes) == n + 1 and gate_open(rig)


def test_unplug_closes_and_replug_asks_again():
    rig = Rig()
    rig.settle()
    rig.opener.unplug()
    rig.step(3)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "serial_lost") == 1
    new = rig.opener.plug()
    rig.step(int(5 / 0.05), dt=0.05)
    assert len(new.probe_writes) == 1 and gate_open(rig)


# ---- nothing is held or replayed ----------------------------------------------------------


def test_a_command_received_while_closed_is_not_replayed_when_it_opens():
    rig = Rig()
    rig.step(1)  # asked, not yet answered
    send_cmd(rig)
    assert rig.metrics.get("downlink_closed_total") == 1
    rig.step(10)  # the gate opens well inside the command's 5 s lifetime
    assert gate_open(rig) and rig.dev.written == []


def test_commands_queued_when_the_gate_closes_are_refused_not_kept():
    rig = Rig()
    rig.settle()
    rig.transport.deliver(rig.down, CMD)  # queued, not yet written
    rig.dev.enrolment = "none"
    rig.dev.say(rig.dev.event(signed=False))
    rig.step(1)
    rig.dev.enrolment = "provisioned"
    rig.step(int(31 / 0.05), dt=0.05)
    assert gate_open(rig) and rig.dev.written == []


# ---- clean release on shutdown ------------------------------------------------------------


def test_stop_publishes_offline_before_closing_the_session():
    rig = Rig()
    rig.settle()
    order = []
    orig_pub, orig_disc = rig.transport.publish, rig.transport.disconnect
    rig.transport.publish = lambda *a, **k: (order.append(("publish", a[0], json.loads(a[1])["online"])), orig_pub(*a, **k))[1]
    rig.transport.disconnect = lambda: (order.append(("disconnect",)), orig_disc())[1]
    rig.bridge.stop()
    assert order[0] == ("publish", rig.status, False) and order[-1] == ("disconnect",)


# ---- how an answer is classified: busy and failed are not "not provisioned" ----------------


def run_until(rig, cond, max_s, dt=0.1):
    """Steps until cond() holds; returns the seconds it took. Fails after max_s."""
    t0 = rig.clock.t
    while not cond():
        assert rig.clock.t - t0 < max_s, f"not within {max_s} s"
        rig.step(1, dt=dt)
    return rig.clock.t - t0


def open_rig(**kw):
    rig = Rig(**kw)
    rig.settle()
    assert gate_open(rig)
    return rig


def answered(rig, label, n, max_s):
    return run_until(rig, lambda: probes(rig, label) == n, max_s)


def closes(rig):
    return rig.metrics.total("downlink_gate_closes_total")


def test_busy_keeps_an_open_gate_open_and_is_asked_again_within_busy_retry_s():
    rig = open_rig()
    rig.dev.enrolment = "busy"
    answered(rig, "busy", 1, 605)
    assert gate_open(rig) and closes(rig) == 0
    send_cmd(rig)
    assert len(rig.dev.written) == 1  # downlink still flows
    rig.dev.enrolment = "provisioned"
    took = answered(rig, "provisioned", 2, 30)
    assert 2.5 <= took <= 3.5  # busy_retry_s (3), not retry_s or recheck_s
    assert gate_open(rig) and closes(rig) == 0


def test_busy_on_a_closed_gate_keeps_it_closed_and_asks_again_soon():
    rig = Rig(enrolment="busy")
    answered(rig, "busy", 1, 2)
    assert not gate_open(rig)
    assert answered(rig, "busy", 2, 30) <= 3.5
    rig.dev.enrolment = "provisioned"
    answered(rig, "provisioned", 1, 4)
    assert gate_open(rig)


def test_busy_retry_is_configurable():
    rig = Rig(cfg=make_cfg(downlink={"gate": {"busy_retry_s": 10}}), enrolment="busy")
    answered(rig, "busy", 1, 2)
    assert 9.5 <= answered(rig, "busy", 2, 30) <= 10.5


def test_failed_keeps_the_gate_below_the_threshold_and_closes_at_it():
    rig = open_rig()
    rig.dev.enrolment = "failed"
    answered(rig, "failed", 1, 605)
    assert gate_open(rig) and closes(rig) == 0
    assert 29.5 <= answered(rig, "failed", 2, 40) <= 30.5  # asked again on retry_s
    assert gate_open(rig) and closes(rig) == 0
    send_cmd(rig)
    assert len(rig.dev.written) == 1  # downlink still flows below the threshold
    answered(rig, "failed", 3, 40)
    assert not gate_open(rig)
    assert rig.metrics.get("downlink_gate_closes_total", "probe_failed") == 1 and closes(rig) == 1


def test_a_provisioned_answer_between_failed_answers_starts_the_count_again():
    rig = open_rig()
    rig.dev.enrolment = "failed"
    answered(rig, "failed", 2, 640)
    rig.dev.enrolment = "provisioned"
    answered(rig, "provisioned", 2, 40)
    rig.dev.enrolment = "failed"
    answered(rig, "failed", 4, 640)
    assert gate_open(rig) and closes(rig) == 0  # two in a row, not four


def test_busy_neither_counts_as_failed_nor_ends_the_run():
    rig = open_rig()
    rig.dev.enrolment = "failed"
    answered(rig, "failed", 2, 640)
    rig.dev.enrolment = "busy"
    answered(rig, "busy", 2, 40)
    assert gate_open(rig)
    rig.dev.enrolment = "failed"
    answered(rig, "failed", 3, 40)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "probe_failed") == 1


def test_failed_threshold_is_configurable():
    rig = open_rig(cfg=make_cfg(downlink={"gate": {"failed_threshold": 1}}))
    rig.dev.enrolment = "failed"
    answered(rig, "failed", 1, 605)
    assert not gate_open(rig)


def test_none_on_a_recheck_closes_at_once():
    rig = open_rig()
    rig.dev.enrolment = "none"
    answered(rig, "none", 1, 605)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "not_provisioned") == 1


def test_an_unknown_status_is_a_refusal_and_closes_at_once():
    rig = open_rig()
    rig.dev.enrolment = "refused"
    answered(rig, "refused", 1, 605)
    assert not gate_open(rig) and rig.metrics.get("downlink_gate_closes_total", "not_provisioned") == 1


def test_a_missing_status_is_a_refusal():
    from mecon_connector.gate import classify_probe

    assert classify_probe({"id": "cg-1", "result": {"state": "provisioned"}}) == "refused"
    assert classify_probe({"status": "BUSY"}) == "refused"  # exact statuses only
    assert classify_probe({"status": "ok", "result": "provisioned"}) == "malformed"


@pytest.mark.parametrize("answer,error", [("busy", "no-memory"), ("failed", "storage"), ("refused", "not-permitted")])
def test_a_not_ok_answer_is_logged_with_status_and_error_only(answer, error):
    import io

    from mecon_connector.logutil import Log

    rig = open_rig()
    buf = io.StringIO()
    rig.bridge.log = Log(buf)
    rig.dev.enrolment = answer
    answered(rig, answer, 1, 605)
    lines = [json.loads(ln) for ln in buf.getvalue().splitlines()]
    warns = [ln for ln in lines if ln["event"] == "gate_probe_not_ok"]
    assert len(warns) == 1
    assert warns[0]["level"] == "warn" and warns[0]["status"] == answer and warns[0]["error"] == error
    assert set(warns[0]) == {"ts", "level", "event", "status", "error"}
    assert "usig" not in buf.getvalue() and "U1lOVEhFVElD" not in buf.getvalue()  # the answer carried one


def test_an_ok_answer_logs_no_probe_warning():
    import io

    from mecon_connector.logutil import Log

    rig = Rig()
    buf = io.StringIO()
    rig.bridge.log = Log(buf)
    rig.settle()
    assert "gate_probe_not_ok" not in buf.getvalue()
