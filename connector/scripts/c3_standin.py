#!/usr/bin/env python3
"""C3 harness Backend stand-in: publishes EXACTLY two read-only, unsigned requests to the device's req topic,
`hello` and `deployment.get`, and refuses to publish anything else.

These are the read-class operations of the device interface that the Connector's enrolment gate already
uses. The stand-in signs nothing and has no way to build any other request: the allowlist below is the
whole vocabulary, `publish_request` raises on anything outside it, and there is no option to add one.

    python3 c3_standin.py --host 127.0.0.1 --port 18830 --root mecon/<device_id> \
        --user c3-standin --password-file <standin.pw> [--gap 3]

Request ids start with "c3-" (never "cg-", which the Connector reserves for its own deployment.get).
"""
from __future__ import annotations

import argparse
import json
import sys
import time

# op -> the request id used. Insertion order is the publish order. Nothing else can be sent.
READ_ONLY_REQUESTS = {
    "hello": "c3-hello-1",
    "deployment.get": "c3-dg-1",
}


class RefusedRequest(Exception):
    """An attempt to publish something that is not one of the two allowed read requests."""


def build_request(op: str) -> bytes:
    if op not in READ_ONLY_REQUESTS:
        raise RefusedRequest(f"refused: {op!r} is not one of {sorted(READ_ONLY_REQUESTS)}")
    return json.dumps({"v": 1, "id": READ_ONLY_REQUESTS[op], "op": op}, separators=(",", ":")).encode()


def publish_request(client, root: str, op: str):  # type: ignore[no-untyped-def]
    """Publishes one allowed request to {root}/req: QoS 0, never retained. Raises RefusedRequest otherwise."""
    payload = build_request(op)  # raises before anything is sent
    return client.publish(root + "/req", payload, qos=0, retain=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18830)
    ap.add_argument("--root", required=True, help="mecon/<device_id>")
    ap.add_argument("--user", required=True)
    ap.add_argument("--password-file", required=True)
    ap.add_argument("--gap", type=float, default=3.0, help="seconds between the two requests (the device takes one at a time)")
    a = ap.parse_args(argv)

    import paho.mqtt.client as mqtt

    with open(a.password_file, encoding="utf-8") as f:
        password = f.read().strip()
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{a.user}-{int(time.time())}")
    c.username_pw_set(a.user, password)
    c.connect(a.host, a.port, 30)
    c.loop_start()
    try:
        for i, op in enumerate(READ_ONLY_REQUESTS):
            if i:
                time.sleep(a.gap)
            info = publish_request(c, a.root, op)
            info.wait_for_publish(5)
            print(f"published {op} as {READ_ONLY_REQUESTS[op]} to {a.root}/req (QoS 0, not retained)", flush=True)
        time.sleep(0.5)
    finally:
        c.loop_stop()
        c.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
