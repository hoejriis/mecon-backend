"""Replays the hold contract's fixtures (contracts/connector-hold/v1/fixtures) through the real HoldBridge,
a fake Backend endpoint and the fake serial device, and checks the agent does exactly what each scenario says.
Also: the generator reproduces the files, and the README's checklist matches the tests that cover it."""

import json
import pathlib
import re
import subprocess
import sys

import pytest

from fakes.fake_hold_server import TOKEN, FakeHoldServer
from hold_rig import HoldRig

V1 = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "connector-hold" / "v1"
NAMES = sorted(p.name for p in (V1 / "fixtures").glob("[A-E]-*.json"))


@pytest.fixture
def mk(tmp_path):
    rigs = []

    def make(**kw):
        sub = tmp_path / f"r{len(rigs)}"
        sub.mkdir()
        r = HoldRig(sub, **kw)
        rigs.append(r)
        return r

    yield make
    for r in rigs:
        r.close()


def test_there_are_five_scenarios():
    assert [n[0] for n in NAMES] == list("ABCDE")


@pytest.mark.parametrize("name", NAMES)
def test_scenario_replays(mk, name):
    doc = json.loads((V1 / "fixtures" / name).read_text())
    steps = doc["steps"]
    link = "console" if doc["link"] == "console" else "companion"
    hs = next((s for s in steps if s["step"] == "handshake"), None)
    kw = {"mode": link, "presentation": hs["presentation"] if hs else "header"}
    server = None
    if doc["id"] == "B":
        server = FakeHoldServer()
        refused = next(s["frame"] for s in steps if s["step"] == "recv")
        server.on_connect = lambda c: (c.send(refused), c.close(1008, ""))
        kw["server"] = server
    r = mk(**kw)

    if doc["id"] == "B":
        r.wait(lambda: r.bridge.hold_stop is not None)
        assert r.bridge.hold_stop[0] == "refused"
        close = next(s for s in steps if s["step"] == "close")
        assert close["code"] == 1008
        n = server.handshakes
        r.jump(120)
        assert server.handshakes == n  # no auto-reconnect
        server.shutdown()
        return

    hello = next((x["frame"]["hello"] for x in steps if x["step"] == "send" and x["frame"]["type"] == "iface_hello"), None)
    if hello is not None:
        r.dev.hello_result = hello  # the device's own hello result object, as the scenario shows it
    conn = r.up()
    if hs is not None:
        assert conn.offered == ([] if hs["presentation"] == "header" else [o.replace("<token>", TOKEN) for o in hs["offered"]])
        assert conn.selected == hs["selected"]
        if hs["presentation"] == "header":
            assert conn.headers["authorization"].startswith("Bearer ")
    seen = 0 if steps and any(s["step"] == "send" and s["frame"]["type"] == "iface_relay" for s in steps) else len(conn.frames)
    writes = 0
    for i, s in enumerate(steps):
        k = s["step"]
        if k == "handshake" or k == "close":
            continue
        if k == "send":
            r.wait(lambda: len(conn.frames) > seen)
            assert json.loads(conn.frames[seen]) == s["frame"], f"step {i + 1}"
            seen += 1
        elif k == "recv":
            conn.send(s["frame"])
            r.settle(15)
        elif k == "device_write":
            if "hex" in s:
                assert r.dev.cr_writes == 1
                continue
            if link == "console":
                r.wait(lambda: len(r.dev.written) > writes)
                assert r.dev.written[writes] == b"mecon> " + s["wire"].encode() + b"\r"
            else:
                r.wait(lambda: len(r.dev.written) > writes)
                assert r.dev.messages[writes] == s["wire"].encode()
                if "frames_hex" in s:
                    raw = r.dev.written[writes]
                    got, j = [], 0
                    while j < len(raw):
                        n = raw[j + 1] | (raw[j + 2] << 8)
                        got.append(raw[j + 3 : j + 3 + n])
                        j += 3 + n
                    assert len({f[1] for f in got}) == 1  # one xid for the whole message
                    assert [(bytes([f[0], s["xid"]]) + f[2:]).hex() for f in got] == s["frames_hex"]
            writes += 1
        elif k == "device_read":
            r.dev.say(s["text"].encode())
            if s.get("not_sent"):
                r.settle(60)
                assert len(conn.frames) == seen  # dropped by the agent, never uploaded
        elif k == "device_line":
            r.dev.feed((s["text"] + "\r\n").encode())
    r.settle(60)
    assert len(conn.frames) == seen, "the agent sent a frame the scenario does not show"
    assert r.bridge._state == "connected"  # unknown frames and refusals of uploads close nothing


def test_scenario_f_serial_dfu_replays(tmp_path):
    """Fixture F through the real bridge: the package from the fixture served on the package route, the exact
    bytes written to a fake bootloader, the dfu_state order and the resume on the same socket."""
    import base64

    from fakes.fake_bootloader import FakeBootloader, FakeBootOpener

    doc = json.loads((V1 / "fixtures" / "F-serial-dfu.json").read_text())
    steps = doc["steps"]
    boot_opener = FakeBootOpener()
    r = HoldRig(tmp_path, dfu={"enabled": True, "bootloader": {"by_id": "usb-TEST_bootloader-*"}},
                bridge_kw={"boot_opener": boot_opener, "runner": lambda fn: fn()})
    try:
        r.bridge._sleep = r.clock.advance
        hellos = [s["frame"]["hello"] for s in steps if s["step"] == "send" and s["frame"]["type"] == "iface_hello"]
        r.dev.hello_result = hellos[0]
        for s in steps:
            if s["step"] == "package_get":  # the Backend's route serves the fixture's package
                r.server.packages[s["path"].rsplit("/", 1)[1]] = base64.b64decode(s["body_base64"])
        conn = r.up()
        seen, boot = 0, None
        for i, s in enumerate(steps):
            k = s["step"]
            if k == "send":
                r.wait(lambda: len(conn.frames) > seen)
                assert json.loads(conn.frames[seen]) == s["frame"], f"step {i + 1}"
                seen += 1
            elif k == "recv":
                conn.send(s["frame"])
                r.settle(15)
            elif k == "package_get":
                r.wait(lambda: len(r.server.package_requests) >= 1)  # asked for when the job arrived
                path, headers = r.server.package_requests[-1]
                assert path == s["path"] and headers["authorization"] == s["authorization"].replace("<token>", TOKEN)
            elif k == "device_write":
                r.wait(lambda: r.dev.messages)
                assert r.dev.messages[-1] == s["wire"].encode()
            elif k == "device_read":
                r.dev.say(s["text"].encode())
            elif k == "device_link" and s["port"] == "application" and s["event"] == "lost":
                r.opener.unplug()
            elif k == "device_link" and s["port"] == "bootloader" and s["event"] == "opened":
                boot = FakeBootloader()
                boot_opener.appear(boot)
                r.jump(0.6)
            elif k == "bootloader_write":
                assert boot is not None
                r.wait(lambda: boot.stopped)
                n = sum(1 for x in steps[:i] if x["step"] == "bootloader_write")
                assert boot.raw_frames[n].hex() == s["hex"], f"step {i + 1}"
                assert boot.acks_sent[n].hex() == s["ack_hex"], f"step {i + 1}"
            elif k == "device_link" and s["port"] == "bootloader" and s["event"] == "closed":
                assert boot is not None and boot.closed and boot.complete, boot.errors
            elif k == "device_link" and s["port"] == "application" and s["event"] == "opened":
                r.dev = r.opener.plug()
                r.dev.answers_hello = True
                r.dev.hello_result = hellos[1]
        r.settle(60)
        assert len(conn.frames) == seen, "the agent sent a frame the scenario does not show"
        assert boot is not None and len(boot.raw_frames) == sum(1 for x in steps if x["step"] == "bootloader_write")
        assert not conn.closed.is_set() and r.server.handshakes == 1
    finally:
        r.close()


def test_generator_reproduces_the_fixture_files():
    root = pathlib.Path(__file__).resolve().parents[2]
    gen = root / "connector" / "scripts" / "gen_hold_fixtures.py"
    if not gen.exists():
        pytest.skip("generator not in this image")
    p = subprocess.run([sys.executable, str(gen), "--check"], capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr


def test_every_checklist_item_has_a_test():
    """contracts/connector-hold/v1/README.md section 9 numbers 24 items; tests/test_hold.py and tests/test_dfu.py
    name their tests test_conf_NN for each, so a new item cannot ship without one."""
    text = (V1 / "README.md").read_text()
    items = re.findall(r"(?m)^(\d+)\. ", text.split("## 9. Conformance checklist")[1].split("## 10.")[0])
    assert items == [str(n) for n in range(1, 25)]
    src = "".join((pathlib.Path(__file__).parent / f).read_text() for f in ("test_hold.py", "test_dfu.py"))
    covered = set(re.findall(r"def test_conf_(\d\d)", src))
    covered |= {n for grp in re.findall(r"def test_conf_((?:\d\d_)+)", src) for n in re.findall(r"\d\d", grp)}
    assert {f"{n:02d}" for n in range(1, 25)} <= covered
