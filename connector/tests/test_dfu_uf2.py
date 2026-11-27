"""A serial DFU that ends without completing once data writing has begun left a board only a UF2 copy
recovered (on the nRF52 boards tested). The Connector must detect and report that, never retry serial, never report it recovered
(contracts/connector-hold/v1, section 12.9)."""

import json
import os

import pytest

from fakes.fake_bootloader import FakeBootloader
from mecon_connector.dfu_marker import MARKER_NAME, read_marker, write_marker
from mecon_connector.hold import past_erase
from test_dfu import DFU, PKG, app_returns, armed, frames, job, mk, reset_into_bootloader, states  # noqa: F401

UF2 = "needs-uf2-recovery"


def lines(r, event):
    return [o for o in (json.loads(x) for x in r.logbuf.getvalue().splitlines()) if o["event"] == event]


def sdir(r):
    return r.cfg.dfu.state_dir


def marker_file(r):
    return os.path.join(sdir(r), MARKER_NAME)


def run_cut(r, gone_after):
    """A DFU job whose bootloader port vanishes after `gone_after` processed packets (1 start, 2 init, then data)."""
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(factory=lambda: FakeBootloader(clock=r.clock, gone_after=gone_after))
    r.jump(0.6)
    return conn


SAME = "00" * 32  # the fake device's node key


def mk_marked(mk, tmp_path, app=False, boot=False, job_id="fw-1", device=SAME):
    sd = tmp_path / f"st{len(os.listdir(tmp_path))}"
    write_marker(str(sd), {"job": job_id, "sent": 689, "total": 1358, "at": 1763539200, "reason": "interrupted",
                           "device": device})
    r = mk(plugged=app, dfu={**DFU, "state_dir": str(sd)})
    if boot:
        r.boot.appear(FakeBootloader(clock=r.clock))
    return r


# ---- classification -------------------------------------------------------------------------------


def test_past_erase_means_at_least_one_data_packet_was_acknowledged():
    assert [past_erase(n) for n in (0, 1, 2, 689)] == [False, True, True, True]


def test_conf_29_a_cut_before_the_first_data_packet_leaves_no_marker_and_is_retried_serially(mk):
    r = mk()
    conn = run_cut(r, gone_after=2)
    r.wait(lambda: r.boot.opens >= 2)
    assert not os.path.exists(marker_file(r)) and r.bridge._uf2 is None
    assert lines(r, "dfu_needs_uf2") == []
    assert r.bridge._dfu_phase != UF2 and (UF2 not in [s[0] for s in states(conn)])


def test_conf_29_a_cut_after_the_first_data_packet_leaves_a_marker_and_is_never_retried(mk):
    r = mk()
    conn = run_cut(r, gone_after=6)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    # The frame reaches the fake Backend over its socket a moment after the phase changes: wait for it, not the phase.
    r.wait(lambda: bool(states(conn)) and states(conn)[-1][0] == UF2)
    for _ in range(30):
        r.jump(2)
    assert r.boot.opens == 1 and r.m("hold_dfu_transfer_attempts_total", "failed") == 1
    m = read_marker(sdir(r))
    assert m["job"] == "fw-1" and m["sent"] > 0 and m["total"] > m["sent"] and m["reason"] == "link-lost"
    assert isinstance(m["at"], int) and m["at"] > 0
    assert [s[0] for s in states(conn)][-1] == UF2
    assert "failed" not in [s[0] for s in states(conn)] and "rebooting" not in [s[0] for s in states(conn)]


# ---- the marker -----------------------------------------------------------------------------------


def test_the_marker_is_written_atomically_and_a_failed_write_keeps_the_old_one(tmp_path, monkeypatch):
    d = str(tmp_path / "state")
    write_marker(d, {"job": "a", "sent": 1, "total": 2, "at": 5, "reason": "x"})
    assert sorted(os.listdir(d)) == [MARKER_NAME]  # no temporary file left behind
    assert (os.stat(os.path.join(d, MARKER_NAME)).st_mode & 0o777) == 0o600
    real = os.replace

    def boom(a, b):
        raise OSError("rename failed")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        write_marker(d, {"job": "b", "sent": 9, "total": 9, "at": 6, "reason": "y"})
    monkeypatch.setattr(os, "replace", real)
    assert read_marker(d)["job"] == "a"  # the old marker is whole


def test_an_unreadable_marker_still_counts_as_a_marker(tmp_path):
    d = tmp_path
    (d / MARKER_NAME).write_text("{not json")
    m = read_marker(str(d))
    assert m["job"] == "unknown" and m["reason"] == "marker-unreadable"
    assert read_marker(str(tmp_path / "none")) is None


def test_conf_31_the_marker_survives_a_restart_and_the_new_process_reports_it(mk, tmp_path):
    r = mk()
    run_cut(r, gone_after=6)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    sd = sdir(r)
    saved = read_marker(sd)
    r.bridge.stop()
    r2 = mk(plugged=False, dfu={**DFU, "state_dir": sd})
    assert r2.bridge._dfu_phase == UF2 and r2.bridge._uf2 == saved
    conn = r2.up()
    r2.wait(lambda: any(f.get("state") == UF2 for f in frames(conn, "dfu_state")))
    assert conn.parsed()[0] == {"type": "iface_relay", "serial_dfu": True}
    (f,) = [f for f in frames(conn, "dfu_state") if f["state"] == UF2]
    assert f == {"type": "dfu_state", "job": "fw-1", "state": UF2, "sent": saved["sent"], "total": saved["total"]}
    assert len(lines(r2, "dfu_needs_uf2_found")) == 1


# ---- reporting while marked -----------------------------------------------------------------------


def test_conf_30_while_marked_the_connector_device_frame_and_the_health_snapshot_say_so_and_nothing_says_recovered(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True)
    conn = r.up()
    r.wait(lambda: frames(conn, "connector_device"))
    (st,) = frames(conn, "connector_device")
    assert st == {"type": "connector_device", "device": "bootloader", "dfu_state": UF2, "job": "fw-1",
                  "sent": 689, "total": 1358}
    snap = r.bridge.snapshot()
    assert snap["dfu"] == UF2 and snap["device"] == "bootloader"
    assert snap["dfu_needs_uf2"] == {"job": "fw-1", "sent": 689, "total": 1358, "reason": "interrupted"}
    for _ in range(20):
        r.jump(3)
    assert not {"rebooting", "installed-pending-hello", "ready"} & {s[0] for s in states(conn)}
    assert r.boot.opens == 0 and r.boot.calls == 0  # the bootloader port is listed, never opened
    assert len(frames(conn, "connector_device")) == 1  # said once per socket, not every tick


def test_conf_30_a_new_job_is_refused_naming_the_state_and_nothing_is_fetched_or_written(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True)
    conn = r.up()
    r.wait(lambda: frames(conn, "dfu_state"))
    job(conn, jid="fw-2")
    r.wait(lambda: r.m("hold_frames_ignored_total", "dfu_needs_uf2") == 1)
    r.wait(lambda: any(f["job"] == "fw-2" for f in frames(conn, "dfu_state")))
    (f,) = [f for f in frames(conn, "dfu_state") if f["job"] == "fw-2"]
    assert f == {"type": "dfu_state", "job": "fw-2", "state": UF2, "sent": 689, "total": 1358}
    assert r.server.package_requests == [] and r.boot.opens == 0
    (w,) = lines(r, "dfu_job_ignored")
    assert w["job"] == "fw-2" and w["why"] == UF2
    assert r.bridge._dfu_phase == UF2


def test_conf_30_a_job_for_the_same_device_is_refused_even_with_the_application_port_back_but_no_hello(mk, tmp_path):
    r = mk_marked(mk, tmp_path)
    conn = r.up()
    r.dev = r.opener.plug()  # answers no hello
    r.wait(lambda: r.bridge._link is not None)
    job(conn, jid="fw-2")
    r.wait(lambda: r.m("hold_frames_ignored_total", "dfu_needs_uf2") == 1)
    assert r.server.package_requests == [] and r.bridge._dfu_phase == UF2


# ---- bootloader-only at start ---------------------------------------------------------------------


def test_conf_31_no_application_port_and_a_bootloader_port_is_reported_at_start_without_a_marker(mk):
    r = mk(plugged=False)
    r.boot.appear(FakeBootloader(clock=r.clock))
    r.step(3)
    r.jump(3)
    assert r.bridge.snapshot()["device"] == "bootloader" and "dfu_needs_uf2" not in r.bridge.snapshot()
    (w,) = lines(r, "dfu_bootloader_present")
    assert w["needs_uf2"] is False
    assert r.boot.opens == 0 and r.boot.calls == 0


def test_conf_31_a_connector_device_frame_with_device_bootloader_goes_up_when_the_bootloader_is_there_and_a_socket_is_open(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True)
    conn = r.up()
    r.wait(lambda: frames(conn, "connector_device"))
    assert frames(conn, "connector_device")[0]["device"] == "bootloader"
    (w,) = lines(r, "dfu_bootloader_present")
    assert w["needs_uf2"] is True


def test_conf_31_with_no_bootloader_port_the_device_is_absent(mk, tmp_path):
    r = mk_marked(mk, tmp_path)
    conn = r.up()
    r.wait(lambda: frames(conn, "connector_device"))
    assert frames(conn, "connector_device")[0]["device"] == "absent"


# ---- clearing -------------------------------------------------------------------------------------


def test_conf_32_the_marker_clears_only_when_the_application_port_is_back_and_its_hello_arrived(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True)
    conn = r.up()
    r.wait(lambda: frames(conn, "connector_device"))
    path = marker_file(r)
    assert os.path.exists(path)
    r.dev = r.opener.plug()  # the port is back; the device answers no hello yet
    r.wait(lambda: r.bridge._link is not None)
    r.step(10)
    assert r.bridge._hello is None and os.path.exists(path) and r.bridge._dfu_phase == UF2
    assert lines(r, "dfu_needs_uf2_cleared") == []
    r.dev.answers_hello = True
    for _ in range(4):
        r.jump(16)  # the unanswered hello times out and is asked again
    r.wait(lambda: r.bridge._dfu_phase == "none")
    assert not os.path.exists(path) and r.bridge._uf2 is None
    (c,) = lines(r, "dfu_needs_uf2_cleared")
    assert (c["job"], c["sent"], c["total"]) == ("fw-1", 689, 1358)
    r.wait(lambda: len(frames(conn, "iface_hello")) >= 1)  # the Backend confirms the version from this hello
    r.wait(lambda: "dfu_state" not in frames(conn, "connector_device")[-1])
    last = frames(conn, "connector_device")[-1]
    assert last == {"type": "connector_device", "device": "application"}


def test_log_fields_of_the_set_line(mk):
    r = mk()
    run_cut(r, gone_after=6)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    (w,) = lines(r, "dfu_needs_uf2")
    assert w["level"] == "warn"
    m = read_marker(sdir(r))
    assert (w["job"], w["sent"], w["total"], w["reason"]) == ("fw-1", m["sent"], m["total"], "link-lost")
    assert not any(k in w for k in ("bytes", "wire", "hex"))


def test_a_shutdown_cut_after_data_began_records_the_marker_too(mk):
    from test_dfu_stop import CutBootloader, start_transfer, stop_while_blocked

    boot = CutBootloader(5)
    r, conn = start_transfer(mk, boot)
    stop_while_blocked(r, boot)
    m = read_marker(sdir(r))
    assert m["job"] == "fw-1" and m["reason"] == "interrupted" and m["sent"] == 3
    assert lines(r, "dfu_needs_uf2")[0]["sent"] == 3


def test_state_dir_is_a_dfu_key_with_a_default_and_must_be_absolute():
    from mecon_connector.config import ConfigError, parse

    base = {"device": {"mode": "companion", "select": {"by_id": "usb-A-*"}}, "transport": "hold",
            "hold": {"base_url": "https://h.example.invalid", "token_file": "/t"}}
    dfu = {"enabled": True, "bootloader": {"by_id": "usb-B-*"}}
    assert parse({**base, "dfu": dfu}).dfu.state_dir == "/var/lib/mecon-connector"
    assert parse({**base, "dfu": {**dfu, "state_dir": "/srv/x"}}).dfu.state_dir == "/srv/x"
    with pytest.raises(ConfigError):
        parse({**base, "dfu": {**dfu, "state_dir": "rel/dir"}})


# ---- the identity of the device ---------------------------------------------------------------------


def test_conf_32_the_marker_stores_the_identity_of_the_device_the_transfer_was_for(mk):
    r = mk()
    run_cut(r, gone_after=6)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    assert read_marker(sdir(r))["device"] == SAME  # node_key, not device_id (the fake's hello has both)


@pytest.mark.parametrize("hello", [
    {"v": 1, "device_id": "0123456789abcdef", "epoch": 1},  # no node_key
    {"v": 1, "node_public_key_hex": "00" * 32, "epoch": 1},  # a field the firmware's hello never carries
    {"v": 1, "node_key": 7, "epoch": 1},
])
def test_conf_32_a_hello_without_a_node_key_gives_the_marker_no_identity(mk, hello):
    r = mk()
    r.dev.hello_result = hello
    run_cut(r, gone_after=6)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    assert read_marker(sdir(r))["device"] is None


def back_with_hello(r, key):
    r.dev = r.opener.plug()
    r.dev.hello_result = {"v": 1, "name": "synthetic", "node_key": key, "epoch": 1}
    r.dev.answers_hello = True
    for _ in range(3):
        r.jump(16)
    r.step(20)


def test_conf_32_a_hello_from_another_device_keeps_the_marker_and_warns(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True)
    r.up()
    back_with_hello(r, "11" * 32)
    assert r.bridge._hello is not None and r.bridge._dfu_phase == UF2 and os.path.exists(marker_file(r))
    assert len(lines(r, "dfu_needs_uf2_other_device")) == 1 and lines(r, "dfu_needs_uf2_cleared") == []
    w = lines(r, "dfu_needs_uf2_other_device")[0]
    assert w["level"] == "warn"
    want = "if this board was recovered by UF2 and its node key changed, remove " + marker_file(r)
    assert w["hint"] == (want if len(want) <= 200 else want[:200] + "...")  # the log cuts a field at 200 characters
    assert w["hint"].startswith("if this board was recovered by UF2 and its node key changed, remove ")


def test_conf_32_a_marker_with_no_identity_clears_on_no_hello(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True, device=None)
    r.up()
    back_with_hello(r, SAME)
    assert r.bridge._dfu_phase == UF2 and os.path.exists(marker_file(r)) and lines(r, "dfu_needs_uf2_cleared") == []
    # only the operator removing the file ends it (a restart then starts clean)
    os.unlink(marker_file(r))
    r.bridge.stop()
    r2 = mk(plugged=False, dfu={**DFU, "state_dir": sdir(r)})
    assert r2.bridge._dfu_phase == "none"


def test_conf_32_an_unreadable_marker_has_no_identity(tmp_path):
    (tmp_path / MARKER_NAME).write_text("{not json")
    assert read_marker(str(tmp_path))["device"] is None


# ---- an unwritable state directory ------------------------------------------------------------------


def test_conf_33_an_unwritable_state_dir_declares_no_serial_dfu_and_refuses_jobs(mk, tmp_path):
    blocker = tmp_path / "afile"
    blocker.write_text("x")
    r = mk(dfu={**DFU, "state_dir": str(blocker / "state")})
    conn = r.up()
    assert conn.parsed()[0] == {"type": "iface_relay"}
    (w,) = lines(r, "dfu_state_dir_unwritable")
    assert w["level"] == "warn" and w["path"] == str(blocker / "state") and w["error"]
    job(conn)
    r.wait(lambda: r.m("hold_frames_ignored_total", "dfu_disabled") == 1)
    assert r.server.package_requests == [] and states(conn) == []
    reset_into_bootloader(r)
    r.wait(lambda: conn.closed.is_set())  # an ordinary link drop: no DFU keeps the socket
    assert r.boot.calls == 0


def test_a_writable_state_dir_leaves_no_probe_file_behind(mk):
    r = mk()
    r.up()
    assert not os.path.exists(sdir(r)) or os.listdir(sdir(r)) == []
    assert lines(r, "dfu_state_dir_unwritable") == []


# ---- nothing for the device while it is not on the application port ------------------------------------


def test_conf_30_while_the_device_is_not_on_the_application_port_no_device_frames_go_up(mk, tmp_path):
    r = mk_marked(mk, tmp_path, boot=True)
    conn = r.up()
    r.wait(lambda: frames(conn, "connector_device"))
    req_frame = json.dumps({"mecon_auth": 1, "sig": "<sig>", "body": json.dumps({"v": 1, "id": "q1", "op": "status.get"})})
    conn.send({"type": "iface_req", "id": "q1", "wire": req_frame})
    r.wait(lambda: r.m("downlink_received_total") >= 1)
    for _ in range(20):
        r.jump(3)
    types = [f["type"] for f in conn.parsed()]
    assert not {"iface_hello", "iface_result", "iface_event"} & set(types)
    assert types.count("iface_relay") == 1  # the declaration of the socket, as in every DFU state
    assert r.m("downlink_closed_total") >= 1  # the request was dropped, never written anywhere


# ---- the backstop: a retry after an erase-phase cut that never brings the application back -----------------


def cut_then_complete(r):
    """The first attempt is cut in the erase phase (nothing acknowledged), the retry completes."""
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    made = []

    def factory():
        made.append(1)
        return FakeBootloader(clock=r.clock, gone_after=2 if len(made) == 1 else None)

    r.boot.appear(factory=factory)
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    return conn


def test_conf_29_a_retry_after_an_erase_cut_that_completes_but_never_returns_needs_uf2(mk):
    r = mk()
    conn = cut_then_complete(r)
    assert not os.path.exists(marker_file(r))
    for _ in range(3):
        r.jump(60)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    m = read_marker(sdir(r))
    assert m["reason"] == "no-app-after-retry" and m["job"] == "fw-1" and m["sent"] == m["total"] > 0
    r.wait(lambda: states(conn)[-1][0] == UF2)
    assert "failed" not in [s[0] for s in states(conn)]
    assert len(lines(r, "dfu_needs_uf2")) == 1


def test_a_first_transfer_that_completes_and_never_returns_stays_a_plain_failure(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(FakeBootloader(clock=r.clock))
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    for _ in range(3):
        r.jump(60)
    r.wait(lambda: r.bridge._dfu_phase == "failed")
    r.wait(lambda: states(conn)[-1][0] == "failed")
    assert not os.path.exists(marker_file(r)) and states(conn)[-1] == ("failed", "app-return", "not-found")


def test_a_retry_after_an_erase_cut_that_returns_with_a_hello_is_installed(mk):
    r = mk()
    conn = cut_then_complete(r)
    app_returns(r)
    r.wait(lambda: r.bridge._dfu_phase == "none")
    assert not os.path.exists(marker_file(r)) and UF2 not in [s[0] for s in states(conn)]


def test_conf_29_a_retry_after_an_erase_cut_whose_port_returns_without_a_hello_needs_uf2(mk):
    r = mk()
    conn = cut_then_complete(r)
    r.dev = r.opener.plug()  # the application port appears and never answers a hello
    r.wait(lambda: r.bridge._dfu_phase == "resuming")
    for _ in range(4):
        r.jump(60)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    r.wait(lambda: states(conn)[-1][0] == UF2)
    assert read_marker(sdir(r))["reason"] == "no-app-after-retry"


def test_a_marker_path_that_cannot_be_read_still_counts_as_a_marker(tmp_path):
    (tmp_path / MARKER_NAME).mkdir()  # reading it is an OSError, not "no marker"
    assert read_marker(str(tmp_path))["reason"] == "marker-unreadable"


# ---- the identity belongs to the application link that said hello -----------------------------------------


KEY_B = "11" * 32


def test_conf_34_a_job_before_the_new_devices_hello_is_ignored_and_the_marker_never_holds_the_old_key(mk):
    r = mk()
    r.up()  # device A has said hello (node key SAME)
    assert r.bridge._last_identity == SAME
    r.opener.unplug()
    r.wait(lambda: r.bridge._link is None)
    assert r.bridge._last_identity == SAME  # kept across a link loss: the DFU reset needs it
    dev_b = r.opener.plug()  # device B, not yet answering hello
    dev_b.hello_result = {"v": 1, "name": "synthetic", "node_key": KEY_B, "device_id": "ffffffffffffffff", "epoch": 1}
    r.wait(lambda: r.bridge._link is not None)
    assert r.bridge._last_identity is None and r.bridge._hello is None
    # a job frame that reaches the bridge now (the old socket's last frame, in the step that opened B's link)
    r.bridge._on_dfu_job(r.clock(), {"type": "dfu_job", "job": "fw-1", "sha256": __import__("hashlib").sha256(PKG).hexdigest(),
                                     "size": len(PKG)})
    assert r.m("hold_frames_ignored_total", "dfu_no_hello") == 1
    assert r.bridge._dfu_phase == "none" and r.server.package_requests == []
    assert lines(r, "dfu_job_ignored")[0]["why"] == "no_hello"
    dev_b.answers_hello = True  # B's hello arrives; now a job arms
    for _ in range(4):
        r.jump(16)
    r.wait(lambda: r.bridge._hello is not None)
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(factory=lambda: FakeBootloader(clock=r.clock, gone_after=6))
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    assert read_marker(sdir(r))["device"] == KEY_B


def test_conf_34_the_normal_dfu_path_stores_the_pre_transfer_devices_key(mk):
    r = mk()
    run_cut(r, gone_after=6)  # the application port is lost before the transfer: the identity is kept
    r.wait(lambda: r.bridge._dfu_phase == UF2)
    assert read_marker(sdir(r))["device"] == SAME
