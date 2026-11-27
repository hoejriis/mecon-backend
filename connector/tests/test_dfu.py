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

    def make(dfu=DFU, runner=None, boot=None, **kw):
        sub = tmp_path / f"r{len(rigs)}"
        sub.mkdir()
        boot = boot or FakeBootOpener()
        if dfu is not None and "state_dir" not in dfu:
            dfu = {**dfu, "state_dir": str(sub / "state")}
        r = HoldRig(sub, dfu=dfu, bridge_kw={"boot_opener": boot, "runner": runner or (lambda fn: fn())}, **kw)
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
    """Sends a dfu_job and waits until the Connector says ready or failed."""
    before = r.m("hold_dfu_states_total", "ready") + r.m("hold_dfu_states_total", "failed")
    job(conn, **kw)
    r.wait(lambda: r.m("hold_dfu_states_total", "ready") + r.m("hold_dfu_states_total", "failed") > before)


class Deferred:
    """A runner that holds the fetch until the test lets it run."""

    def __init__(self):
        self.work = []

    def __call__(self, fn):
        self.work.append(fn)

    def run_all(self):
        while self.work:
            self.work.pop(0)()


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
    r.wait(lambda: states(conn) == [("fetching", None, None), ("ready", None, None)])
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
        ("dfu_state", "fetching"), ("dfu_state", "ready"), ("dfu_state", "waiting-bootloader"),
        ("dfu_state", "transferring"), ("dfu_state", "rebooting"), ("dfu_state", "installed-pending-hello"),
        ("iface_relay", None), ("iface_hello", None),
    ]
    assert after[6] == {"type": "iface_relay", "serial_dfu": True}
    assert all(f["job"] == "fw-1" for f in after[:6])
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
    assert r.boot.calls == 0 and states(conn) == [("fetching", None, None), ("ready", None, None)]


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
    assert r.bridge._dfu_phase == "none"  # never ready: the Backend does not offer, nothing stays armed
    r.boot.appear(FakeBootloader())
    reset_into_bootloader(r)  # a reset now is an ordinary link drop
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000
    for _ in range(10):
        r.jump(1)
    assert r.boot.calls == 0  # never touched


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
    armed(r, conn)
    reset_into_bootloader(r)
    for _ in range(31):
        r.jump(1)  # no bootloader port: failed
    assert r.bridge._dfu_phase == "failed"
    app_returns(r)  # recovered by hand
    r.wait(lambda: r.bridge._dfu_phase == "none" and len(frames(conn, "iface_hello")) == 2)
    assert [s[0] for s in states(conn)] == ["fetching", "ready", "waiting-bootloader", "failed"]
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


# ---- ready gates the offer and starts the window (20, 21) -----------------------------------------------


def test_conf_20_21_a_reset_before_ready_is_an_unarmed_link_drop(mk):
    d = Deferred()
    r = mk(runner=d)
    conn = r.up()
    job(conn)
    r.wait(lambda: d.work)  # fetching, not yet ready
    r.boot.appear(FakeBootloader())
    reset_into_bootloader(r)
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000 and r.bridge._dfu_phase == "none"
    d.run_all()  # the fetch finishes late: its result belongs to nothing
    for _ in range(10):
        r.jump(1)
    assert r.boot.calls == 0 and states(conn) == [("fetching", None, None)]


def test_conf_21_the_window_starts_at_ready_not_at_the_job(mk):
    d = Deferred()
    r = mk(runner=d)
    conn = r.up()
    job(conn)
    r.wait(lambda: d.work)
    r.jump(50)  # a slow fetch
    d.run_all()
    r.wait(lambda: states(conn)[-1:] == [("ready", None, None)])
    r.jump(50)  # 100 s after the job, 50 s after ready
    reset_into_bootloader(r)
    r.settle()
    assert not conn.closed.is_set() and r.bridge._dfu_phase == "waiting-bootloader"


# ---- a new socket hears the state again (25) ------------------------------------------------------------


def test_conf_25_a_new_socket_during_the_dfu_gets_iface_relay_then_the_current_state(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.wait(lambda: states(conn)[-1:] == [("waiting-bootloader", None, None)])
    conn.close(1011, "restart")
    r.wait(lambda: r.bridge._state == "idle")
    r.jump(1.1)
    r.wait(lambda: r.bridge._state == "connected")
    c2 = r.server.current()
    r.wait(lambda: len(c2.frames) >= 2)
    assert c2.parsed() == [{"type": "iface_relay", "serial_dfu": True},
                           {"type": "dfu_state", "job": "fw-1", "state": "waiting-bootloader"}]
    for _ in range(31):
        r.jump(1)
    r.wait(lambda: states(c2)[-1:] == [("failed", "bootloader", "not-found")])
    c2.close(1011, "restart")
    r.wait(lambda: r.bridge._state == "idle")
    r.jump(1.1)
    r.wait(lambda: r.bridge._state == "connected")
    c3 = r.server.current()
    r.wait(lambda: len(c3.frames) >= 2)
    assert c3.parsed() == [{"type": "iface_relay", "serial_dfu": True},
                           {"type": "dfu_state", "job": "fw-1", "state": "failed", "stage": "bootloader",
                            "error": "not-found"}]
    r.settle()
    assert len(c3.frames) == 2  # once


def test_conf_25_27_a_socket_kept_by_the_dfu_is_the_agents_own_and_a_refusal_after_its_drop_is_retried(mk):
    r = mk()
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.wait(lambda: states(conn)[-1:] == [("waiting-bootloader", None, None)])
    r.server.refuse_next = 1  # the Backend still sees the kept socket
    conn.drop()
    r.wait(lambda: r.bridge._state == "idle")
    r.jump(1.1)
    r.wait(lambda: r.m("hold_refused_retries_total") == 1)
    assert r.bridge.hold_stop is None and r.bridge._dfu_phase == "waiting-bootloader"
    r.jump(1.1)
    r.wait(lambda: r.bridge._state == "connected")
    c2 = r.server.current()
    r.wait(lambda: len(c2.frames) >= 2)
    assert c2.parsed() == [{"type": "iface_relay", "serial_dfu": True},
                           {"type": "dfu_state", "job": "fw-1", "state": "waiting-bootloader"}]
    assert r.bridge._dfu_phase == "waiting-bootloader" and r.server.refusals == 1


# ---- the failed cap (26) --------------------------------------------------------------------------------


def test_conf_26_a_failed_job_releases_the_hold_after_its_cap(mk):
    r = mk(dfu={**DFU, "failed_hold_s": 60})
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    for _ in range(31):
        r.jump(1)
    assert r.bridge._dfu_phase == "failed"
    for _ in range(50):
        r.jump(1)
    assert not conn.closed.is_set()  # still within the cap
    for _ in range(15):
        r.jump(1)
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000 and r.bridge._dfu_phase == "none"
    n = r.server.handshakes
    for _ in range(20):
        r.jump(1)
    assert r.server.handshakes == n  # no device link, no job: no new socket


def test_dfu_job_with_no_device_link_is_counted_as_no_device(mk):
    r = mk()
    r.up()
    r.bridge._link = None  # the link is already gone when the frame is handled
    r.bridge._on_frame(r.clock(), json.dumps({"type": "dfu_job", "job": "fw-1", "sha256": sha(PKG), "size": len(PKG)}))
    assert r.m("hold_frames_ignored_total", "dfu_no_device") == 1
    assert r.m("hold_frames_ignored_total", "dfu_busy") == 0 and r.bridge._dfu_phase == "none"


# ---- overlapping selectors (refused at run time) --------------------------------------------------------


def _ports_rig(mk, ports, devices):
    """A rig whose application and bootloader openers are the real PortOpener over a listed set of ports."""
    from mecon_connector.config import Selector
    from mecon_connector.serial_link import PortOpener

    created = []

    def factory(device, baud):
        created.append(device)
        return devices[device]

    app = PortOpener(Selector(by_id="usb-TEST_synthetic-*"), 115200, lister=lambda: list(ports), link_factory=factory)
    boot = PortOpener(Selector(by_id="usb-TEST_synthetic-boot*"), 115200, lister=lambda: list(ports), link_factory=factory)
    r = mk(dfu={**DFU, "bootloader": {"by_id": "usb-TEST_synthetic-boot*"}}, opener=app, boot=boot)
    r.created = created
    return r


def test_a_bootloader_port_the_device_selector_also_takes_is_refused_and_never_written(mk):
    from fakes.fake_serial import FakeSerialDevice
    from mecon_connector.serial_link import PortInfo

    dev = FakeSerialDevice()
    dev.answers_hello = True
    app_port = PortInfo("/dev/ttyACM0", by_id_names=("usb-TEST_synthetic-app-if00",))
    boot_port = PortInfo("/dev/ttyACM1", by_id_names=("usb-TEST_synthetic-boot-if00",))  # matches both selectors
    boot = FakeBootloader()
    ports = [app_port]
    r = _ports_rig(mk, ports, {"/dev/ttyACM0": dev, "/dev/ttyACM1": boot})
    conn = r.up()
    armed(r, conn)
    dev.unplug()
    ports[:] = [boot_port]
    r.wait(lambda: r.bridge._link is None)
    r.jump(0.6)
    r.wait(lambda: states(conn)[-1:] == [("failed", "bootloader", "selector-overlap")])
    assert "/dev/ttyACM1" not in r.created and boot.frames == 0


def test_an_application_port_the_bootloader_selector_also_takes_is_refused_while_a_dfu_waits(mk):
    from fakes.fake_serial import FakeSerialDevice
    from mecon_connector.serial_link import PortInfo

    dev = FakeSerialDevice()
    dev.answers_hello = True
    app_port = PortInfo("/dev/ttyACM0", by_id_names=("usb-TEST_synthetic-app-if00",))
    both = PortInfo("/dev/ttyACM1", by_id_names=("usb-TEST_synthetic-boot-if00",))  # matches both selectors
    boot = FakeBootloader()
    ports = [app_port]
    r = _ports_rig(mk, ports, {"/dev/ttyACM0": dev, "/dev/ttyACM1": boot})
    conn = r.up()
    armed(r, conn)
    dev.unplug()
    ports[:] = []
    r.wait(lambda: r.bridge._link is None)
    for _ in range(31):
        r.jump(1)
    r.wait(lambda: states(conn)[-1:] == [("failed", "bootloader", "not-found")])
    ports[:] = [both]  # now a port appears that both selectors take
    for _ in range(5):
        r.jump(1)
    assert "/dev/ttyACM1" not in r.created and boot.frames == 0 and r.bridge._link is None
    assert "dfu_selector_overlap" in r.logbuf.getvalue()


def test_failed_hold_s_default_and_range():
    from mecon_connector.config import ConfigError, parse

    base = {"device": {"mode": "companion", "select": {"by_id": "usb-A-*"}}, "transport": "hold",
            "hold": {"base_url": "https://h.example.invalid", "token_file": "/t"}}
    dfu = {"enabled": True, "bootloader": {"by_id": "usb-B-*"}}
    assert parse({**base, "dfu": dfu}).dfu.failed_hold_s == 1800
    assert parse({**base, "dfu": {**dfu, "failed_hold_s": 60}}).dfu.failed_hold_s == 60
    for bad in (59, 86401):
        with pytest.raises(ConfigError):
            parse({**base, "dfu": {**dfu, "failed_hold_s": bad}})
