#!/usr/bin/env python3
"""C3 harness observer: subscribes to ONE device's topics and prints counts and envelope kinds, never payload.

What it prints per message: the time, the topic class (status, resp, ev/<name>, req), size, retain flag,
QoS, the envelope kind, whether a `usig` member is present, and a short SHA-256 prefix of the bytes (so
two runs or two observers can be compared without showing a byte of content). The only values it ever
echoes from a payload are the `{"online":...}` status flag (the Connector's own state) and the id of a
request or answer when it starts with "c3-" (the stand-in's own ids). The final summary and the pass/fail
checklist contain no payload content either.

    python3 c3_observer.py --host 127.0.0.1 --port 18830 --root mecon/<device_id> \
        --user c3-observer --password-file <observer.pw> --duration 120 [--expect-answers] [--min-events 1]

Needs paho-mqtt (the Connector's own pinned dependency) and the standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time

OUR_ID_PREFIX = "c3-"
READ_OPS = ("hello", "deployment.get")  # the only ops the stand-in publishes (see c3_standin.py)


def classify(root: str, topic: str) -> str:
    """The class of a topic under the device root: status, resp, req, ev/<name>, or 'unexpected'."""
    if not topic.startswith(root + "/"):
        return "unexpected"
    rest = topic[len(root) + 1:]
    if rest in ("status", "resp", "req"):
        return rest
    if rest.startswith("ev/") and rest.count("/") == 1 and len(rest) > 3:
        return rest
    return "unexpected"


def parse(payload: bytes):
    try:
        obj = json.loads(payload)
    except (ValueError, RecursionError):
        return None
    return obj if isinstance(obj, dict) else None


def describe(cls: str, retain: bool, qos: int, payload: bytes) -> dict:
    """One message reduced to metadata. No payload content except the allowed fields in the module docstring."""
    obj = parse(payload)
    rec = {
        "class": cls,
        "bytes": len(payload),
        "retain": bool(retain),
        "qos": qos,
        "sha": hashlib.sha256(payload).hexdigest()[:12],
        "json_object": obj is not None,
        "usig": bool(obj is not None and "usig" in obj),
    }
    if cls == "status":
        rec["kind"] = "status"
        rec["online"] = obj.get("online") if obj is not None and set(obj) == {"online"} else None
    elif cls == "resp":
        rec["kind"] = "response" if obj is not None and "id" in obj and "ev" not in obj else "MALFORMED"
        rid = obj.get("id") if obj is not None else None
        if isinstance(rid, str) and rid.startswith(OUR_ID_PREFIX):
            rec["id"] = rid
    elif cls == "req":
        rec["kind"] = "request"
        op = obj.get("op") if obj is not None else None
        rec["op"] = op if op in READ_OPS else "other"
    elif cls.startswith("ev/"):
        name = cls[3:]
        rec["kind"] = f"event:{name}" if obj is not None and obj.get("ev") == name else "MALFORMED"
    else:
        rec["kind"] = "UNEXPECTED"
    return rec


class Observer:
    def __init__(self, root: str) -> None:
        self.root = root
        self.t0 = time.monotonic()
        self.records: list[dict] = []
        self.lock = threading.Lock()

    def add(self, topic: str, payload: bytes, retain: bool, qos: int) -> dict:
        rec = describe(classify(self.root, topic), retain, qos, payload)
        rec["t"] = round(time.monotonic() - self.t0, 2)
        with self.lock:
            self.records.append(rec)
        return rec

    @staticmethod
    def line(rec: dict) -> str:
        extra = "".join(f" {k}={rec[k]}" for k in ("online", "id", "op") if k in rec)
        return (f"+{rec['t']:7.2f}s {rec['class']:<12} {rec['kind']:<18} {rec['bytes']:5d}B retain={int(rec['retain'])} "
                f"qos={rec['qos']} usig={'yes' if rec['usig'] else 'no '} sha={rec['sha']}{extra}")

    def summary(self) -> dict:
        with self.lock:
            recs = list(self.records)
        by_class: dict[str, int] = {}
        for r in recs:
            by_class[r["class"]] = by_class.get(r["class"], 0) + 1
        return {
            "messages": len(recs),
            "by_class": by_class,
            "events": sum(1 for r in recs if r["class"].startswith("ev/")),
            "responses": sum(1 for r in recs if r["class"] == "resp"),
            "unsigned_uplink": sum(1 for r in recs if r["class"] in ("resp",) or r["class"].startswith("ev/") if not r["usig"]),
            "malformed": sum(1 for r in recs if r["kind"] in ("MALFORMED", "UNEXPECTED")),
            "answered_ids": sorted({r["id"] for r in recs if r["class"] == "resp" and "id" in r}),
            "status_sequence": [(r["online"], r["retain"]) for r in recs if r["class"] == "status"],
            "requests_seen": [r["op"] for r in recs if r["class"] == "req"],
            "digests": [r["sha"] for r in recs if r["class"] == "resp" or r["class"].startswith("ev/")],
        }


def late_status(host: str, port: int, root: str, user: str, password: str, wait: float = 5.0):  # type: ignore[no-untyped-def]
    """What a subscriber that joins now is handed on the status topic: (online, retain flag) or None."""
    import paho.mqtt.client as mqtt

    got: list[tuple] = []
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{user}-late-{int(time.time())}")
    c.username_pw_set(user, password)
    c.on_connect = lambda cl, _u, _f, rc, _p: cl.subscribe(root + "/status", 1)

    def on_message(_cl, _u, m):  # type: ignore[no-untyped-def]
        obj = parse(bytes(m.payload))
        got.append((obj.get("online") if obj is not None and set(obj) == {"online"} else None, bool(m.retain)))

    c.on_message = on_message
    c.connect(host, port, 30)
    c.loop_start()
    end = time.time() + wait
    while not got and time.time() < end:
        time.sleep(0.05)
    c.loop_stop()
    c.disconnect()
    return got[0] if got else None


def checklist(s: dict, expect_answers: bool, min_events: int) -> list[tuple[str, bool, str]]:
    """Pass/fail items that the broker side can see. Items about the Connector's own counters are read from
    its /metrics (see c3_bench.md); this list says so rather than guess them."""
    seq = s["status_sequence"]
    late = s.get("late_status")
    items = [
        ("status is retained: a subscriber that joins late is handed it with the retain flag set", bool(late) and late[1] is True,
         f"late subscriber got: {late}"),
        ("status is the Backend's shape: exactly {\"online\":true|false}", bool(seq) and all(o in (True, False) for o, _ in seq),
         f"values: {[o for o, _ in seq]}"),
        ("status reached online=true", any(o is True for o, _ in seq), ""),
        ("nothing on an unexpected topic and every resp/ev message is well formed", s["malformed"] == 0, f"malformed: {s['malformed']}"),
        ("every response and event carries a usig member (the device signed it)", s["unsigned_uplink"] == 0,
         f"unsigned: {s['unsigned_uplink']}"),
    ]
    if expect_answers:
        want = {"c3-hello-1", "c3-dg-1"}
        items.append(("both read requests were answered on resp, matched by their ids", want <= set(s["answered_ids"]),
                      f"answered ids: {s['answered_ids']}"))
    if min_events:
        items.append((f"at least {min_events} event(s) arrived on ev/<name>", s["events"] >= min_events, f"events: {s['events']}"))
    return items


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18830)
    ap.add_argument("--root", required=True, help="mecon/<device_id>")
    ap.add_argument("--user", required=True)
    ap.add_argument("--password-file", required=True)
    ap.add_argument("--duration", type=float, default=120.0, help="seconds to observe")
    ap.add_argument("--expect-answers", action="store_true", help="the checklist requires the two stand-in answers")
    ap.add_argument("--min-events", type=int, default=0)
    ap.add_argument("--json-out", help="write the summary here (counts and digests only)")
    a = ap.parse_args(argv)

    import paho.mqtt.client as mqtt

    with open(a.password_file, encoding="utf-8") as f:
        password = f.read().strip()
    obs = Observer(a.root)
    done = threading.Event()
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{a.user}-{int(time.time())}")
    c.username_pw_set(a.user, password)

    def on_connect(cl, _u, _f, rc, _p):  # type: ignore[no-untyped-def]
        if rc.is_failure:
            print(f"connect refused: {rc}", file=sys.stderr)
            done.set()
            return
        cl.subscribe(a.root + "/#", 1)
        print(f"observing {a.root}/# for {a.duration:.0f} s (counts and kinds only)", flush=True)

    def on_message(_cl, _u, m):  # type: ignore[no-untyped-def]
        print(obs.line(obs.add(m.topic, bytes(m.payload), m.retain, m.qos)), flush=True)

    c.on_connect, c.on_message = on_connect, on_message
    c.connect(a.host, a.port, 30)
    c.loop_start()
    try:
        done.wait(a.duration)
    except KeyboardInterrupt:
        pass
    c.loop_stop()
    c.disconnect()

    s = obs.summary()
    s["late_status"] = late_status(a.host, a.port, a.root, a.user, password)
    print("\nsummary:", json.dumps({k: v for k, v in s.items() if k != "digests"}, sort_keys=True))
    items = checklist(s, a.expect_answers, a.min_events)
    for text, ok, detail in items:
        print(f"  [{'PASS' if ok else 'FAIL'}] {text}" + (f"  ({detail})" if detail else ""))
    if a.json_out:
        with open(a.json_out, "w", encoding="utf-8") as f:
            json.dump({"summary": s, "checklist": [[t, ok] for t, ok, _ in items]}, f, indent=1)
    return 0 if all(ok for _t, ok, _d in items) else 1


if __name__ == "__main__":
    sys.exit(main())
