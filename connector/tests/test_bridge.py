import json
import random

from conftest import Rig, make_cfg
from mecon_connector.framing import encode_mecon_frames, encode_serial_frame

DEV_SERIAL_MARKER = 0x3E


def wire(msg: bytes, xid: int = 1) -> bytes:
    # xids from 100 up: the fake device numbers its own replies from 1, and a device never repeats an xid back to back
    return b"".join(encode_serial_frame(f, DEV_SERIAL_MARKER) for f in encode_mecon_frames((100 + xid) % 256, msg))


def status(rig, broker="primary"):
    return json.loads(rig.net.brokers[broker].retained[rig.status])


# ---- startup, status, will ----------------------------------------------------------------


def test_connects_and_publishes_connector_status_only():
    rig = Rig()
    rig.settle()
    assert rig.bridge.snapshot()["ready"]
    assert status(rig) == {"v": 1, "connector": "online", "serial": "up"}
    will = rig.transport._will
    assert will.topic == rig.status and will.retain and will.qos == 1
    assert json.loads(will.payload) == {"v": 1, "connector": "offline", "serial": "unknown"}
    # nothing was published on the data topic: no fabricated message of any kind
    assert rig.net.brokers["primary"].on_topic(rig.up) == []


def test_unclean_drop_leaves_the_will_and_clean_stop_leaves_offline():
    rig = Rig()
    rig.settle()
    rig.transport.drop_session()
    assert status(rig)["connector"] == "offline"
    rig2 = Rig()
    rig2.settle()
    rig2.bridge.stop()
    assert status(rig2) == {"v": 1, "connector": "offline", "serial": "up"}


# ---- upstream: transparency ---------------------------------------------------------------


def test_random_opaque_messages_arrive_byte_identical():
    rng = random.Random(11)
    rig = Rig()
    rig.settle()
    sent = []
    for i in range(40):
        n = rng.choice([1, 2, 167, 168, 169, 500, 1500, 4096])
        msg = bytes(rng.randrange(256) for _ in range(n))
        if i % 3 == 0:
            msg = msg[:-1] + b" "  # trailing space/newline-ish bytes must survive
        sent.append(msg)
        rig.dev.feed_bytes(wire(msg, i % 256), rng.choice(["whole", "bytes", 13, 100]))
        rig.pump()
    assert rig.published() == sent
    assert rig.bridge.accounting_gap() == 0


def test_edge_bytes_at_the_end_of_a_message_survive():
    rig = Rig()
    rig.settle()
    sent = []
    for i, tail in enumerate([b"\x00", b"\x00\x00\x00", b" ", b"\r\n", b"\n", b"\x7f", b"\xff\x00"]):
        for body_len in (1, 168 - len(tail), 169, 400):
            msg = (b"A" * body_len)[: max(1, body_len)] + tail
            sent.append(msg)
            rig.dev.feed_bytes(wire(msg, (i * 8 + body_len) % 256), 7)
            rig.pump()
    assert rig.published() == sent


def test_split_frame_is_published_exactly_once():
    rig = Rig()
    rig.settle()
    msg = b"s" * 700
    rig.dev.feed_bytes(wire(msg), "bytes")
    rig.pump()
    assert rig.published() == [msg]
    # a device that repeats the last frame of the message it just finished does not cause a second publish
    rig.dev.feed_bytes(encode_serial_frame(encode_mecon_frames(1, msg)[-1], DEV_SERIAL_MARKER))
    rig.step(10)
    assert rig.published() == [msg]


def test_publishes_are_qos1_not_retained_on_the_configured_topic():
    rig = Rig()
    rig.settle()
    rig.dev.feed_bytes(wire(b"{}"))
    rig.step(5)
    (r,) = rig.net.brokers["primary"].on_topic(rig.up)
    assert (r.topic, r.qos, r.retain) == ("test/dev-0000/up", 1, False)


# ---- upstream: no duplicates, no replay ---------------------------------------------------


def test_publish_in_doubt_at_disconnect_is_never_resent():
    rig = Rig()
    rig.settle()
    rig.net.brokers["primary"].next_publish = ["die_after_receive"]
    rig.dev.feed_bytes(wire(b"ENVELOPE-A"))
    rig.step(10)
    rig.step(400, dt=0.05)  # long enough to back off and reconnect
    assert rig.metrics.get("broker_connected") == 1
    assert rig.published() == [b"ENVELOPE-A"]  # the broker holds it once; the Connector did not send it again
    assert rig.metrics.get("upstream_uncertain_total") == 1
    assert rig.metrics.get("upstream_published_total") == 1


def test_publish_lost_before_the_broker_is_counted_not_replayed():
    rig = Rig()
    rig.settle()
    rig.net.brokers["primary"].next_publish = ["die_before_receive"]
    rig.dev.feed_bytes(wire(b"ENVELOPE-B"))
    rig.step(10)
    rig.step(400, dt=0.05)
    assert rig.published() == []
    assert rig.metrics.get("upstream_uncertain_total") == 1
    assert rig.metrics.get("upstream_dropped_total", "queue_full") == 0


def test_not_yet_sent_envelopes_wait_for_the_broker_and_go_once_in_order():
    rig = Rig()
    rig.net.brokers["primary"].up = False
    rig.step(3)
    for i in range(5):
        rig.dev.feed_bytes(wire(b"m%d" % i, i))
    rig.step(30)
    assert rig.bridge.snapshot()["upstream_queue"] == 5
    rig.net.brokers["primary"].up = True
    rig.step(400, dt=0.05)
    assert rig.published() == [b"m0", b"m1", b"m2", b"m3", b"m4"]
    assert rig.bridge.accounting_gap() == 0


def test_stale_envelope_expires_instead_of_going_out_late():
    rig = Rig()
    rig.net.brokers["primary"].up = False
    rig.step(3)
    rig.dev.feed_bytes(wire(b"old"))
    rig.step(5)
    rig.clock.advance(61)
    rig.net.brokers["primary"].up = True
    rig.step(400, dt=0.05)
    assert rig.published() == []
    assert rig.metrics.get("upstream_dropped_total", "ttl") == 1


# ---- bounded queues, counted drops --------------------------------------------------------


def test_queue_full_drops_newest_and_counts_each():
    cfg = make_cfg(queues={"upstream_max_messages": 4})
    rig = Rig(cfg=cfg)
    rig.net.brokers["primary"].up = False
    rig.step(3)
    for i in range(10):
        rig.dev.feed_bytes(wire(b"m%d" % i, i))
        rig.step(3)
    assert rig.metrics.get("upstream_dropped_total", "queue_full") == 6
    assert rig.metrics.get("upstream_queue_depth") == 4
    rig.net.brokers["primary"].up = True
    rig.step(400, dt=0.05)
    assert rig.published() == [b"m0", b"m1", b"m2", b"m3"]  # what was accepted first keeps its order
    assert rig.bridge.accounting_gap() == 0


def test_queue_byte_bound():
    cfg = make_cfg(queues={"upstream_max_bytes": 1024})
    rig = Rig(cfg=cfg)
    rig.net.brokers["primary"].up = False
    rig.step(3)
    for i in range(6):
        rig.dev.feed_bytes(wire(b"x" * 400, i))
        rig.step(30)
    assert rig.metrics.get("upstream_queue_bytes") <= 1024
    assert rig.metrics.get("upstream_dropped_total", "queue_full") == 4


def test_inflight_window_is_bounded():
    cfg = make_cfg(queues={"upstream_max_inflight": 2})
    rig = Rig(cfg=cfg)
    rig.settle()
    rig.net.brokers["primary"].next_publish = ["hold", "hold"]
    for i in range(5):
        rig.dev.feed_bytes(wire(b"m%d" % i, i))
        rig.step(3)
    assert rig.metrics.get("upstream_inflight") == 2
    assert len(rig.published()) == 2
    mid = rig.transport.pending_acks[0]
    rig.transport.ack(mid)
    rig.step(5)
    assert len(rig.published()) == 5  # the freed slot lets the rest go
    assert rig.metrics.get("upstream_acked_total") == 4 and rig.metrics.get("upstream_inflight") == 1


# ---- downlink ------------------------------------------------------------------------------


def test_downlink_subscription_is_qos0():
    rig = Rig()
    rig.settle()
    assert rig.transport._subs == [(rig.down, 0)]


def test_downlink_written_once_and_xid_advances():
    rig = Rig()
    rig.settle()
    for _ in range(3):
        rig.transport.deliver(rig.down, b'{"v":1,"id":"a","op":"hello"}')
        rig.step(2)
    xids = [w[4] for w in rig.dev.written]  # '<' len(2) 7f xid ...
    assert xids == [2, 3, 4]  # xid 1 was the enrolment request
    assert rig.metrics.get("downlink_written_total") == 3


def test_command_is_not_written_again_after_broker_reconnect():
    rig = Rig()
    rig.settle()
    rig.transport.deliver(rig.down, b'{"v":1,"id":"cmd-1","op":"device.reboot"}')
    rig.step(3)
    rig.transport.drop_session()
    rig.step(400, dt=0.05)
    assert rig.metrics.get("broker_connected") == 1
    assert len(rig.dev.written) == 1


def test_command_waiting_in_queue_when_broker_drops_is_written_at_most_once():
    rig = Rig()
    rig.settle()
    rig.transport.deliver(rig.down, b'{"id":"c"}')
    rig.transport.drop_session()
    rig.step(400, dt=0.05)
    assert len(rig.dev.written) <= 1


def test_command_dropped_when_serial_is_down_and_not_held_for_replug():
    rig = Rig()
    rig.settle()
    rig.opener.unplug()
    rig.step(3)
    rig.transport.deliver(rig.down, b'{"id":"c"}')
    rig.step(3)
    assert rig.metrics.get("downlink_closed_total") == 1  # the gate closed with the serial port
    new = rig.opener.plug()
    rig.step(200, dt=0.05)
    assert new.written == []


def test_stale_command_expires_instead_of_running_late():
    rig = Rig()
    rig.settle()
    rig.transport.deliver(rig.down, b'{"id":"c"}')
    rig.clock.advance(6)  # the loop was held up past the 5 s lifetime
    rig.step(2)
    assert rig.dev.written == []
    assert rig.metrics.get("downlink_dropped_total", "ttl") == 1


def test_write_failure_is_counted_and_never_retried():
    rig = Rig()
    rig.settle()
    rig.dev.fail_next_write = True
    rig.transport.deliver(rig.down, b'{"id":"c"}')
    rig.step(3)
    assert rig.metrics.get("downlink_write_failed_total") == 1
    new = rig.opener.plug()
    rig.step(200, dt=0.05)
    assert new.written == [] and rig.dev.written == []


def test_downlink_queue_bound_and_counts():
    cfg = make_cfg(queues={"downlink_max_messages": 2})
    rig = Rig(cfg=cfg)
    rig.settle()
    for i in range(5):
        rig.transport.deliver(rig.down, b'{"id":"%d"}' % i)
    rig.step(1)
    assert rig.metrics.get("downlink_dropped_total", "queue_full") == 3
    assert rig.metrics.get("downlink_written_total") == 2


def test_downlink_payload_is_not_modified():
    rig = Rig()
    rig.settle()
    msg = b'  {"id":"x"}\x00 \n '
    rig.transport.deliver(rig.down, msg)
    rig.step(3)
    sent = rig.dev.written_bytes
    assert sent[0] == 0x3C and sent[3:7] == b"\x7f\x02\x00\x01" and sent[7:] == msg


def test_other_topics_and_retained_are_ignored_or_refused():
    rig = Rig()
    rig.settle()
    rig.transport.deliver("test/other/down", b"{}")
    rig.transport.deliver(rig.down, b"{}", retain=True)
    rig.step(3)
    assert rig.dev.written == []
    assert rig.metrics.get("downlink_dropped_total", "retained") == 1


# ---- broker selection, backoff, failover --------------------------------------------------


def test_backoff_grows_to_cap_with_no_jitter():
    rig = Rig()
    rig.net.brokers["primary"].up = False
    seen = []
    last = rig.net.brokers["primary"].connects
    t0 = rig.clock.t
    for _ in range(4000):
        rig.step(dt=0.05)
        if rig.net.brokers["primary"].connects != last:
            last = rig.net.brokers["primary"].connects
            seen.append(round(rig.clock.t - t0))
            t0 = rig.clock.t
        if len(seen) >= 9:
            break
    gaps = seen[1:]
    assert gaps[:7] == [1, 2, 4, 8, 16, 32, 60]
    assert gaps[-1] == 60


def test_auth_refusal_backs_off_a_minute_or_more_and_never_connects():
    rig = Rig()
    rig.net.brokers["primary"].accept = "auth"
    rig.step(5)
    assert rig.net.brokers["primary"].connects == 1
    rig.step(1000, dt=0.05)  # 50 s
    assert rig.net.brokers["primary"].connects == 1
    assert not rig.bridge.snapshot()["ready"]
    assert rig.metrics.get("broker_connect_attempts_total", "auth") == 1


def test_tls_failure_fails_closed_with_long_cooldown():
    rig = Rig()
    rig.net.brokers["primary"].accept = "tls"
    rig.dev.feed_bytes(wire(b"data"))
    rig.step(2000, dt=0.05)
    assert rig.net.brokers["primary"].connects <= 2
    assert rig.published() == []
    assert rig.metrics.get("broker_connected") == 0


def test_fallback_when_primary_is_down_and_return_after_hold_down():
    rig = Rig(brokers=("primary", "backup"))
    rig.net.brokers["primary"].up = False
    rig.step(5)
    assert rig.bridge.snapshot()["broker_name"] == "backup"
    rig.dev.feed_bytes(wire(b"via-backup"))
    rig.step(5)
    assert rig.published("backup") == [b"via-backup"] and rig.published("primary") == []
    rig.net.brokers["primary"].up = True
    rig.step(int(30 / 0.05), dt=0.05)  # inside the hold-down: stays on backup
    assert rig.bridge.snapshot()["broker_name"] == "backup"
    rig.step(int(80 / 0.05), dt=0.05)
    assert rig.bridge.snapshot()["broker_name"] == "primary"
    assert rig.metrics.get("broker_failovers_total") >= 1
    rig.dev.feed_bytes(wire(b"via-primary"))
    rig.step(5)
    assert rig.published("primary") == [b"via-primary"]
    assert rig.published("backup") == [b"via-backup"]  # nothing was sent twice


# ---- return to a better broker: probe first, settle, then switch (make before break) ------


def _status_publishes(rig, broker):
    return len(rig.net.brokers[broker].on_topic(rig.status))


def test_dead_primary_over_ten_hold_downs_leaves_the_backup_session_alone():
    rig = Rig(brokers=("primary", "backup"))
    rig.net.brokers["primary"].up = False
    rig.step(5)
    assert rig.bridge.snapshot()["broker_name"] == "backup"
    rig.dev.feed_bytes(wire(b"one"))
    rig.step(5)
    backup_connects = rig.net.brokers["backup"].connects
    rig.step(int(10 * 60 / 0.05) + 100, dt=0.05)  # 10 hold-downs (60 s each)
    assert rig.metrics.get("broker_disconnects_total") == 0
    assert rig.metrics.get("upstream_uncertain_total") == 0
    assert rig.net.brokers["backup"].connects == backup_connects  # one session, never re-made
    assert _status_publishes(rig, "backup") == 1  # online once; no offline/online flaps
    assert json.loads(rig.net.brokers["backup"].retained[rig.status])["connector"] == "online"
    assert len(rig.transport.probe_calls) >= 10 and set(rig.transport.probe_calls) == {"primary"}
    assert rig.net.brokers["primary"].connects == 1  # only the first startup attempt; probes are not sessions
    assert rig.metrics.get("broker_connect_attempts_total", "probe") == len(rig.transport.probe_calls)
    assert rig.bridge._fails[0] >= 10
    rig.dev.feed_bytes(wire(b"two"))
    rig.step(5)
    assert rig.published("backup") == [b"one", b"two"]
    assert rig.bridge.accounting_gap() == 0


def test_failed_probes_back_off_with_the_better_brokers_failure_count():
    rig = Rig(brokers=("primary", "backup"))
    rig.net.brokers["primary"].up = False
    rig.step(5)
    rig.step(int(600 / 0.05), dt=0.05)
    # 10 minutes: backoff doubles to its 60 s cap, so far fewer probes than one per second
    assert 5 <= len(rig.transport.probe_calls) <= 20
    assert rig.metrics.get("broker_connect_attempts_total", "probe") == len(rig.transport.probe_calls)


def test_primary_returning_switches_within_one_hold_down_without_duplicate_or_loss():
    rig = Rig(brokers=("primary", "backup"))
    rig.net.brokers["primary"].up = False
    rig.step(5)
    rig.dev.feed_bytes(wire(b"before"))
    rig.step(5)
    rig.step(int(200 / 0.05), dt=0.05)  # several failed probes
    assert rig.bridge.snapshot()["broker_name"] == "backup"
    rig.net.brokers["primary"].up = True
    rig.step(int(61 / 0.05), dt=0.05)  # one hold-down
    assert rig.bridge.snapshot()["broker_name"] == "primary"
    rig.dev.feed_bytes(wire(b"after"))
    rig.step(5)
    assert rig.published("backup") == [b"before"] and rig.published("primary") == [b"after"]
    assert rig.metrics.get("upstream_uncertain_total") == 0
    assert rig.metrics.get("broker_disconnects_total") == 1  # the one deliberate switch
    assert rig.bridge.accounting_gap() == 0


def _backup_with_primary_returned(rig):
    rig.net.brokers["primary"].up = False
    rig.step(5)
    rig.net.brokers["primary"].up = True


def test_switch_waits_for_in_flight_publishes_to_settle():
    rig = Rig(brokers=("primary", "backup"))
    _backup_with_primary_returned(rig)
    rig.net.brokers["backup"].next_publish = ["hold"]
    rig.dev.feed_bytes(wire(b"in-flight"))
    rig.step(5)
    (mid,) = rig.transport.pending_acks
    for _ in range(int(70 / 0.05)):  # the hold-down passes, the probe succeeds, the bridge settles
        if rig.bridge._settle_since is not None:
            break
        rig.step(dt=0.05)
    assert rig.bridge._settle_since is not None
    assert rig.bridge.snapshot()["broker_name"] == "backup"  # still on the working session
    rig.dev.feed_bytes(wire(b"new-while-settling"))
    rig.step(20, dt=0.05)
    assert rig.published("backup") == [b"in-flight"]  # no new upstream publish is taken while settling
    rig.transport.ack(mid)
    rig.step(10, dt=0.05)
    assert rig.bridge.snapshot()["broker_name"] == "primary"
    assert rig.metrics.get("upstream_uncertain_total") == 0
    rig.step(5)
    assert rig.published("primary") == [b"new-while-settling"]  # held in the queue, sent once, on the better broker
    assert rig.bridge.accounting_gap() == 0


def test_unsettled_publish_at_the_bound_is_counted_uncertain_not_resent():
    rig = Rig(brokers=("primary", "backup"))
    _backup_with_primary_returned(rig)
    rig.net.brokers["backup"].next_publish = ["hold"]
    rig.dev.feed_bytes(wire(b"never-acked"))
    rig.step(5)
    rig.step(int(80 / 0.05), dt=0.05)
    assert rig.bridge.snapshot()["broker_name"] == "primary"
    assert rig.metrics.get("upstream_uncertain_total") == 1
    assert rig.published("backup") == [b"never-acked"] and rig.published("primary") == []
    assert rig.bridge.accounting_gap() == 0


def test_the_switch_ends_the_session_no_sooner_than_the_settle_bound():
    rig = Rig(brokers=("primary", "backup"))
    _backup_with_primary_returned(rig)
    rig.net.brokers["backup"].next_publish = ["hold"]
    rig.dev.feed_bytes(wire(b"slow"))
    rig.step(5)
    until = 0
    while rig.bridge._settle_since is None and until < 5000:
        rig.step(dt=0.05)
        until += 1
    assert rig.bridge._settle_since is not None
    start = rig.clock.t
    while rig.bridge.snapshot()["broker_name"] == "backup" and rig.clock.t - start < 30:
        rig.step(dt=0.05)
    assert 4.9 <= rig.clock.t - start <= 5.5


def test_failed_probe_does_not_touch_the_working_session():
    rig = Rig(brokers=("primary", "backup"))
    rig.net.brokers["primary"].accept = "auth"
    rig.step(5)
    sessions = rig.net.brokers["backup"].connects
    rig.step(int(130 / 0.05), dt=0.05)
    assert rig.net.brokers["backup"].connects == sessions
    assert rig.metrics.get("broker_connect_attempts_total", "probe") >= 1
    assert rig.metrics.get("broker_disconnects_total") == 0


def test_only_one_session_at_a_time():
    rig = Rig(brokers=("primary", "backup"))
    rig.settle()
    assert rig.transport.connect_calls == ["primary"]


def test_flapping_primary_cannot_cause_more_than_one_switch_per_hold_down():
    rig = Rig(brokers=("primary", "backup"))
    rig.net.brokers["primary"].up = False
    rig.step(5)
    rig.net.brokers["primary"].up = True
    start = len(rig.transport.connect_calls)
    rig.step(int(50 / 0.05), dt=0.05)
    assert len(rig.transport.connect_calls) == start  # nothing for 50 s < 60 s hold-down


def test_stable_session_resets_failure_count():
    rig = Rig()
    rig.settle()
    rig.step(int(40 / 0.05), dt=0.05)
    rig.transport.drop_session()
    rig.step(2)
    assert rig.bridge._fails[0] == 0
    rig.step(int(3 / 0.05), dt=0.05)
    assert rig.metrics.get("broker_connected") == 1


# ---- serial: discovery, unplug, replug, stall ---------------------------------------------


def test_starts_without_device_and_attaches_when_plugged():
    rig = Rig(plugged=False)
    rig.step(20)
    assert rig.metrics.get("serial_connected") == 0 and rig.bridge.snapshot()["broker"] == "connected"
    dev = rig.opener.plug()
    rig.step(200, dt=0.05)
    assert rig.metrics.get("serial_connected") == 1
    dev.feed_bytes(wire(b"hello"))
    rig.step(5)
    assert rig.published() == [b"hello"]
    assert status(rig)["serial"] == "up"


def test_unplug_discards_partial_frame_and_replug_resumes_cleanly():
    rig = Rig()
    rig.settle()
    full = wire(b"A" * 300)
    rig.dev.feed(full[: len(full) // 2])
    rig.step(3)
    rig.opener.unplug()
    rig.step(3)
    assert rig.metrics.get("serial_connected") == 0
    assert rig.metrics.get("serial_disconnects_total") == 1
    assert rig.metrics.get("serial_discarded_bytes_total", "unplug") > 0
    assert status(rig)["serial"] == "down"
    new = rig.opener.plug()
    rig.step(40, dt=0.05)
    assert rig.metrics.get("serial_reconnects_total") == 1
    new.feed_bytes(wire(b"B" * 10, 2))
    rig.step(5)
    assert rig.published() == [b"B" * 10]  # the half message from before is not completed or sent
    assert status(rig)["serial"] == "up"


def test_ambiguous_selector_fails_closed():
    rig = Rig(plugged=False)
    rig.opener.plug()
    rig.opener.ambiguous = True
    rig.step(100, dt=0.05)
    assert rig.metrics.get("serial_connected") == 0 and rig.opener.opens == 0


def test_stall_drops_the_partial_frame():
    rig = Rig()
    rig.settle()
    rig.dev.feed(bytes([0x3E, 100, 0]) + b"abc")
    rig.step(3)
    rig.clock.advance(2.5)
    rig.step(3)
    assert rig.metrics.get("serial_stall_resets_total") == 1
    assert rig.metrics.get("serial_discarded_bytes_total", "stall") == 6
    rig.dev.feed_bytes(wire(b"fresh"))
    rig.step(5)
    assert rig.published() == [b"fresh"]


def test_console_mode_end_to_end():
    rig = Rig(cfg=make_cfg(mode="console"))
    rig.settle()
    rig.dev.feed_bytes(b'mecon> \r\nmecon> {"v":1,"id":"c1"}\r', 3)
    rig.step(60)
    assert rig.published() == [b'{"v":1,"id":"c1"}']
    rig.transport.deliver(rig.down, b'{"v":1,"id":"c2","op":"hello"}')
    rig.step(3)
    assert rig.dev.written_bytes == b'mecon> {"v":1,"id":"c2","op":"hello"}\r'


# ---- shutdown, health ---------------------------------------------------------------------


def test_stop_drops_and_counts_queued_work_and_closes_serial():
    rig = Rig()
    rig.net.brokers["primary"].up = False
    rig.step(3)
    rig.dev.feed_bytes(wire(b"q1"))
    rig.step(5)
    rig.bridge.stop()
    assert rig.metrics.get("upstream_dropped_total", "shutdown") == 1
    assert rig.dev.closed
    rig.bridge.step()
    assert rig.net.brokers["primary"].connects == 1  # nothing restarts after stop


def test_health_snapshot_separates_stages():
    rig = Rig(plugged=False)
    rig.step(10)
    s = rig.bridge.snapshot()
    assert s["serial"] == "down" and s["broker"] == "connected" and not s["ready"]


def test_metrics_render_is_prometheus_text_with_prefix():
    rig = Rig()
    rig.settle()
    txt = rig.metrics.render()
    assert "# TYPE mecon_connector_upstream_dropped_total counter" in txt
    assert 'mecon_connector_upstream_dropped_total{reason="queue_full"} 0' in txt
