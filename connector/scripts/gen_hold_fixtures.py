#!/usr/bin/env python3
"""Regenerates contracts/connector-hold/v1/fixtures/*.json (stdlib only, independent of the Connector).

Run from the repository root:   python3 connector/scripts/gen_hold_fixtures.py [--check]
--check writes nothing and fails if a file on disk differs from what this script would write.
Everything is synthetic: <token>, <issuer>, <sig> and <pubkey> stand for secrets and identifiers.
"""
import json
import pathlib
import sys

OUT = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "connector-hold" / "v1" / "fixtures"
CONTRACT = "mecon-connector-hold/1.0.0-draft.1"


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
HELLO = {"epoch": 1, "node_public_key_hex": "<pubkey>"}


def prelude():
    return [
        {"step": "send", "frame": {"type": "iface_relay"}},
        {"step": "send", "frame": {"type": "iface_hello", "ref": 1, "hello": HELLO}},
        {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_hello", "ref": 1, "outcome": "recorded"}},
    ]


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
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 2, "outcome": "recorded"}}])
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
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_result", "ref": 2, "outcome": "recorded"}}])
    e1, e2, bad = event(12), event(13), event(14, usig="<tampered>")
    out["E-event-forwarding-ack-outcomes.json"] = fixture(
        "E", "Event forwarding, duplicate, refusal and a stream that is not forwarded",
        "Each acknowledgement answers one upload. duplicate is success. An outcome starting with refused is not resent. An event whose ev is result is dropped by the agent and never sent.",
        "companion",
        [HANDSHAKE_SUB, *prelude(),
         {"step": "device_read", "text": e1},
         {"step": "send", "frame": {"type": "iface_event", "ref": 2, "stream": "health", "message": e1}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_event", "ref": 2, "outcome": "recorded"}},
         {"step": "device_read", "text": e2},
         {"step": "send", "frame": {"type": "iface_event", "ref": 3, "stream": "health", "message": e2}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_event", "ref": 3, "outcome": "duplicate"}},
         {"step": "device_read", "text": bad},
         {"step": "send", "frame": {"type": "iface_event", "ref": 4, "stream": "health", "message": bad}},
         {"step": "recv", "frame": {"type": "iface_ack", "of": "iface_event", "ref": 4, "outcome": "refused: signature does not verify"}},
         {"step": "device_read", "text": j({"v": 1, "ev": "result", "seq": 1, "epoch": 1, "usig": "<sig>"}), "not_sent": True},
         {"step": "recv", "frame": {"type": "registered", "id": 3}, "ignored": True}])
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
