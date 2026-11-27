#!/usr/bin/env python3
"""Regenerates contracts/connector-hold/v1/fixtures/*.json (stdlib only, independent of the Connector).

Run from the repository root:   python3 connector/scripts/gen_hold_fixtures.py [--check]
--check writes nothing and fails if a file on disk differs from what this script would write.
Everything is synthetic: <token>, <issuer>, <sig> and <pubkey> stand for secrets and identifiers.
"""
import base64
import hashlib
import io
import json
import pathlib
import struct
import sys
import zipfile

OUT = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "connector-hold" / "v1" / "fixtures"
CONTRACT = "mecon-connector-hold/1.0.0-draft.5"


def j(o):
    return json.dumps(o, separators=(",", ":"))


def wrapper(rid, op, pad=""):
    body = j({"v": 1, "id": rid, "op": op, **({"pad": pad} if pad else {})})
    return j({"mecon_auth": 1, "issuer": "<issuer>", "sig": "<sig>", "body": body})


def result(rid, op, seq):
    return j({"v": 1, "id": rid, "op": op, "status": "ok", "usig_boot": 1, "usig_seq": seq, "result": {}, "usig": "<sig>"})


def event(seq, usig="<sig>"):
    return j({"v": 1, "ev": "health", "seq": seq, "epoch": 1, "ts": 1763539200, "data": {}, "usig": usig})


def frames_hex(wire: bytes, xid: int):
    n = -(-len(wire) // 168)
    return [bytes([0x7F, xid, i, n]).hex() + wire[i * 168 : (i + 1) * 168].hex() for i in range(n)]


HANDSHAKE_SUB = {"step": "handshake", "presentation": "subprotocol", "offered": ["mecon-bridge", "bearer.<token>"], "selected": "mecon-bridge"}
HANDSHAKE_HDR = {"step": "handshake", "presentation": "header", "offered": ["Authorization: Bearer <token>"], "selected": None}
HELLO = {"epoch": 1, "node_key": "<pubkey>", "device_id": "<device_id>"}


def prelude(ref=1):
    return [
        {"step": "send", "frame": {"type": "iface_relay"}},
        {"step": "send", "frame": {"type": "iface_hello", "ref": ref, "hello": HELLO}},
        {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_hello", "ref": ref, "outcome": "recorded"}},
    ]


# ---- fixtures G and H: a refusal right after the agent's own close (section 2.5). t is seconds from the start.

STALE = "another agent holds this device"


def at(step, t):
    return {**step, "t": t}


def refused_at(t):
    return [at(HANDSHAKE_HDR, t), {"step": "recv", "frame": {"type": "refused", "reason": STALE}},
            {"step": "close", "by": "backend", "code": 1008, "t": t}]


# ---- fixture F: bootloader serial DFU (section 12). Its own HCI/SLIP encoder, independent of the Connector's.

F_JOB = "fw-7"
F_IMAGE = bytes((i * 7 + 3) & 0xFF for i in range(1000))  # a synthetic application image: two data packets
F_INIT = bytes(range(0xC0, 0xC0 + 14))  # a synthetic init packet (.dat), with a C0 and a DB in it


def f_package():
    """A deterministic DFU zip (stored, fixed times), so its SHA-256 is stable."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name, data in (("manifest.json", j({"manifest": {"application": {"bin_file": "app.bin", "dat_file": "app.dat"}}}).encode()),
                           ("app.bin", F_IMAGE), ("app.dat", F_INIT)):
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.create_system = 3
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
    return buf.getvalue()


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def slip(data):
    return data.replace(b"\xdb", b"\xdb\xdd").replace(b"\xc0", b"\xdb\xdc")


def hci(seq, payload):
    n = len(payload)
    h = [seq | ((seq + 1) % 8) << 3 | 1 << 6 | 1 << 7, 14 | (n & 0xF) << 4, (n >> 4) & 0xFF]
    h.append(-sum(h) & 0xFF)
    body = bytes(h) + payload
    c = crc16(body)
    return b"\xc0" + slip(body + bytes((c & 0xFF, c >> 8))) + b"\xc0"


def ack(n):
    h = [n << 3, 0, 0]
    h.append(-sum(h) & 0xFF)
    return b"\xc0" + slip(bytes(h)) + b"\xc0"


def f_transfer():
    u32 = lambda v: struct.pack("<I", v)  # noqa: E731
    packets = [("start", u32(3) + u32(4) + u32(0) + u32(0) + u32(len(F_IMAGE))),
               ("init", u32(1) + F_INIT + b"\x00\x00")]
    packets += [("data", u32(4) + F_IMAGE[i : i + 512]) for i in range(0, len(F_IMAGE), 512)]
    packets.append(("stop", u32(5)))
    steps = []
    for k, (kind, payload) in enumerate(packets):
        seq = (k + 1) % 8
        steps.append({"step": "bootloader_write", "packet": kind, "seq": seq, "hex": hci(seq, payload).hex(),
                      "ack_hex": ack((seq + 1) % 8).hex()})
    return steps


def fixture(fid, title, description, link, steps):
    return {"contract": CONTRACT, "synthetic": True, "id": fid, "title": title, "description": description, "link": link, "steps": steps}


def build():
    out = {}
    wa = wrapper("j7", "status.get")
    ra = result("j7", "status.get", 8)
    out["A-companion-connect-hello-request-result.json"] = fixture(
        "A", "Connect, declare, hello, one request, one result (Companion)",
        "The subprotocol form is used; the server selects mecon-bridge and never echoes the token entry. The device link is up and the "
        "agent has already read the device's hello with a request of its own (not shown: it is the agent's traffic and is never uploaded).",
        "companion",
        [HANDSHAKE_SUB, *prelude(),
         {"step": "recv", "frame": {"type": "iface_req", "id": "j7", "wire": wa}},
         {"step": "device_write", "wire": wa},
         {"step": "device_read", "text": ra},
         {"step": "send", "frame": {"type": "iface_result", "ref": 2, "message": ra}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 2, "outcome": "status.get: ok"}}])
    out["B-refused-second-agent.json"] = fixture(
        "B", "Refusal of a second agent",
        "The handshake succeeds, then the Backend refuses the socket and closes it 1008. The agent stops, surfaces the reason and does not reconnect.",
        "none",
        [HANDSHAKE_HDR,
         {"step": "recv", "frame": {"type": "refused", "reason": "another agent holds this device"}},
         {"step": "close", "by": "backend", "code": 1008}])
    pad_wrapper = wrapper("j9", "status.get", "x")
    pad = "x" * (1 + 400 - len(pad_wrapper))
    wc = wrapper("j9", "status.get", pad)
    assert len(wc.encode()) == 400, len(wc.encode())
    out["C-companion-framing-400-bytes.json"] = fixture(
        "C", "Framing a 400-byte wire for a Companion (3 frames)",
        "Bytes 0..167, 168..335 and 336..399 of the wire become three frames 7F xid index count chunk. xid 05 is an example; any single byte, the same for all three frames.",
        "companion",
        [{"step": "recv", "frame": {"type": "iface_req", "id": "j9", "wire": wc}},
         {"step": "device_write", "wire": wc, "xid": 5, "frames_hex": frames_hex(wc.encode(), 5)}])
    wd = wrapper("j8", "hello")
    rd = j({"v": 1, "id": "j8", "op": "hello", "status": "ok", "result": {}, "usig": "<sig>"})
    out["D-console-request-and-result.json"] = fixture(
        "D", "The console request and result lines",
        "A bare CR once per link, then mecon> + wire + CR. The device echoes the prefix (skipped: it does not start with mecon> {) and answers on a line of its own.",
        "console",
        [HANDSHAKE_HDR, *prelude(),
         {"step": "recv", "frame": {"type": "iface_req", "id": "j8", "wire": wd}},
         {"step": "device_write", "hex": "0d", "note": "the bare CR, first request on the link only"},
         {"step": "device_write", "wire": wd},
         {"step": "device_line", "text": "mecon> ", "skipped": True},
         {"step": "device_line", "text": "[boot] radio ready", "skipped": True},
         {"step": "device_line", "text": "mecon> " + rd, "skipped": False},
         {"step": "send", "frame": {"type": "iface_result", "ref": 2, "message": rd}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 2, "outcome": "hello: confirmed"}}])
    e1, e2, bad = event(12), event(13), event(14, usig="<tampered>")
    out["E-event-forwarding-ack-outcomes.json"] = fixture(
        "E", "Event forwarding, duplicate, refusal and a stream that is not forwarded",
        "Each acknowledgement answers one upload. duplicate is success. An outcome starting with refused is not resent. An event whose ev is result is dropped by the agent and never sent.",
        "companion",
        [HANDSHAKE_SUB, *prelude(),
         {"step": "device_read", "text": e1},
         {"step": "send", "frame": {"type": "iface_event", "ref": 2, "stream": "health", "message": e1}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_event", "ref": 2, "outcome": "health: stored"}},
         {"step": "device_read", "text": e2},
         {"step": "send", "frame": {"type": "iface_event", "ref": 3, "stream": "health", "message": e2}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_event", "ref": 3, "outcome": "duplicate"}},
         {"step": "device_read", "text": bad},
         {"step": "send", "frame": {"type": "iface_event", "ref": 4, "stream": "health", "message": bad}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_event", "ref": 4, "outcome": "refused: signature does not verify"}},
         {"step": "device_read", "text": j({"v": 1, "ev": "result", "seq": 1, "epoch": 1, "usig": "<sig>"}), "not_sent": True},
         {"step": "recv", "frame": {"type": "registered", "id": 3}, "ignored": True}])
    pkg = f_package()
    offer = wrapper("j11", "update.offer")
    offered = j({"v": 1, "id": "j11", "op": "update.offer", "status": "ok", "usig_boot": 1, "usig_seq": 20,
                 "result": {"job": F_JOB, "state": "awaiting-confirm", "dfu": "serial"}, "usig": "<sig>"})
    hello2 = {"epoch": 2, "node_key": "<pubkey>", "device_id": "<device_id>"}
    relay_dfu = {"type": "iface_relay", "serial_dfu": True}
    out["F-serial-dfu.json"] = fixture(
        "F", "Bootloader serial DFU on a held device",
        "The agent declared serial_dfu. The Backend arms it with dfu_job; the agent fetches, checks and reads the package and says "
        "ready, and only then does the Backend relay the bootloader-dfu offer; the application port drops within the arming window, so the socket is kept and "
        "nothing is relayed. The agent opens the bootloader's own port and sends the package as HCI packets in SLIP frames (start, init, "
        "data, stop; every byte shown), then the application port returns and the agent declares and says hello again on the same "
        "socket. The offer's arguments are illustrative; the firmware's update contract is authoritative. The package is synthetic.",
        "companion",
        [HANDSHAKE_HDR,
         {"step": "send", "frame": relay_dfu},
         {"step": "send", "frame": {"type": "iface_hello", "ref": 1, "hello": HELLO}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_hello", "ref": 1, "outcome": "recorded"}},
         {"step": "recv", "frame": {"type": "dfu_job", "job": F_JOB, "sha256": hashlib.sha256(pkg).hexdigest(), "size": len(pkg)}},
         {"step": "send", "frame": {"type": "dfu_state", "job": F_JOB, "state": "fetching"}},
         {"step": "package_get", "path": f"/gateway/dfu-package/{F_JOB}", "authorization": "Bearer <token>", "status": 200,
          "size": len(pkg), "sha256": hashlib.sha256(pkg).hexdigest(), "body_base64": base64.b64encode(pkg).decode()},
         {"step": "send", "frame": {"type": "dfu_state", "job": F_JOB, "state": "ready"}},
         {"step": "recv", "frame": {"type": "iface_req", "id": "j11", "wire": offer}},
         {"step": "device_write", "wire": offer},
         {"step": "device_read", "text": offered},
         {"step": "send", "frame": {"type": "iface_result", "ref": 2, "message": offered}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 2, "outcome": "update.offer: ok"}},
         {"step": "device_link", "port": "application", "event": "lost"},
         {"step": "send", "frame": {"type": "dfu_state", "job": F_JOB, "state": "waiting-bootloader"}},
         {"step": "device_link", "port": "bootloader", "event": "opened"},
         {"step": "send", "frame": {"type": "dfu_state", "job": F_JOB, "state": "transferring"}},
         *f_transfer(),
         {"step": "device_link", "port": "bootloader", "event": "closed"},
         {"step": "send", "frame": {"type": "dfu_state", "job": F_JOB, "state": "rebooting"}},
         {"step": "device_link", "port": "application", "event": "opened"},
         {"step": "send", "frame": {"type": "dfu_state", "job": F_JOB, "state": "installed-pending-hello"}},
         {"step": "send", "frame": relay_dfu},
         {"step": "send", "frame": {"type": "iface_hello", "ref": 3, "hello": hello2}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_hello", "ref": 3, "outcome": "recorded"}}])
    stranded = {"type": "dfu_state", "job": F_JOB, "state": "needs-uf2-recovery", "sent": 689, "total": 1358}
    out["I-needs-uf2-recovery.json"] = fixture(
        "I", "A board that needs a UF2 copy, reported on a new socket and ended by the hello",
        "A serial DFU was interrupted after data writing began (689 of 1358 data packets acknowledged), and the agent recorded it "
        "locally. The process has since restarted: the application port is absent and the bootloader's port is listed. On the new "
        "socket the agent declares, reports the device as being in its bootloader and the needs-uf2-recovery state, and sends the "
        "dfu_state. A dfu_job for another job is answered with the same state for that job id: nothing is fetched and no serial "
        "transfer starts. The operator copies the release's recovery UF2 to the board; the application port returns, the agent "
        "declares and says hello again, and the record ends with that hello. The Backend confirms the version from the hello.",
        "companion",
        [HANDSHAKE_HDR,
         {"step": "send", "frame": {"type": "iface_relay", "serial_dfu": True}},
         {"step": "device_link", "port": "application", "event": "absent"},
         {"step": "device_link", "port": "bootloader", "event": "present"},
         {"step": "send", "frame": {"type": "connector_device", "device": "bootloader", "dfu_state": "needs-uf2-recovery",
                                    "job": F_JOB, "sent": 689, "total": 1358}},
         {"step": "send", "frame": stranded},
         {"step": "recv", "frame": {"type": "dfu_job", "job": "fw-8", "sha256": hashlib.sha256(pkg).hexdigest(), "size": len(pkg)}},
         {"step": "send", "frame": {**stranded, "job": "fw-8"}},
         {"step": "device_link", "port": "application", "event": "opened"},
         {"step": "send", "frame": {"type": "iface_relay", "serial_dfu": True}},
         {"step": "send", "frame": {"type": "iface_hello", "ref": 1, "hello": hello2}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_hello", "ref": 1, "outcome": "recorded"}},
         {"step": "send", "frame": {"type": "connector_device", "device": "application"}}])
    own_close = {"step": "close", "by": "network", "code": 1006, "t": 60}
    out["G-refused-after-own-close-retried.json"] = fixture(
        "G", "A refusal right after the agent's own close is retried",
        "The hold is up. At 60 s the network ends it (no close frame: 1006). The agent reconnects on the normal backoff, 1 s "
        "later, and the Backend, which has not yet noticed that the old socket is gone, refuses it: another agent holds this "
        "device. The refusal came within 30 s of the agent's own close, so the agent retries on the backoff, 1 s later, and "
        "is let in; it declares and says hello again on the new socket. Frames the agent may have sent on a refused socket "
        "before the refusal reached it are not shown, so the ref values after it are examples of a ref that grows.",
        "companion",
        [at(HANDSHAKE_HDR, 0), *prelude(1), own_close, *refused_at(61), at(HANDSHAKE_HDR, 62), *prelude(2)])
    out["H-refused-after-own-close-three-retries-then-stop.json"] = fixture(
        "H", "Three retries after the agent's own close, then the fourth refusal stops it",
        "As G, but the Backend keeps refusing. The agent retries 1, 2 and 4 s after each refusal (all within 30 s of its own "
        "close at 60 s); the fourth refusal, at 68 s, is a stop: the agent surfaces the reason and does not reconnect.",
        "companion",
        [at(HANDSHAKE_HDR, 0), *prelude(1), own_close, *refused_at(61), *refused_at(62), *refused_at(64), *refused_at(68)])
    out["invalid-frames.json"] = {
        "contract": CONTRACT, "synthetic": True, "id": "invalid", "title": "Frames the schemas must reject",
        "description": "Each frame must fail the schema of its direction and type.",
        "cases": [
            {"direction": "agent_to_backend", "why": "iface_result without a message", "frame": {"type": "iface_result", "ref": 1}},
            {"direction": "agent_to_backend", "why": "iface_result with an empty message", "frame": {"type": "iface_result", "ref": 1, "message": ""}},
            {"direction": "agent_to_backend", "why": "iface_result message over 8192 characters", "frame": {"type": "iface_result", "ref": 1, "message": "a" * 8193}},
            {"direction": "agent_to_backend", "why": "iface_event with stream result", "frame": {"type": "iface_event", "ref": 1, "stream": "result", "message": "{}"}},
            {"direction": "agent_to_backend", "why": "iface_event with an upper-case stream", "frame": {"type": "iface_event", "ref": 1, "stream": "Health", "message": "{}"}},
            {"direction": "agent_to_backend", "why": "iface_event with a stream of 33 characters", "frame": {"type": "iface_event", "ref": 1, "stream": "a" * 33, "message": "{}"}},
            {"direction": "agent_to_backend", "why": "iface_event with a digit first", "frame": {"type": "iface_event", "ref": 1, "stream": "1a", "message": "{}"}},
            {"direction": "agent_to_backend", "why": "iface_hello without ref", "frame": {"type": "iface_hello", "hello": {}}},
            {"direction": "agent_to_backend", "why": "iface_hello whose hello is not an object", "frame": {"type": "iface_hello", "ref": 1, "hello": "x"}},
            {"direction": "agent_to_backend", "why": "iface_relay with an extra member", "frame": {"type": "iface_relay", "gateway_id": 1}},
            {"direction": "agent_to_backend", "why": "iface_relay with the wrong type", "frame": {"type": "relay"}},
            {"direction": "backend_to_agent", "why": "iface_req without wire", "frame": {"type": "iface_req", "id": "j1"}},
            {"direction": "backend_to_agent", "why": "iface_req with an id over 32 characters", "frame": {"type": "iface_req", "id": "j" * 33, "wire": "{}"}},
            {"direction": "backend_to_agent", "why": "iface_req with a space in the id", "frame": {"type": "iface_req", "id": "j 1", "wire": "{}"}},
            {"direction": "backend_to_agent", "why": "iface_req with a non-string wire", "frame": {"type": "iface_req", "id": "j1", "wire": {"v": 1}}},
            {"direction": "backend_to_agent", "why": "iface_ack without an outcome", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 1}},
            {"direction": "backend_to_agent", "why": "iface_ack with a numeric outcome", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 1, "outcome": 1}},
            {"direction": "backend_to_agent", "why": "refused without a reason", "frame": {"type": "refused"}},
            {"direction": "agent_to_backend", "why": "iface_relay with serial_dfu false (absent means no)", "frame": {"type": "iface_relay", "serial_dfu": False}},
            {"direction": "backend_to_agent", "why": "dfu_job with an upper-case sha256", "frame": {"type": "dfu_job", "job": "fw-1", "sha256": "A" * 64, "size": 10}},
            {"direction": "backend_to_agent", "why": "dfu_job with a size of 0", "frame": {"type": "dfu_job", "job": "fw-1", "sha256": "a" * 64, "size": 0}},
            {"direction": "backend_to_agent", "why": "dfu_job whose job is not one path segment", "frame": {"type": "dfu_job", "job": "../fw", "sha256": "a" * 64, "size": 10}},
            {"direction": "backend_to_agent", "why": "dfu_job without a sha256", "frame": {"type": "dfu_job", "job": "fw-1", "size": 10}},
            {"direction": "agent_to_backend", "why": "dfu_state with an unknown state", "frame": {"type": "dfu_state", "job": "fw-1", "state": "done"}},
            {"direction": "agent_to_backend", "why": "dfu_state failed without a stage", "frame": {"type": "dfu_state", "job": "fw-1", "state": "failed", "error": "no-ack"}},
            {"direction": "agent_to_backend", "why": "dfu_state with a stage on a state that is not failed", "frame": {"type": "dfu_state", "job": "fw-1", "state": "transferring", "stage": "transfer", "error": "x"}},
            {"direction": "agent_to_backend", "why": "dfu_state ready with a stage", "frame": {"type": "dfu_state", "job": "fw-1", "state": "ready", "stage": "fetch", "error": "x"}},
            {"direction": "agent_to_backend", "why": "dfu_state needs-uf2-recovery without sent and total", "frame": {"type": "dfu_state", "job": "fw-1", "state": "needs-uf2-recovery"}},
            {"direction": "agent_to_backend", "why": "dfu_state needs-uf2-recovery with a stage", "frame": {"type": "dfu_state", "job": "fw-1", "state": "needs-uf2-recovery", "sent": 5, "total": 9, "stage": "transfer", "error": "x"}},
            {"direction": "agent_to_backend", "why": "dfu_state failed with sent and total", "frame": {"type": "dfu_state", "job": "fw-1", "state": "failed", "stage": "transfer", "error": "no-ack", "sent": 5, "total": 9}},
            {"direction": "agent_to_backend", "why": "connector_device with a device that is not one of the three", "frame": {"type": "connector_device", "device": "uf2"}},
            {"direction": "agent_to_backend", "why": "dfu_state with an extra member", "frame": {"type": "dfu_state", "job": "fw-1", "state": "rebooting", "progress": 50}},
        ],
    }
    return out


def main():
    check = "--check" in sys.argv
    bad = 0
    OUT.mkdir(parents=True, exist_ok=True)
    built = build()
    for name, doc in built.items():
        text = json.dumps(doc, indent=2) + "\n"
        p = OUT / name
        if check:
            if not p.exists() or p.read_text() != text:
                print(f"differs: {name}")
                bad += 1
        else:
            p.write_text(text)
    if check:
        extra = {f.name for f in OUT.glob("*.json")} - set(built)
        for name in sorted(extra):
            print(f"not generated: {name}")
            bad += 1
    print("ok" if not bad else f"{bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
