"""A stop (the process is shutting down) during a bootloader transfer, through the real HoldBridge.

The transfer runs on a real thread here, against a fake bootloader whose port blocks inside a chosen frame, so
the test decides exactly where the shutdown lands. Time is the fake clock; the only real waits are the bounds
under test."""

import json
import threading
import time

import pytest

from fakes.fake_bootloader import FakeBootloader
from test_dfu import DFU, app_returns, armed, mk, reset_into_bootloader, states  # noqa: F401
from test_nordic_dfu import IMAGE, make_zip

N_DATA = 11  # data packets of IMAGE


class CutBootloader(FakeBootloader):
    """After the `cut_at`-th frame has been taken whole, the write blocks until released (or `hold_s` passes)."""

    def __init__(self, cut_at, hold_s=5.0, **kw):
        super().__init__(**kw)
        self.cut_at = cut_at
        self.hold_s = hold_s
        self.reached = threading.Event()
        self.release = threading.Event()

    def write(self, data):
        super().write(data)
        if self.frames == self.cut_at:
            self.reached.set()
            self.release.wait(self.hold_s)


def thread_runner(fn):
    t = threading.Thread(target=fn, daemon=True)
    t.start()
    return t


def lines(r, event):
    out = []
    for ln in r.logbuf.getvalue().splitlines():
        o = json.loads(ln)
        if o["event"] == event:
            out.append(o)
    return out


def start_transfer(mk, boot, **kw):
    r = mk(runner=thread_runner, **kw)
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(boot)
    r.jump(0.6)
    assert boot.reached.wait(5), "the transfer did not reach the cut"
    return r, conn


def stop_while_blocked(r, boot, release_after_set=True):
    """Calls bridge.stop() on its own thread, lets the blocked frame go once the stop signal is set, and returns."""
    t = threading.Thread(target=r.bridge.stop, daemon=True)
    t.start()
    end = time.monotonic() + 5
    while not r.bridge._dfu_halt.is_set() and time.monotonic() < end:
        time.sleep(0.001)
    if release_after_set:
        boot.release.set()
    t.join(8)
    assert not t.is_alive()


@pytest.mark.parametrize("cut_at, sent", [(1, 0), (2, 0), (5, 3), (2 + N_DATA, N_DATA)])
def test_shutdown_mid_transfer_ends_on_a_whole_frame_closes_the_port_and_sends_no_stop_packet(mk, cut_at, sent):
    boot = CutBootloader(cut_at)
    r, conn = start_transfer(mk, boot)
    stop_while_blocked(r, boot)
    # every frame the port saw is whole: nothing is left in the receive buffer, nothing was malformed
    assert boot.frames == cut_at and boot.errors == [] and not boot._rx
    assert all(f[0] == 0xC0 and f[-1] == 0xC0 for f in boot.raw_frames)
    # the writer closed the port itself, before stop() returned
    assert boot.closed
    # no stop packet: the package was not completed, and it is not reported as installed
    assert not boot.stopped and "stop" not in boot.order
    assert r.m("hold_dfu_transfer_attempts_total", "ok") == 0
    assert r.bridge._dfu_phase == "transferring"  # never moved on to rebooting
    assert ("rebooting", None, None) not in states(conn)
    # where it stopped
    (rec,) = lines(r, "dfu_interrupted")
    assert (rec["job"], rec["sent"], rec["total"]) == ("fw-1", sent, N_DATA)


def test_a_writer_that_hangs_does_not_hold_the_exit_beyond_the_bound(mk):
    boot = CutBootloader(5, hold_s=4.0)  # the write does not return for 4 s
    r, conn = start_transfer(mk, boot, dfu={**DFU, "stop_wait_s": 0.5})
    t0 = time.monotonic()
    stop_while_blocked(r, boot, release_after_set=False)
    took = time.monotonic() - t0
    assert 0.4 <= took < 2.0, took
    assert not boot.closed  # still stuck inside its write
    assert lines(r, "dfu_writer_not_stopped")
    boot.release.set()  # let the thread end


def test_stop_wait_is_a_dfu_key_with_a_default_and_a_range():
    from mecon_connector.config import ConfigError, parse

    base = {"device": {"mode": "companion", "select": {"by_id": "usb-A-*"}}, "transport": "hold",
            "hold": {"base_url": "https://h.example.invalid", "token_file": "/t"}}
    dfu = {"enabled": True, "bootloader": {"by_id": "usb-B-*"}}
    assert parse({**base, "dfu": dfu}).dfu.stop_wait_s == 5.0
    assert parse({**base, "dfu": {**dfu, "stop_wait_s": 0.5}}).dfu.stop_wait_s == 0.5
    for bad in (0.4, 31):
        with pytest.raises(ConfigError):
            parse({**base, "dfu": {**dfu, "stop_wait_s": bad}})


@pytest.mark.parametrize("n_data, expect", [(200, [64, 128, 192, 200]), (128, [64, 128]), (3, [3])])
def test_dfu_progress_every_64_data_packets_and_at_the_end(mk, n_data, expect):
    pkg = make_zip(bytes(512 * n_data), b"\x12\x34")
    r = mk()
    r.server.packages["fw-1"] = pkg
    conn = r.up()
    armed(r, conn, data=pkg)
    reset_into_bootloader(r)
    boot = FakeBootloader(clock=r.clock)
    r.boot.appear(boot)
    r.jump(0.6)
    r.wait(lambda: r.bridge._dfu_phase == "rebooting")
    assert boot.complete
    got = lines(r, "dfu_progress")
    assert [g["sent"] for g in got] == expect
    assert all(g["job"] == "fw-1" and g["total"] == n_data for g in got)
    assert not any("bytes" in g or "wire" in g for g in got)
    assert lines(r, "dfu_interrupted") == []


def test_with_the_real_sleep_a_stop_during_the_erase_wait_ends_it_at_once(mk, monkeypatch):
    """The bridge's default sleep is time.sleep; the transfer then waits on the stop signal instead, so a stop
    during the erase wait ends it at once: only the start packet is written and the writer closes the port well
    inside stop_wait_s (with a plain time.sleep it would sit out the 30 s erase and be left behind)."""
    import mecon_connector.nordic_dfu as nd

    monkeypatch.setattr(nd, "erase_wait_s", lambda size: 30.0)
    boot = CutBootloader(cut_at=-1)  # never blocks inside a frame
    r = mk(runner=thread_runner)
    r.bridge._sleep = time.sleep  # the default, as in production
    conn = r.up()
    armed(r, conn)
    reset_into_bootloader(r)
    r.boot.appear(boot)
    r.jump(0.6)
    end = time.monotonic() + 5
    while boot.frames < 1 and time.monotonic() < end:
        time.sleep(0.005)
    assert boot.frames == 1, "the start packet was not written"
    t0 = time.monotonic()
    r.bridge.stop()
    took = time.monotonic() - t0
    assert took < 2.0, f"stop() took {took:.2f} s: the erase wait did not end on the stop signal"
    assert boot.frames == 1  # nothing after the start packet: no init, data or stop packet
    assert boot.closed
    assert lines(r, "dfu_writer_not_stopped") == []
    assert len(lines(r, "dfu_interrupted")) == 1
