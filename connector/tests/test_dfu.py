"""Bootloader serial DFU over the hold (contracts/connector-hold/v1, section 12), end to end through the real
HoldBridge: a fake Backend endpoint (real WebSocket and the package route over HTTP on loopback), the fake
application device, and a fake bootloader on its own port. Fetches and transfers run inline (no thread) and
the transfer's waits move the fake clock. Names test_conf_NN follow the conformance checklist."""

import hashlib
import json

import pytest

from fakes.fake_bootloader import FakeBootloader, FakeBootOpener
from fakes.fake_hold_server import TOKEN
from hold_rig import HoldRig
from test_nordic_dfu import IMAGE, INIT, make_zip

DFU = {"enabled": True, "bootloader": {"by_id": "usb-TEST_bootloader-*"}}
PKG = make_zip(IMAGE, INIT)


def sha(b):
    return hashlib.sha256(b).hexdigest()


@pytest.fixture
def mk(tmp_path):
    rigs = []

    def make(dfu=DFU, **kw):
        sub = tmp_path / f"r{len(rigs)}"
        sub.mkdir()
        boot = FakeBootOpener()
        r = HoldRig(sub, dfu=dfu, bridge_kw={"boot_opener": boot, "runner": lambda fn: fn()}, **kw)
        r.bridge._sleep = r.clock.advance  # the transfer's waits pass in fake time
        r.boot = boot
        r.server.packages["fw-1"] = PKG
        rigs.append(r)
        return r

    yield make
    for r in rigs:
        r.close()


def frames(conn, typ):
    return [f for f in conn.parsed() if f.get("type") == typ]


def states(conn):
    return [(f["state"], f.get("stage"), f.get("error")) for f in frames(conn, "dfu_state")]


def job(conn, jid="fw-1", data=PKG, size=None, digest=None):
    conn.send({"type": "dfu_job", "job": jid, "sha256": digest or sha(data), "size": len(data) if size is None else size})


def armed(r, conn, **kw):
    job(conn, **kw)
    r.wait(lambda: r.bridge._dfu_fetch_state in ("ok", "failed"))


def reset_into_bootloader(r):
    """The device answered the offer and reset: its application port is gone."""
    r.opener.unplug()
    r.wait(lambda: r.bridge._link is None)


def app_returns(r):
    r.dev = r.opener.plug()
    r.dev.answers_hello = True


def req(conn, rid):
    body = json.dumps({"v": 1, "id": rid, "op": "status.get"}, separators=(",", ":"))
    conn.send({"type": "iface_req", "id": rid, "wire": json.dumps({"mecon_auth": 1, "sig": "<sig>", "body": body})})


# ---- the declaration (19) -------------------------------------------------------------------------


def test_conf_19_serial_dfu_is_declared_only_when_configured(mk):
    r = mk()
    conn = r.up()
    assert conn.parsed()[0] == {"type": "iface_relay", "serial_dfu": True}
    plain = mk(dfu=None)
    c2 = plain.up()
    assert c2.parsed()[0] == {"type": "iface_relay"}


def test_conf_19_dfu_disabled_ignores_dfu_job_and_never_touches_a_bootloader(mk):
    r = mk(dfu={"enabled": False, "bootloader": {"by_id": "usb-TEST_bootloader-*"}})
    conn = r.up()
    assert conn.parsed()[0] == {"type": "iface_relay"}
    job(conn)
    r.wait(lambda: r.m("hold_frames_ignored_total", "dfu_disabled") == 1)
    reset_into_bootloader(r)
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000
    for _ in range(5):
        r.jump(1)
    assert r.server.package_requests == [] and r.boot.calls == 0 and states(conn) == []


# ---- the happy path (20, 21, 23) ------------------------------------------------------------------


def test_conf_20_21_23_job_package_reset_bootloader_transfer_and_resume_on_the_same_socket(mk):
    r = mk()
    conn = r.up()
    before = len(conn.frames)
    armed(r, conn)
    path, headers = r.server.package_requests[-1]
    assert path == "/gateway/dfu-package/fw-1" and headers["authorization"] == f"Bearer {TOKEN}"
    r.wait(lambda: states(conn) == [("fetching", None, None)])
    reset_into_bootloader(r)
    assert not conn.closed.is_set() and r.bridge.snapshot()["dfu"] == "waiting-bootloader"
    boot = FakeBootloader(clock=r.clock)
    r.boot.appear(boot)
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    assert boot.complete, boot.errors
    assert bytes(boot.image) == IMAGE and boot.init == INIT and boot.start == (4, 0, 0, len(IMAGE))
    assert boot.closed and r.boot.opens == 1
    assert r.bridge._dfu_pkg is None  # held only for the transfer
    app_returns(r)
    r.wait(lambda: r.bridge._dfu_phase == "none" and len(frames(conn, "iface_hello")) == 2)
    after = [f for f in conn.parsed()[before:]]
    assert [(f["type"], f.get("state")) for f in after] == [
        ("dfu_state", "fetching"), ("dfu_state", "waiting-bootloader"), ("dfu_state", "transferring"),
        ("dfu_state", "rebooting"), ("dfu_state", "installed-pending-hello"), ("iface_relay", None),
        ("iface_hello", None),
    ]
    assert after[5] == {"type": "iface_relay", "serial_dfu": True}
    assert all(f["job"] == "fw-1" for f in after[:5])
    assert not conn.closed.is_set() and r.server.handshakes == 1
    assert r.m("hold_dfu_transfer_attempts_total", "ok") == 1 and r.m("hold_dfu_active") == 0
    # relaying is back
    r.dev.reply_hook = lambda m: json.dumps({"v": 1, "id": "q1", "status": "ok", "usig": "U1lOVEhFVElD"}).encode()
    req(conn, "q1")
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    assert TOKEN not in r.logbuf.getvalue()


# ---- arming (21) ----------------------------------------------------------------------------------


def test_conf_21_unarmed_link_drop_closes_the_socket_and_never_opens_the_bootloader(mk):
    r = mk()
    conn = r.up()
    r.boot.appear(FakeBootloader())
    reset_into_bootloader(r)
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000
    for _ in range(40):
        r.jump(1)
    assert r.boot.calls == 0 and states(conn) == []


def test_conf_21_arm_window_expiry_disarms_and_a_later_drop_closes_the_socket(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    r.jump(61)
    assert r.bridge._dfu_phase == "none" and r.bridge._dfu_pkg is None
    r.boot.appear(FakeBootloader())
    reset_into_bootloader(r)
    r.wait(lambda: conn.closed.is_set())
    for _ in range(5):
        r.jump(1)
    assert r.boot.calls == 0 and states(conn) == [("fetching", None, None)]


def test_conf_21_a_drop_inside_the_window_but_late_still_keeps_the_socket(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    r.jump(59)
    reset_into_bootloader(r)
    r.settle()
    assert not conn.closed.is_set() and r.bridge._dfu_phase == "waiting-bootloader"


def test_the_arming_ends_with_its_socket(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    conn.close(1011, "restart")
    r.wait(lambda: r.bridge._state == "idle")
    assert r.bridge._dfu_phase == "none"


# ---- package checks (20) --------------------------------------------------------------------------


@pytest.mark.parametrize("kw,stage,error", [
    ({"digest": "0" * 64}, "verify", "sha256-mismatch"),
    ({"size": len(PKG) + 1}, "verify", "size-mismatch"),
    ({"jid": "fw-unknown"}, "fetch", "http-404"),
])
def test_conf_20_a_package_that_does_not_match_aborts_before_the_device_is_touched(mk, kw, stage, error):
    r = mk()
    conn = r.up()
    armed(r, conn, **kw)
    r.wait(lambda: len(states(conn)) == 2)
    assert states(conn) == [("fetching", None, None), ("failed", stage, error)]
    r.boot.appear(FakeBootloader())
    reset_into_bootloader(r)  # the device had already been offered the update and reset
    for _ in range(40):
        r.jump(1)
    assert r.boot.calls == 0  # never touched
    assert not conn.closed.is_set() and r.bridge._dfu_phase == "failed"  # kept, waiting, nothing relayed
    assert len(frames(conn, "iface_relay")) == 1


def test_conf_20_an_oversize_package_is_refused_without_a_request(mk):
    r = mk(dfu={**DFU, "package_max_bytes": 65536})
    conn = r.up()
    job(conn, data=b"x", size=70000, digest="a" * 64)
    r.wait(lambda: len(states(conn)) == 2)
    assert states(conn)[1] == ("failed", "verify", "too-large")
    assert r.server.package_requests == []


@pytest.mark.parametrize("frame", [
    {"job": "fw-1", "sha256": "A" * 64, "size": 10},
    {"job": "fw-1", "sha256": "a" * 63, "size": 10},
    {"job": "fw-1", "sha256": "a" * 64, "size": 0},
    {"job": "fw-1", "sha256": "a" * 64, "size": True},
    {"job": "../x", "sha256": "a" * 64, "size": 10},
    {"job": "a/b", "sha256": "a" * 64, "size": 10},
    {"sha256": "a" * 64, "size": 10},
])
def test_a_malformed_dfu_job_is_ignored(mk, frame):
    r = mk()
    conn = r.up()
    conn.send({"type": "dfu_job", **frame})
    r.wait(lambda: r.m("hold_frames_ignored_total", "malformed_dfu_job") == 1)
    assert r.bridge._dfu_phase == "none" and r.server.package_requests == []


# ---- while the DFU runs (22) ----------------------------------------------------------------------


def test_conf_22_no_request_is_written_while_the_dfu_runs(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    closed = r.m("downlink_closed_total")
    req(conn, "q1")
    req(conn, "q2")
    r.wait(lambda: r.m("downlink_closed_total") == closed + 2)
    boot = FakeBootloader()
    r.boot.appear(boot)
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    assert boot.complete and boot.errors == []  # every frame on the bootloader port was a DFU packet
    assert r.m("downlink_written_total") == 0


def test_conf_22_a_job_for_another_id_while_one_runs_is_ignored(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.server.packages["fw-2"] = PKG
    job(conn, jid="fw-2")
    r.wait(lambda: r.m("hold_frames_ignored_total", "dfu_busy") == 1)
    assert r.bridge._dfu_job["job"] == "fw-1" and len(r.server.package_requests) == 1


# ---- failure (24) ---------------------------------------------------------------------------------


def test_conf_24_bootloader_never_appearing_is_failed_and_the_socket_waits(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    for _ in range(31):
        r.jump(1)
    r.wait(lambda: states(conn)[-1] == ("failed", "bootloader", "not-found"))
    assert not conn.closed.is_set() and r.bridge.snapshot()["dfu"] == "failed"
    calls = r.boot.calls
    for _ in range(10):
        r.jump(1)
    assert r.boot.calls == calls  # no more looking once failed


def test_conf_24_a_lost_ack_is_resent_within_one_attempt(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    boot = FakeBootloader(drop_acks={1, 4, 9})
    r.boot.appear(boot)
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    assert boot.complete and boot.duplicates == 3
    assert r.m("hold_dfu_transfer_attempts_total", "ok") == 1 and r.m("hold_dfu_transfer_attempts_total", "failed") == 0


def test_conf_24_three_failed_attempts_then_failed_kept_socket_and_a_new_job_runs_again(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(factory=lambda: FakeBootloader(dead=True))
    for _ in range(20):
        r.jump(1)
    assert r.m("hold_dfu_transfer_attempts_total", "failed") == 3 and r.boot.opens == 3
    r.wait(lambda: states(conn)[-1] == ("failed", "transfer", "no-ack"))
    assert [s[0] for s in states(conn)].count("transferring") == 3
    assert not conn.closed.is_set() and len(frames(conn, "iface_relay")) == 1
    for _ in range(10):
        r.jump(1)
    assert r.boot.opens == 3
    # the Backend sends the job again: fetched, checked and sent to the bootloader that is still waiting
    good = FakeBootloader()
    r.boot.appear(good)
    job(conn)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    assert good.complete
    app_returns(r)
    r.wait(lambda: r.bridge._dfu_phase == "none" and len(frames(conn, "iface_hello")) == 2)
    assert states(conn)[-1] == ("installed-pending-hello", None, None)


def test_conf_24_the_app_port_returning_after_a_failure_resumes_without_installed(mk):
    r = mk()
    conn = r.up()
    armed(r, conn, digest="1" * 64)  # a bad package: failed before the reset
    reset_into_bootloader(r)
    r.settle()
    assert r.bridge._dfu_phase == "failed"
    app_returns(r)  # recovered by hand
    r.wait(lambda: r.bridge._dfu_phase == "none" and len(frames(conn, "iface_hello")) == 2)
    assert [s[0] for s in states(conn)] == ["fetching", "failed"]
    assert conn.parsed()[-2] == {"type": "iface_relay", "serial_dfu": True}


def test_an_app_port_that_never_returns_is_failed_app_return(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(FakeBootloader())
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    for _ in range(121):
        r.jump(1)
    r.wait(lambda: states(conn)[-1] == ("failed", "app-return", "not-found"))
    assert not conn.closed.is_set()
    app_returns(r)
    r.wait(lambda: r.bridge._dfu_phase == "none" and len(frames(conn, "iface_hello")) == 2)


def test_a_device_that_is_not_enrolled_after_the_update_releases_the_hold(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(FakeBootloader())
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    r.opener.enrolment = "none"
    app_returns(r)
    r.wait(lambda: conn.closed.is_set())
    assert r.bridge._dfu_phase == "none" and len(frames(conn, "iface_relay")) == 1


def test_dfu_config_needs_hold_and_a_bootloader_selector_that_is_not_the_device(tmp_path):
    from mecon_connector.config import ConfigError, parse

    base = {"device": {"mode": "companion", "select": {"by_id": "usb-A-*"}}}
    hold = {"transport": "hold", "hold": {"base_url": "https://h.example.invalid", "token_file": "/t"}}
    with pytest.raises(ConfigError) as e:
        parse({**base, **hold, "dfu": {"enabled": True}})
    assert "dfu.bootloader" in str(e.value)
    with pytest.raises(ConfigError) as e:
        parse({**base, **hold, "dfu": {"enabled": True, "bootloader": {"by_id": "usb-A-*"}}})
    assert "not the same port" in str(e.value)
    with pytest.raises(ConfigError) as e:
        parse({**base, **hold, "dfu": {"enabled": True, "bootloader": {"path": "/dev/ttyACM1"}}})
    assert "dfu.bootloader.path" in str(e.value)
    with pytest.raises(ConfigError):
        parse({**base, "mqtt": {}, "dfu": {"enabled": True, "bootloader": {"vid": 1, "pid": 2}}})
    with pytest.raises(ConfigError):
        parse({**base, **hold, "dfu": {"enabled": True, "bootloader": {"vid": 1}}})
    c = parse({**base, **hold, "dfu": {"enabled": True, "bootloader": {"vid": 0x2886, "pid": 0x57}}})
    assert c.dfu.bootloader.vid == 0x2886 and c.dfu.arm_window_s == 60 and c.dfu.attempts == 3
    assert c.dfu.bootloader_wait_s == 30 and c.dfu.app_return_wait_s == 120 and c.dfu.package_max_bytes == 2 * 1024 * 1024
    assert parse({**base, **hold, "dfu": {"enabled": False}}).dfu is None
