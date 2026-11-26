#!/usr/bin/env python3
"""Writes the synthetic C0 fixtures. Stdlib only and independent of the Connector code:
the wrapper and interface frames are built here from the byte layout in the public
firmware docs, so the Connector's codec is checked against a second implementation.

    python3 connector/scripts/gen_fixtures.py
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "connector" / "v1" / "fixtures"
CONTRACT = "mecon-usb-connector/1.0.0-draft.2"
NOTE = "Synthetic test data. No real device id, key, signature or credential."


def wrap(payload: bytes, marker=0x3E) -> bytes:
    return bytes([marker, len(payload) & 255, len(payload) >> 8]) + payload


def iface(xid, index, count, body: bytes) -> bytes:
    return bytes([0x7F, xid, index, count]) + body


def split(msg: bytes, xid: int):
    n = max(1, -(-len(msg) // 168))
    return [iface(xid, i, n, msg[i * 168 : (i + 1) * 168]) for i in range(n)]


def env(i, pad=0):
    return json.dumps({"v": 1, "id": f"syn-{i}", "op": "hello", "args": {"pad": "x" * pad}}, separators=(",", ":")).encode()


def h(b: bytes) -> str:
    return b.hex()


def pub(payload: bytes, topic="{resp}"):
    """topic is "{resp}" or "{ev:<name>}": the contract's names for {topic_root}/resp and {topic_root}/ev/<name>."""
    return {"topic": topic, "payload_hex": h(payload), "qos": 1, "retain": False}


M1, M2 = env(1), env(2)
M_BIG = env(3, 400)  # 3 frames
fw_msg = json.dumps({"v": 1, "id": "fx-frames", "op": "hello", "args": {"pad": "x" * 300}}, separators=(",", ":")).encode()
up = []


def case(cid, desc, mode, chunks, publishes, metrics=None, chunkings=("whole", "bytes", 7), **extra):
    c = {"id": cid, "description": desc, "mode": mode, "serial_chunks_hex": [h(x) for x in chunks],
         "chunkings": list(chunkings), "expect": {"publishes": publishes, "metrics": metrics or {}}}
    c.update(extra)
    up.append(c)


big = split(M_BIG, 9)
case("companion-single-frame", "One interface frame (count 1) becomes one publish of the message bytes.", "companion",
     [wrap(split(M1, 1)[0])], [pub(M1)], {"serial_frames_total/mecon_frame": 1})
case("companion-three-frames-in-order", "Three frames of one message are reassembled and published once, unchanged.", "companion",
     [wrap(f) for f in big], [pub(M_BIG)], {"serial_frames_total/mecon_frame": 3})
case("companion-frames-out-of-order", "Frames may arrive in any order (device interface section 7); one publish.", "companion",
     [wrap(big[2]), wrap(big[0]), wrap(big[1])], [pub(M_BIG)])
case("companion-two-messages-coalesced", "Two messages in one read: two publishes, in order.", "companion",
     [wrap(split(M1, 1)[0]) + wrap(split(M2, 2)[0])], [pub(M1), pub(M2)], chunkings=("whole", "bytes", 5))
case("companion-garbage-between-frames", "Bytes outside a frame are skipped and counted, never forwarded.", "companion",
     [b"\x00\xffboot text\r\n" + wrap(split(M1, 1)[0]) + b"\x12\x34" + wrap(split(M2, 2)[0])], [pub(M1), pub(M2)],
     {"serial_discarded_bytes_total/garbage": 15})
case("companion-oversize-length-resync", "A length above 176 is refused at once; the next valid frame is found without waiting for 255 bytes.",
     "companion", [bytes([0x3E, 0xFF, 0x00]) + wrap(split(M1, 1)[0])], [pub(M1)],
     {"serial_anomalies_total/oversize_length": 1})
case("companion-oversize-length-ffff", "Length 65535: refused, the stream recovers, buffer never grows.", "companion",
     [bytes([0x3E, 0xFF, 0xFF]) + b"\x41" * 300 + wrap(split(M1, 1)[0])], [pub(M1)],
     {"serial_anomalies_total/oversize_length": 1}, chunkings=("whole", 7))
case("companion-native-frame-not-forwarded", "A native Companion frame (first byte is not 0x7f) is classified and dropped, not published.",
     "companion", [wrap(b"\x05" + b"\x01" * 9), wrap(split(M1, 1)[0])], [pub(M1)],
     {"serial_frames_total/native": 1, "serial_discarded_bytes_total/native": 10})
case("companion-repeated-frame-ignored", "A repeated frame of an incomplete message is ignored; one publish.", "companion",
     [wrap(big[0]), wrap(big[0]), wrap(big[1]), wrap(big[2])], [pub(M_BIG)], {"serial_anomalies_total/duplicate_frame": 1})
case("companion-repeat-after-complete-ignored", "A frame repeated after its message completed does not publish it again.", "companion",
     [wrap(split(M1, 4)[0]), wrap(split(M1, 4)[0])], [pub(M1)], {"serial_anomalies_total/duplicate_frame": 1})
case("companion-new-xid-discards-incomplete", "A frame for a new xid drops the incomplete message; only the complete one is published.", "companion",
     [wrap(big[0]), wrap(split(M2, 20)[0])], [pub(M2)], {"serial_anomalies_total/incomplete_discarded": 1})
case("companion-zero-length-frame", "A zero-length wrapper is skipped.", "companion",
     [bytes([0x3E, 0, 0]) + wrap(split(M1, 1)[0])], [pub(M1)], {"serial_anomalies_total/empty_frame": 1})
case("companion-malformed-count", "count 0 and index >= count are refused.", "companion",
     [wrap(iface(1, 0, 0, b"x")), wrap(iface(1, 3, 2, b"x")), wrap(split(M1, 2)[0])], [pub(M1)],
     {"serial_anomalies_total/malformed_frame": 2})
case("companion-short-nonlast-frame", "A non-final frame must carry exactly 168 bytes; a short one is malformed.", "companion",
     [wrap(iface(1, 0, 2, b"x" * 100)), wrap(split(M1, 2)[0])], [pub(M1)], {"serial_anomalies_total/malformed_frame": 1})
case("companion-wrong-marker-ignored", "A frame marked '<' (host to device) on the device-to-host stream is not a frame.", "companion",
     [wrap(split(M1, 1)[0], marker=0x3C), wrap(split(M2, 2)[0])], [pub(M2)])

# Cross-check against the public firmware's own fixture (docs/contract/fixtures/framing.json): same message, same frames.
FW_MSG = (b'{"v":1,"id":"fx-frames","op":"hello","args":{"pad":"' + b"x" * 300 + b'"}}')
fw = split(FW_MSG, 5)
assert len(fw) == 3 and fw[0].hex().startswith("7f0500037b2276223a312c226964223a2266782d6672616d6573222c226f70223a2268656c6c6f22")
case("companion-firmware-framing-fixture", "The message and frames of mecon-firmware docs/contract/fixtures/framing.json (xid 5), wrapped for the wire.",
     "companion", [wrap(f) for f in fw], [pub(FW_MSG)], source="hoejriis/mecon-firmware 0a9747b090d22f3756d48dee586061ff6287327c docs/contract/fixtures/framing.json")

raw_bytes = bytes([0x7B, 0x22, 0x00, 0x0D, 0x0A, 0xE2, 0x82, 0xAC, 0x20, 0x20, 0x0A, 0x7D, 0x20])
case("companion-opaque-bytes-unroutable", "Not valid JSON, with NUL, CR, LF, UTF-8 and trailing spaces: it has no route, so it is dropped and counted, never published and never altered.",
     "companion", [wrap(split(raw_bytes, 1)[0])], [], {"upstream_dropped_total/unroutable": 1})

# ---- routing: the topic is chosen from the parsed envelope; the bytes published are the device's own ----
def js(o) -> bytes:
    return json.dumps(o, separators=(",", ":")).encode()


E_HEALTH = js({"v": 1, "ev": "health", "epoch": 4, "seq": 1, "data": {"pad": "\u00e6 "}, "usig": "U1lO"})
E_RADIO = js({"v": 1, "ev": "radio", "epoch": 4, "seq": 2, "data": {}, "usig": "U1lO"})
R_STR = js({"v": 1, "id": "syn-r1", "status": "ok", "result": {}, "usig": "U1lO"})
R_INT = js({"v": 1, "id": 7, "status": "ok", "result": {}})
BOTH = js({"v": 1, "ev": "power", "id": "syn-x", "epoch": 4, "seq": 3})
case("companion-event-goes-to-its-ev-topic", "A message with an `ev` member goes to {topic_root}/ev/<ev>; a response with an `id` goes to {topic_root}/resp. Bytes unchanged.",
     "companion", [wrap(split(E_HEALTH, 1)[0]), wrap(split(R_STR, 2)[0]), wrap(split(E_RADIO, 3)[0])],
     [pub(E_HEALTH, "{ev:health}"), pub(R_STR), pub(E_RADIO, "{ev:radio}")])
case("companion-integer-id-is-a-response", "An integer `id` is a response too.", "companion",
     [wrap(split(R_INT, 1)[0])], [pub(R_INT)])
case("companion-ev-wins-over-id", "A message with both `ev` and `id` is an event.", "companion",
     [wrap(split(BOTH, 1)[0])], [pub(BOTH, "{ev:power}")])
UNROUTABLE = [
    js({"v": 1, "status": "ok"}),  # neither id nor ev
    js({"v": 1, "ev": "a/b", "seq": 1}),  # a topic separator in the name
    js({"v": 1, "ev": "+", "seq": 1}),  # a wildcard
    js({"v": 1, "ev": "#", "seq": 1}),
    js({"v": 1, "ev": "", "seq": 1}),
    js({"v": 1, "ev": 5, "seq": 1}),
    js({"v": 1, "ev": "x" * 33, "seq": 1}),
    js({"v": 1, "ev": "bad", "id": "syn-y"}) .replace(b'"bad"', b'"b d"'),  # an unsafe ev never falls back to resp
    js({"v": 1, "id": ""}),
    js({"v": 1, "id": None}),
    js({"v": 1, "id": True}),
    b"[1,2,3]",
    b"not json at all",
]
case("companion-unroutable-dropped-and-counted", "A message with no route (no id, no safe ev, not an object) is dropped and counted as unroutable; a following routable message is unaffected.", "companion",
     [wrap(split(m, 1 + i)[0]) for i, m in enumerate(UNROUTABLE)] + [wrap(split(R_STR, 30)[0])],
     [pub(R_STR)], {"upstream_dropped_total/unroutable": len(UNROUTABLE)})


def line(b: bytes, term=b"\r") -> bytes:
    return b"mecon> " + b + term


C1, C2 = env(11), env(12)
case("console-line-cr", "A `mecon> {` line ended by CR becomes one publish of the text after the prefix.", "console",
     [line(C1)], [pub(C1)], {"serial_frames_total/console_line": 1})
case("console-line-lf-and-crlf", "LF, CRLF and CR all end a line; empty lines are ignored.", "console",
     [line(C1, b"\n") + line(C2, b"\r\n")], [pub(C1), pub(C2)])
case("console-echo-and-logs-skipped", "Echo of the prefix, log lines and stock CLI replies are skipped, not forwarded.", "console",
     [b"mecon> \r\nINFO boot ok\r\n> clock 123\r\n" + line(C1) + b"mecon> not json\r\n"], [pub(C1)],
     {"serial_discarded_bytes_total/garbage": 7 + 12 + 11 + 15})
case("console-trailing-space-preserved", "Only the terminator is removed; a trailing space is part of the message.", "console",
     [line(C1 + b" ")], [pub(C1 + b" ")])
def sized(total, tag):
    head, tail = b'{"v":1,"id":"' + tag + b'","pad":"', b'"}'
    return head + b"y" * (total - 7 - len(head) - len(tail)) + tail


at_limit = sized(1607, b"syn-lim")
assert len(at_limit) == 1600
case("console-line-at-limit", "A 1600-byte message after the prefix (a 1607-byte line) is accepted.", "console", [line(at_limit)], [pub(at_limit)],
     chunkings=("whole", 7, 500))
over = sized(1608, b"syn-over")
assert len(over) == 1601
case("console-line-over-limit", "A 1601-byte message after the prefix is refused without buffering it; the next line is read normally.", "console",
     [line(over) + line(C1)], [pub(C1)], {"serial_anomalies_total/console_oversize_line": 1}, chunkings=("whole", 7, 500))
case("console-unterminated-flood", "A long run with no terminator never grows the buffer; recovery on the next line.", "console",
     [b"mecon> {" + b"z" * 5000 + b"\r" + line(C1)], [pub(C1)], {"serial_anomalies_total/console_oversize_line": 1},
     chunkings=("whole", 64))

(OUT / "upstream.json").write_text(json.dumps({"contract": CONTRACT, "synthetic": True, "note": NOTE, "direction": "device_to_broker", "cases": up}, indent=1) + "\n")

# ---- downlink ----------------------------------------------------------------------------
dn = []


def dcase(cid, desc, mode, inbound, serial_hex=None, dropped=None, retain=False, written=True):
    c = {"id": cid, "description": desc, "mode": mode,
         "inbound": {"topic": "{req}", "payload_hex": h(inbound), "retain": retain},
         "expect": {"serial_written_hex": serial_hex, "dropped_reason": dropped}}
    dn.append(c)


D1 = env(21)
D_BIG = env(22, 300)
dcase("companion-single-frame", "A downlink message is wrapped as one interface frame (count 1) with the '<' marker. The xid is 2 because the enrolment request (deployment.get) used xid 1.", "companion", D1,
      h(wrap(iface(2, 0, 1, D1), marker=0x3C)))
fr = split(D_BIG, 2)
dcase("companion-multi-frame", "A larger message is split into 168-byte interface frames, each wrapped.", "companion", D_BIG,
      h(b"".join(wrap(f, marker=0x3C) for f in fr)))
dcase("console-line", "Console mode writes `mecon> ` + message + CR in one write.", "console", D1, h(b"mecon> " + D1 + b"\r"))
dcase("console-embedded-newline-refused", "A message with CR or LF would split into several console lines: refused, not rewritten.",
      "console", b'{"v":1,\n"id":"x"}', None, "invalid")
dcase("retained-refused", "A retained message would run again at every reconnect: never written.", "companion", D1, None, "retained", retain=True)
dcase("empty-refused", "An empty message is refused.", "companion", b"", None, "invalid")
dcase("too-large-refused", "Above max_downlink_bytes is refused (default 1536 companion).", "companion", b"x" * 1537, None, "too_large")
(OUT / "downlink.json").write_text(json.dumps({"contract": CONTRACT, "synthetic": True, "note": NOTE, "direction": "broker_to_device", "cases": dn}, indent=1) + "\n")

# ---- enrolment gate --------------------------------------------------------------------
PROBE = b'{"v":1,"id":"cg-1","op":"deployment.get"}'
PROBE_HEX = {"companion": h(wrap(iface(1, 0, 1, PROBE), marker=0x3C)), "console": h(b"mecon> " + PROBE + b"\r")}
gt = []


def gcase(cid, desc, mode, enrolment, gate_open, probe_result, then=None, upstream=0):
    gt.append({"id": cid, "description": desc, "mode": mode, "enrolment": enrolment,
               "expect": {"probe_request_hex": PROBE_HEX[mode], "gate_open": gate_open, "probe_result": probe_result,
                          "upstream_publishes": upstream}, "then": then or []})


gcase("provisioned-opens", "Only result.state \"provisioned\" opens downlink; the request is a read and never goes upstream.", "companion", "provisioned", True, "provisioned")
gcase("provisioned-opens-console", "The same on a console, as one `mecon> ` line.", "console", "provisioned", True, "provisioned")
for st, res in (("none", "none"), ("corrupt", "corrupt"), ("refused", "refused"), ("bad_state", "malformed"), ("silent", "timeout"), ("garbage", "timeout")):
    gcase("closed-" + st.replace("_", "-"), f"Device answer '{st}' keeps downlink closed (fails closed)." + (" Bytes that do not parse have no route, so they are dropped and counted as unroutable." if st == "garbage" else ""),
          "companion", st, False, res, upstream=0)


def probe(after_s, answer, result, gate_open_after):
    return {"probe_after_s": after_s, "enrolment_after": answer, "probe_result_after": result, "gate_open_after": gate_open_after}


gcase("closed-busy", "Device answer 'busy' (no memory) changes nothing: a closed gate stays closed and is asked again after busy_retry_s.",
      "companion", "busy", False, "busy")
gcase("closed-failed", "Device answer 'failed' (storage) changes nothing below failed_threshold: a closed gate stays closed.",
      "companion", "failed", False, "failed")
gcase("busy-keeps-an-open-gate-open", "A busy answer to a recheck is not 'not provisioned': the gate stays open and is asked again after busy_retry_s (3 s).",
      "companion", "provisioned", True, "provisioned",
      [probe(600, "busy", "busy", True), probe(3, "busy", "busy", True), probe(3, "provisioned", "provisioned", True)])
gcase("failed-closes-at-the-threshold", "failed answers keep the gate open until failed_threshold (3) of them come in a row, asked again after retry_s.",
      "companion", "provisioned", True, "provisioned",
      [probe(600, "failed", "failed", True), probe(30, "failed", "failed", True), probe(30, "failed", "failed", False)])
gcase("failed-run-ends-on-provisioned", "A provisioned answer between failed answers starts the count again; a busy answer neither counts nor ends the run.",
      "companion", "provisioned", True, "provisioned",
      [probe(600, "failed", "failed", True), probe(30, "busy", "busy", True), probe(3, "failed", "failed", True),
       probe(30, "provisioned", "provisioned", True), probe(600, "failed", "failed", True), probe(30, "failed", "failed", True)])
gcase("refused-closes-at-once", "Any other status is a real refusal and closes an open gate at once.",
      "companion", "provisioned", True, "provisioned", [probe(600, "refused", "refused", False)])
gcase("unsigned-uplink-closes", "The first uplink message without usig closes downlink at once; it is still forwarded unchanged.", "companion", "provisioned", True, "provisioned",
      [{"uplink": "signed_event", "enrolment_after": None, "gate_open_after": True, "forwarded": True},
       {"uplink": "unsigned_event", "enrolment_after": "none", "gate_open_after": False, "forwarded": True}])
gcase("new-epoch-closes-and-rechecks", "A new epoch (a reboot) closes downlink and asks again; the device still answers provisioned, so it reopens.", "companion", "provisioned", True, "provisioned",
      [{"uplink": "new_epoch_event", "enrolment_after": None, "gate_open_after": True, "forwarded": True}])
(OUT / "gate.json").write_text(json.dumps({"contract": CONTRACT, "synthetic": True, "note": NOTE, "direction": "enrolment_gate", "cases": gt}, indent=1) + "\n")
print("wrote", len(up), "upstream and", len(dn), "downlink cases")
