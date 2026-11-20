"""The hold transport against a fake Backend hold endpoint (real WebSocket on loopback) and the fake serial
device. Names test_conf_NN follow the conformance checklist in contracts/connector-hold/v1/README.md."""

import hashlib
import json
import time

import pytest

from fakes.fake_hold_server import TOKEN, FakeHoldServer
from hold_rig import HoldRig


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


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def wire_for(rid, op="status.get", pad=""):
    body = json.dumps({"v": 1, "id": rid, "op": op}, separators=(",", ":"))
    return json.dumps({"mecon_auth": 1, "issuer": "<issuer>", "sig": "<sig>" + pad, "body": body}, separators=(",", ":"))


def rid_of(message: bytes):
    return json.loads(json.loads(message)["body"])["id"]


def result_for(dev, rid, op="status.get"):
    return json.dumps(
        {"v": 1, "id": rid, "op": op, "status": "ok", "usig_boot": dev.epoch, "usig_seq": dev._next_seq(),
         "result": {}, "usig": "U1lOVEhFVElD"},
        separators=(",", ":"),
    ).encode()


def req(conn, rid, wire=None):
    conn.send({"type": "iface_req", "id": rid, "wire": wire if wire is not None else wire_for(rid)})


def frames(conn, typ):
    return [f for f in conn.parsed() if f.get("type") == typ]


def answer_all(rig):
    rig.dev.reply_hook = lambda m: result_for(rig.dev, rid_of(m))


# ---- connect (checklist 1-3, 5) ---------------------------------------------------------------


def test_conf_01_header_form_connects_to_gateway_ws(mk):
    r = mk()
    conn = r.up()
    assert conn.path == "/gateway/ws"
    assert conn.headers["authorization"] == f"Bearer {TOKEN}"
    assert conn.offered == []  # the header form offers no subprotocol
    assert r.bridge.snapshot()["ready"] is True


def test_conf_01_base_url_prefix_is_kept(tmp_path):
    server = FakeHoldServer()
    try:
        tf = tmp_path / "t"
        tf.write_text(TOKEN)
        tf.chmod(0o600)
        from hold_rig import hold_cfg

        cfg = hold_cfg(server.url + "/prefix/", tf)
        assert cfg.hold.ws_url.endswith("/prefix/gateway/ws")
    finally:
        server.shutdown()


def test_conf_01_02_subprotocol_form_offers_both_entries_and_accepts_mecon_bridge(mk):
    r = mk(presentation="subprotocol")
    conn = r.up()
    assert conn.offered == ["mecon-bridge", f"bearer.{TOKEN}"]
    assert "authorization" not in conn.headers
    assert conn.selected == "mecon-bridge"  # the token entry is never echoed, and the agent does not expect it
    assert r.bridge._state == "connected"
    assert TOKEN not in conn.path


def test_conf_03_rejected_token_http_is_a_stop_not_a_loop(mk):
    r = mk(token="wrong-token-value-1234")
    r.wait(lambda: r.bridge.hold_stop is not None)
    assert r.bridge.hold_stop[0] == "bad_token"
    n = r.server.handshakes
    for _ in range(10):
        r.jump(60)
    assert r.server.handshakes == n == 1
    snap = r.bridge.snapshot()
    assert snap["ready"] is False and snap["hold"] == "stopped" and snap["hold_stop"] == "bad_token"
    assert r.m("hold_stopped") == 1 and r.m("hold_connect_attempts_total", "bad_token") == 1


def test_conf_03_rejected_token_closed_1008_after_accept_is_a_stop(tmp_path, mk):
    server = FakeHoldServer(reject_style="close")
    try:
        r = mk(server=server, token="wrong-token-value-1234")
        r.wait(lambda: r.bridge.hold_stop is not None)
        assert r.bridge.hold_stop[0] == "bad_token"
        for _ in range(10):
            r.jump(60)
        assert server.handshakes == 1
    finally:
        server.shutdown()


@pytest.mark.parametrize("status", [403, 401])
def test_conf_03_upgrade_answered_403_or_401_is_a_stop_never_a_retry(mk, status):
    r = mk()
    r.server.http_status = status  # the Backend rejects the upgrade before accept: no WebSocket frame, no 1008
    r.wait(lambda: r.bridge.hold_stop is not None)
    assert r.bridge.hold_stop[0] == "bad_token" and r.m("hold_connect_attempts_total", "bad_token") == 1
    for _ in range(10):
        r.jump(60)
    assert r.server.handshakes == 1
    assert r.bridge.snapshot()["hold"] == "stopped"


def test_server_error_is_retried_not_a_stop(mk):
    r = mk()
    r.server.http_status = 503
    r.wait(lambda: r.m("hold_connect_attempts_total", "http") >= 1)
    assert r.bridge.hold_stop is None


def test_conf_05_second_agent_is_refused_and_does_not_reconnect(mk):
    first = mk()
    c1 = first.up()
    second = mk(server=first.server)
    second.wait(lambda: second.bridge.hold_stop is not None)
    assert second.bridge.hold_stop == ("refused", "another agent holds this device")
    n = first.server.handshakes
    for _ in range(8):
        second.jump(30)
    assert first.server.handshakes == n  # no auto-reconnect
    assert second.m("hold_stopped") == 1
    # the first agent's socket is unaffected
    first.settle()
    assert not c1.closed.is_set() and first.bridge._state == "connected"


def test_refused_with_a_revoked_token_reason_is_surfaced_and_final(mk):
    server = FakeHoldServer()
    server.on_connect = lambda c: (c.send({"type": "refused", "reason": "connector token revoked"}), c.close(1008, ""))
    try:
        r = mk(server=server)
        r.wait(lambda: r.bridge.hold_stop is not None)
        assert r.bridge.hold_stop == ("refused", "connector token revoked")
        assert "connector token revoked" in json.dumps(r.bridge.snapshot())
        for _ in range(5):
            r.jump(60)
        assert server.handshakes == 1
    finally:
        server.shutdown()


# ---- declaration and hello (4, 18) ------------------------------------------------------------


def test_conf_04_relay_is_the_first_frame_and_repeats_after_every_connect(mk):
    r = mk()
    c1 = r.up()
    assert c1.parsed()[0] == {"type": "iface_relay"}
    c1.close(1011, "restart")
    r.wait(lambda: r.bridge._state == "idle")
    r.jump(1.1)
    c2 = r.up()
    assert c2 is not c1
    assert c2.parsed()[0] == {"type": "iface_relay"}
    assert r.m("hold_relay_declared_total") == 2


def test_conf_18_iface_hello_carries_the_hello_result_object_after_the_relay(mk):
    r = mk()
    conn = r.up()
    h = conn.parsed()[1]
    assert h["type"] == "iface_hello" and h["hello"] == r.dev.hello_result and isinstance(h["ref"], int)
    assert len(r.dev.hello_writes) == 1  # the Connector asked for it itself
    assert frames(conn, "iface_result") == []  # its own hello answer is consumed, never uploaded


def test_hello_is_read_again_after_a_reboot_and_the_new_object_goes_up(mk):
    r = mk()
    conn = r.up()
    r.dev.epoch = 2
    r.dev.hello_result = {**r.dev.hello_result, "epoch": 2, "name": "after-reboot"}
    r.dev.say(r.dev.event("health"))
    r.wait(lambda: len(frames(conn, "iface_hello")) == 2)
    assert frames(conn, "iface_hello")[1]["hello"]["name"] == "after-reboot"
    assert r.m("downlink_gate_closes_total", "epoch_changed") == 1


def test_issue_91_no_reboot_seen_when_only_result_epoch_authority_epoch_or_usig_boot_differ(mk):
    # The standing bench Connector closed its gate 4 s after start: an answer's `result.epoch` (or another
    # counter) differed from the events' boot epoch. Only the envelope's top-level `epoch` counts.
    r = mk()
    conn = r.up()
    e = r.dev.epoch
    r.dev.say(json.dumps({"v": 1, "id": "x-1", "status": "ok", "epoch": e, "usig_boot": e + 40, "usig_seq": 5,
                          "result": {"epoch": e + 7, "authority_epoch": e + 3}, "usig": "x"}).encode())
    r.dev.say(json.dumps({"v": 1, "id": "x-2", "status": "ok", "usig_boot": e + 40, "usig_seq": 6,
                          "result": {"epoch": e + 7}, "usig": "x"}).encode())  # no top-level epoch at all
    r.dev.say(r.dev.event("health"))
    for _ in range(4):
        r.step(1)
    assert r.m("downlink_gate_closes_total", "epoch_changed") == 0
    assert len(frames(conn, "iface_hello")) == 1


def test_socket_opens_only_when_the_device_link_is_up(mk):
    r = mk(plugged=False)
    for _ in range(5):
        r.step(20)
        r.jump(2)
    assert r.server.handshakes == 0
    r.dev = r.opener.plug()
    r.dev.answers_hello = True
    r.up()
    assert r.server.handshakes == 1


def test_socket_waits_for_the_device_hello(mk):
    r = mk()
    r.dev.answers_hello = False
    r.settle()
    r.jump(20)  # the first hello times out
    assert r.server.handshakes == 0 and r.m("hold_hello_total", "timeout") == 1
    r.dev.answers_hello = True
    r.jump(6)
    r.up()
    assert r.server.handshakes == 1


# ---- relaying requests (6-10, 13) -------------------------------------------------------------


def test_conf_06_wire_reaches_the_device_byte_for_byte(mk):
    r = mk()
    conn = r.up()
    answer_all(r)
    # keys out of order, odd spacing, escapes, non-ASCII, a trailing space: nothing may be normalised
    wire = '{"sig" : "<sig>\\u00e9 \\"q\\"", "mecon_auth":1,"body":"{\\"v\\":1,\\"id\\":\\"j7\\",\\"op\\":\\"status.get\\"}",  "issuer":"é<issuer>" }  '
    req(conn, "j7", wire)
    r.wait(lambda: len(r.dev.messages) == 1)
    assert sha(r.dev.messages[0]) == sha(wire.encode("utf-8"))
    assert r.dev.messages[0] == wire.encode("utf-8")


def test_conf_06_frames_missing_a_string_id_or_wire_write_nothing(mk):
    r = mk()
    conn = r.up()
    for bad in ({"type": "iface_req", "id": "a"}, {"type": "iface_req", "wire": "{}"},
                {"type": "iface_req", "id": 5, "wire": "{}"}, {"type": "iface_req", "id": "a", "wire": 7}):
        conn.send(bad)
    r.settle(60)
    assert r.dev.written == [] and r.m("hold_frames_ignored_total", "malformed_req") == 4


def test_conf_07_companion_framing_168_byte_chunks(mk):
    r = mk()
    conn = r.up()
    answer_all(r)
    wire = wire_for("c400", pad="x" * (400 - len(wire_for("c400"))))
    assert len(wire.encode()) == 400
    req(conn, "c400", wire)
    r.wait(lambda: len(r.dev.written) == 1)
    raw = r.dev.written[0]
    frames_, i = [], 0
    while i < len(raw):
        n = raw[i + 1] | (raw[i + 2] << 8)
        assert raw[i] == 0x3C
        frames_.append(raw[i + 3 : i + 3 + n])
        i += 3 + n
    assert [len(f) - 4 for f in frames_] == [168, 168, 64]
    assert {f[0] for f in frames_} == {0x7F} and len({f[1] for f in frames_}) == 1
    assert [f[2] for f in frames_] == [0, 1, 2] and {f[3] for f in frames_} == {3}


def test_conf_07_companion_limit_is_4096_bytes_and_25_frames(mk):
    r = mk()
    conn = r.up()
    answer_all(r)
    ok = wire_for("big", pad="y" * (4096 - len(wire_for("big"))))
    assert len(ok.encode()) == 4096
    req(conn, "big", ok)
    r.wait(lambda: len(r.dev.messages) == 1)
    assert r.dev.messages[0] == ok.encode()
    over = wire_for("over", pad="y" * (4097 - len(wire_for("over"))))
    req(conn, "over", over)
    r.settle(60)
    assert len(r.dev.messages) == 1 and r.m("downlink_dropped_total", "too_large") == 1


def test_conf_08_console_bare_cr_once_then_prefix_wire_cr(mk):
    r = mk(mode="console")
    conn = r.up()
    answer_all(r)
    for rid in ("k1", "k2"):
        req(conn, rid)
        r.wait(lambda rid=rid: any(rid_of(m) == rid for m in r.dev.messages))
        r.wait(lambda: r.bridge._slot is None)
    assert r.dev.cr_writes == 1  # once per link, before the first request (the Connector's own hello)
    assert r.dev.written[0] == b"mecon> " + wire_for("k1").encode() + b"\r"
    assert r.dev.written[1] == b"mecon> " + wire_for("k2").encode() + b"\r"
    # a new link primes again, once
    r.opener.unplug()
    r.wait(lambda: r.bridge._link is None)
    r.dev = r.opener.plug()
    r.dev.answers_hello = True
    r.wait(lambda: r.dev.cr_writes == 1 and r.dev.hello_writes)


def test_conf_08_console_refuses_cr_lf_and_over_long_wire(mk):
    r = mk(mode="console")
    conn = r.up()
    answer_all(r)
    base = wire_for("e1")
    for rid, w in (("cr", base[:-1] + "\r}"), ("lf", base[:-1] + "\n}")):
        req(conn, rid, w)
    longest = wire_for("long", pad="z" * (1600 - len(wire_for("long"))))
    assert len(longest.encode()) == 1600
    req(conn, "long", longest)
    r.wait(lambda: len(r.dev.messages) == 1)
    assert r.dev.messages[0] == longest.encode()
    r.wait(lambda: r.bridge._slot is None)
    req(conn, "toolong", wire_for("toolong", pad="z" * (1601 - len(wire_for("toolong")))))
    r.settle(60)
    assert len(r.dev.messages) == 1
    assert r.m("downlink_dropped_total", "invalid") == 2 and r.m("downlink_dropped_total", "too_large") == 1


def test_conf_09_console_reply_of_1600_bytes_is_read_and_uploaded(mk):
    r = mk(mode="console")
    conn = r.up()
    r.dev.reply_hook = lambda m: None
    req(conn, "big1")
    r.wait(lambda: len(r.dev.messages) == 1)
    head = '{"v":1,"id":"big1","status":"ok","usig":"U1lO","pad":"'
    text = head + "p" * (1600 - len(head) - 2) + '"}'
    assert len(text) == 1600
    r.dev.say(text.encode())  # a 1,607-byte line, 1,609 with CRLF
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    assert frames(conn, "iface_result")[0]["message"] == text


def test_conf_09_console_only_mecon_json_lines_are_interface_messages(mk):
    r = mk(mode="console")
    conn = r.up()
    r.dev.reply_hook = lambda m: None
    req(conn, "n1")
    r.wait(lambda: len(r.dev.messages) == 1)
    res = result_for(r.dev, "n1")
    r.dev.feed(b"mecon> \r\n", b"[boot] radio ok\r\n", b"> status\r\n", b"mecon> not json\r\n")
    r.dev.say(res)
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    r.settle()
    up = frames(conn, "iface_result")
    assert [f["message"] for f in up] == [res.decode()]
    assert frames(conn, "iface_event") == []


def test_conf_10_one_request_at_a_time_then_abandon_after_the_wait(mk):
    r = mk()
    conn = r.up()
    seen = []
    r.dev.reply_hook = lambda m: seen.append(rid_of(m))  # never answers
    req(conn, "a1")
    req(conn, "a2")
    r.wait(lambda: len(r.dev.messages) == 1)
    r.settle(60)
    assert seen == ["a1"]  # a2 waits: the device handles one message at a time
    r.jump(14)
    assert seen == ["a1"]
    r.jump(2)  # 15 s: a1 is abandoned; a2 waited past its 5 s queue life and is refused, never sent late
    r.wait(lambda: r.m("hold_request_timeouts_total") == 1)
    assert r.m("downlink_dropped_total", "ttl") == 1 and seen == ["a1"]
    req(conn, "a3")  # the device is free again
    r.wait(lambda: len(r.dev.messages) == 2)
    assert seen == ["a1", "a3"]
    assert [rid_of(m) for m in r.dev.messages].count("a1") == 1  # never written again
    assert frames(conn, "iface_result") == []  # nothing is posted for an abandoned request


def test_conf_10_second_request_is_sent_only_after_the_first_is_answered(mk):
    r = mk()
    conn = r.up()
    r.dev.reply_hook = lambda m: None
    req(conn, "b1")
    req(conn, "b2")
    r.wait(lambda: len(r.dev.messages) == 1)
    r.settle(40)
    assert len(r.dev.messages) == 1
    r.dev.say(result_for(r.dev, "b1"))
    r.wait(lambda: len(r.dev.messages) == 2)
    assert rid_of(r.dev.messages[1]) == "b2"


def test_duplicate_id_in_flight_is_ignored_and_the_result_goes_once(mk):
    r = mk()
    conn = r.up()
    r.dev.reply_hook = lambda m: None
    req(conn, "d1")
    r.wait(lambda: len(r.dev.messages) == 1)
    req(conn, "d1")
    r.settle(40)
    assert len(r.dev.messages) == 1 and r.m("downlink_dropped_total", "duplicate") == 1
    r.dev.say(result_for(r.dev, "d1"))
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    r.settle()
    assert len(frames(conn, "iface_result")) == 1


def test_a_late_result_of_an_abandoned_request_is_still_the_devices_own_answer(mk):
    r = mk()
    conn = r.up()
    r.dev.reply_hook = lambda m: None
    req(conn, "l1")
    r.wait(lambda: len(r.dev.messages) == 1)
    r.jump(16)
    late = result_for(r.dev, "l1")
    r.dev.say(late)
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    assert frames(conn, "iface_result")[0]["message"] == late.decode()
    r.dev.say(result_for(r.dev, "never-asked"))  # nobody asked: not forwarded
    r.settle()
    assert len(frames(conn, "iface_result")) == 1 and r.m("upstream_dropped_total", "unmatched") == 1


# ---- uploads and acks (11, 12) ----------------------------------------------------------------


def test_conf_11_result_is_uploaded_with_the_exact_text(mk):
    r = mk()
    conn = r.up()
    text = '{"v":1,"id":"j7","op":"status.get","status":"ok","note":"é  \\" tab\\t","usig_boot":1,"usig_seq":9,"result":{},"usig":"U1lO" }'
    r.dev.reply_hook = lambda m: text.encode("utf-8")
    req(conn, "j7")
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    f = frames(conn, "iface_result")[0]
    assert sha(f["message"].encode("utf-8")) == sha(text.encode("utf-8"))
    assert set(f) == {"type", "ref", "message"}
    # the frame on the wire is JSON text carrying exactly that string
    assert json.loads(conn.frames[-1])["message"] == text


def test_conf_11_empty_result_id_answers_the_request_waiting(mk):
    r = mk()
    conn = r.up()
    r.dev.reply_hook = lambda m: None
    req(conn, "w1")
    r.wait(lambda: len(r.dev.messages) == 1)
    anon = json.dumps({"v": 1, "id": "", "status": "refused", "usig": "U1lO"}).encode()
    r.dev.say(anon)
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    assert r.bridge._slot is None


def test_conf_12_events_go_up_with_their_stream(mk):
    r = mk()
    conn = r.up()
    ev = r.dev.event("health")
    r.dev.say(ev)
    r.wait(lambda: len(frames(conn, "iface_event")) == 1)
    f = frames(conn, "iface_event")[0]
    assert f["stream"] == "health" and f["message"].encode() == ev and isinstance(f["ref"], int)
    r.dev.say(r.dev.event("power_state"))
    r.wait(lambda: len(frames(conn, "iface_event")) == 2)


@pytest.mark.parametrize("name", ["Health", "result", "a" * 33, "1abc", "x-y", "", "a b", "_a", "é"])
def test_conf_12_a_stream_outside_the_pattern_is_dropped_and_counted(mk, name):
    r = mk()
    conn = r.up()
    r.dev.say(r.dev.event(name))
    r.wait(lambda: r.m("upstream_dropped_total", "invalid_stream") == 1)
    r.settle()
    assert frames(conn, "iface_event") == []


def test_stream_of_32_chars_is_allowed(mk):
    r = mk()
    conn = r.up()
    r.dev.say(r.dev.event("a" * 32))
    r.wait(lambda: len(frames(conn, "iface_event")) == 1)


def ack(conn, of, ref, outcome):
    conn.send({"type": "iface_ack", "of": of, "ref": ref, "outcome": outcome})


def test_conf_11_12_ack_outcomes_are_counted_and_nothing_is_resent(mk):
    r = mk()
    conn = r.up()
    for i in range(3):
        r.dev.say(r.dev.event("health"))
    r.wait(lambda: len(frames(conn, "iface_event")) == 3)
    refs = [f["ref"] for f in frames(conn, "iface_event")]
    ack(conn, "iface_event", refs[0], "refused: forged or replayed")
    ack(conn, "iface_event", refs[1], "duplicate")
    ack(conn, "iface_event", refs[2], "kept")
    ack(conn, "iface_event", 9999, "kept")  # nobody sent that ref
    ack(conn, "iface_result", refs[0], "kept")  # wrong kind for that ref (and already answered)
    conn.send({"type": "iface_ack", "of": "iface_event"})  # malformed
    r.wait(lambda: sum(r.m("hold_acks_total", k) for k in ("refused", "duplicate", "accepted", "unmatched", "malformed")) == 6)
    assert (r.m("hold_acks_total", "refused"), r.m("hold_acks_total", "duplicate"), r.m("hold_acks_total", "accepted")) == (1, 1, 1)
    assert r.m("hold_acks_total", "unmatched") == 2 and r.m("hold_acks_total", "malformed") == 1
    n = len(conn.frames)
    r.settle(80)
    r.jump(30)
    assert len(conn.frames) == n  # a refusal is never resent
    assert r.bridge._state == "connected"  # and neither refusal nor duplicate closes anything


def test_hello_ack_refused_does_not_close_the_hold(mk):
    r = mk()
    conn = r.up()
    ack(conn, "iface_hello", frames(conn, "iface_hello")[0]["ref"], "refused: no v1 device on record")
    r.wait(lambda: r.m("hold_acks_total", "refused") == 1)
    assert r.bridge._state == "connected"


def test_events_while_the_hold_is_down_are_dropped_and_counted(mk):
    r = mk()
    r.up()
    r.server.http_status = 503
    r.server.current().close(1011, "")
    r.wait(lambda: r.bridge._state == "idle")
    r.dev.say(r.dev.event("health"))
    r.wait(lambda: r.m("upstream_dropped_total", "socket_down") == 1)


def _uploads(r):
    return sum(r.m("hold_uploads_total", k) for k in ("hello", "result", "event"))


def _settled(r):
    return sum(r.m("hold_acks_total", k) for k in ("accepted", "duplicate", "refused", "malformed"))


def test_uploads_unacked_when_the_socket_closes_are_counted_uncertain_and_not_resent(mk):
    # The standing bench Connector lost two sessions to a Backend deploy; uploads sent on them and never
    # acknowledged were counted nowhere, so uploads != acks + drops and an operator could not account for them.
    r = mk()
    conn = r.up()
    for i in range(3):
        r.dev.say(r.dev.event("health"))
    r.wait(lambda: len(frames(conn, "iface_event")) == 3)
    ack(conn, "iface_event", frames(conn, "iface_event")[0]["ref"], "kept")
    r.wait(lambda: r.m("hold_acks_total", "accepted") == 1)
    pending = _uploads(r) - _settled(r)
    assert pending == 3  # the hello and two events
    sent = len(conn.frames)
    conn.close(1011, "")
    r.wait(lambda: r.bridge._state != "connected")
    assert r.m("hold_uploads_uncertain_total") == pending
    assert _uploads(r) == _settled(r) + r.m("hold_uploads_uncertain_total")
    r.jump(2)
    second = r.up()
    assert second is not conn
    # The new session uploads its own hello and nothing from the old one, and counts nothing extra.
    assert [f["type"] for f in second.parsed()] == ["iface_relay", "iface_hello"]
    assert r.m("hold_uploads_uncertain_total") == pending
    assert len(conn.frames) == sent


def test_uploads_unacked_when_the_backend_refuses_the_session_are_counted_uncertain(mk):
    r = mk()
    conn = r.up()
    r.dev.say(r.dev.event("health"))
    r.wait(lambda: len(frames(conn, "iface_event")) == 1)
    pending = _uploads(r) - _settled(r)
    assert pending == 2
    conn.send({"type": "refused", "reason": "token revoked"})
    r.wait(lambda: r.bridge.hold_stop is not None)
    assert r.m("hold_uploads_uncertain_total") == pending


def test_uploads_unacked_at_an_explicit_stop_are_counted_uncertain(mk):
    r = mk()
    conn = r.up()
    r.dev.say(r.dev.event("health"))
    r.wait(lambda: len(frames(conn, "iface_event")) == 1)
    pending = _uploads(r) - _settled(r)
    assert pending == 2
    r.bridge.stop()
    assert r.m("hold_uploads_uncertain_total") == pending


# ---- liveness, reconnect, stop (3, 14, 15, 16, 17) --------------------------------------------


def test_conf_14_reconnect_backoff_is_1_2_4_8_15_then_15(mk):
    r = mk()
    r.up()
    r.server.http_status = 503
    r.server.current().close(1011, "")
    delays = []
    for k in range(7):
        r.wait(lambda k=k: r.bridge._state == "idle" and r.bridge._attempt == k + 1)
        d = r.bridge._retry_at - r.clock()
        delays.append(round(d))
        hs = r.server.handshakes
        r.settle(10)
        assert r.server.handshakes == hs  # not before it is due
        r.clock.advance(d + 0.01)
    assert delays == [1, 2, 4, 8, 15, 15, 15]


def test_conf_14_counter_resets_when_a_socket_opens(mk):
    r = mk()
    r.up()
    r.server.http_status = 503
    r.server.current().close(1011, "")
    for k in range(3):
        r.wait(lambda k=k: r.bridge._state == "idle" and r.bridge._attempt == k + 1)
        r.clock.advance(r.bridge._retry_at - r.clock() + 0.01)
    r.server.http_status = None
    r.wait(lambda: r.bridge._state == "connected")
    r.server.current().close(1011, "")
    r.wait(lambda: r.bridge._state == "idle")
    assert round(r.bridge._retry_at - r.clock()) == 1


def test_conf_15_device_link_drop_closes_the_socket_with_1000(mk):
    r = mk()
    conn = r.up()
    r.opener.unplug()
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000
    assert r.bridge._state == "idle" and r.bridge._hello is None
    hs = r.server.handshakes
    r.jump(20)
    assert r.server.handshakes == hs  # no socket while there is no link
    r.dev = r.opener.plug()
    r.dev.answers_hello = True
    c2 = r.up()
    assert c2 is not conn and c2.parsed()[0] == {"type": "iface_relay"}


def test_stop_closes_1000(mk):
    r = mk()
    conn = r.up()
    r.bridge.stop()
    assert conn.closed.wait(3)
    assert conn.close_code == 1000 and conn.close_reason == "stopped"
    assert r.bridge._link is None


def test_conf_16_17_unknown_and_malformed_frames_are_ignored_without_closing(mk):
    r = mk()
    conn = r.up()
    answer_all(r)
    for f in ('{"type":"registered","id":3}', '{"type":"cmd","cmd":"repeater_cli","command":"x"}', "not json", "[1,2]",
              '{"no":"type"}', '{"type":5}'):
        conn.send(f)
    conn.ws.send(b"\x00\x01")  # a binary frame is not part of the protocol
    r.settle(60)
    assert r.bridge._state == "connected" and not conn.closed.is_set()
    assert r.m("hold_frames_ignored_total", "unknown_type") == 2
    assert r.m("hold_frames_ignored_total", "invalid_json") == 1 and r.m("hold_frames_ignored_total", "not_object") == 1
    assert r.m("hold_frames_ignored_total", "no_type") == 2 and r.m("hold_frames_ignored_total", "binary") == 1
    req(conn, "after")  # and requests still work
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)


def test_conf_17_the_agent_sends_only_json_text_objects_with_a_string_type(mk):
    r = mk()
    conn = r.up()
    answer_all(r)
    req(conn, "q1")
    r.dev.say(r.dev.event("health"))
    r.wait(lambda: len(conn.frames) >= 4)
    for f in conn.frames:
        assert isinstance(f, str) and isinstance(json.loads(f)["type"], str)


def test_conf_13_nothing_is_signed_added_or_invented(mk):
    r = mk()
    conn = r.up()
    r.dev.reply_hook = lambda m: None  # the device stays silent
    req(conn, "s1")
    r.wait(lambda: len(r.dev.messages) == 1)
    r.jump(30)
    assert frames(conn, "iface_result") == []  # no result is made up for a silent device
    assert b"auth" not in r.dev.messages[0].replace(b"mecon_auth", b"")


# ---- the enrolment gate in hold mode ---------------------------------------------------------


def test_gate_an_unenrolled_device_never_gets_a_hold(mk):
    r = mk(enrolment="none")
    r.settle(80)
    assert r.server.handshakes == 0 and r.m("downlink_gate_probes_total", "none") >= 1
    assert r.bridge.snapshot()["downlink"] == "closed"


def test_gate_corrupt_and_silent_devices_get_no_hold_either(mk):
    for e in ("corrupt", "refused", "garbage"):
        r = mk(enrolment=e)
        r.settle(80)
        assert r.server.handshakes == 0, e
    r = mk(enrolment="silent")
    r.settle(20)
    r.jump(9)
    assert r.server.handshakes == 0 and r.m("downlink_gate_probes_total", "timeout") == 1


def test_gate_closes_on_the_first_unsigned_uplink_and_requests_are_refused_meanwhile(mk):
    r = mk()
    conn = r.up()
    answer_all(r)
    r.dev.enrolment = "silent"  # the re-ask goes unanswered, so the closed window is observable
    r.dev.say(r.dev.event("health", signed=False))
    r.wait(lambda: r.m("downlink_gate_closes_total", "unsigned_uplink") == 1)
    assert r.bridge._state == "connected"  # still asking: the hold stays
    req(conn, "g1")
    r.wait(lambda: r.m("downlink_closed_total") >= 1)
    r.settle(40)
    assert r.dev.messages == []  # refused, never held
    r.jump(9)  # the re-ask times out: not enrolled as far as anyone knows, so the hold is released
    assert conn.closed.wait(3) and conn.close_code == 1000
    r.dev.enrolment = "provisioned"
    r.jump(31)
    c2 = r.up()
    assert c2 is not conn
    req(c2, "g2")  # reopened: the earlier request was not replayed, a new one works
    r.wait(lambda: [rid_of(m) for m in r.dev.messages] == ["g2"])


def test_gate_is_closed_by_a_device_that_says_none_after_a_reset(mk):
    r = mk()
    conn = r.up()
    r.dev.enrolment = "none"
    r.dev.signed = False
    r.dev.say(r.dev.event("health"))
    r.wait(lambda: conn.closed.is_set())
    assert conn.close_code == 1000
    assert r.m("downlink_gate_probes_total", "none") == 1


# ---- the token never leaks (credentials) ------------------------------------------------------


@pytest.mark.parametrize("presentation", ["header", "subprotocol"])
def test_token_is_never_logged_counted_or_reported(mk, capfd, presentation):
    r = mk(presentation=presentation)
    conn = r.up()
    answer_all(r)
    req(conn, "t1")
    r.wait(lambda: len(frames(conn, "iface_result")) == 1)
    r.server.current().close(1011, "")
    r.wait(lambda: r.bridge._state == "idle")
    r.jump(2)
    r.up()
    r.bridge.stop()
    out = capfd.readouterr()
    for blob in (r.logbuf.getvalue(), r.metrics.render(), json.dumps(r.bridge.snapshot()), out.out, out.err):
        assert TOKEN not in blob


def test_token_is_not_logged_when_the_backend_rejects_it(mk, capfd):
    r = mk(token=TOKEN + "-rejected")
    r.wait(lambda: r.bridge.hold_stop is not None)
    out = capfd.readouterr()
    for blob in (r.logbuf.getvalue(), r.metrics.render(), json.dumps(r.bridge.snapshot()), out.out, out.err):
        assert TOKEN not in blob


def test_an_unreadable_token_file_is_retried_not_fatal_and_not_echoed(mk):
    r = mk()
    r.token_file.unlink()
    r.settle(20)
    assert r.m("hold_connect_attempts_total", "credential") >= 1
    assert r.bridge.hold_stop is None and "FileNotFoundError" in r.logbuf.getvalue()
    r.token_file.write_text(TOKEN)
    r.token_file.chmod(0o600)
    r.jump(20)
    r.up()
