"""A fake serial device: replays scripted bytes and injects the faults a real one has.

Faults: split and coalesced chunks (chunking), garbage, oversize lengths (built by
the caller from bytes), unplug and replug, stall (silence), and write failure.
"""

from __future__ import annotations

import json
import threading
from collections import deque

from mecon_connector.transport import SerialAmbiguous, SerialGone, SerialUnavailable


def chunked(data: bytes, mode: str | int) -> list[bytes]:
    """Cuts `data` into the chunks a port might deliver. mode: 'whole', 'bytes' or a size."""
    if mode == "whole":
        return [data]
    n = 1 if mode == "bytes" else int(mode)
    return [data[i : i + n] for i in range(0, len(data), n)]


class FakeSerialDevice:
    """Implements SerialLink. Each read() returns the next scripted chunk, or b'' (poll timeout)."""

    def __init__(self, mode: str = "companion", enrolment: str = "provisioned") -> None:
        self.mode = mode
        # How the device answers deployment.get: provisioned | none | corrupt | silent | garbage |
        # refused | bad_state | wrong_id | busy | failed
        self.enrolment = enrolment
        self.epoch = 1
        self.signed = True  # while a record exists the device signs every event and result
        self._seq = 0
        self._xid = 0
        self._xid_lock = threading.Lock()
        self.probe_writes: list[bytes] = []  # raw bytes of deployment.get requests
        self._chunks: deque[bytes] = deque()
        self.written: list[bytes] = []
        self.gone = False
        self.stalled = False
        self.fail_next_write = False
        self.closed = False
        # hold transport: the Connector's own `hello`, bare console CRs, and decoded relayed requests
        self.answers_hello = False
        self.hello_result = {"v": 1, "name": "synthetic", "node_key": "00" * 32, "device_id": "0123456789abcdef", "epoch": 1}
        self.hello_writes: list[bytes] = []
        self.hello_page_fn = None  # callable(cursor: int) -> result dict | None (None: no answer); default: hello_result
        self.cr_writes = 0
        self.messages: list[bytes] = []  # each relayed request as the device decoded it
        self.reply_hook = None  # callable(message: bytes) -> bytes | None: the device's answer to a relayed request

    def feed(self, *chunks: bytes) -> None:
        self._chunks.extend(chunks)

    def feed_bytes(self, data: bytes, mode: str | int = "whole") -> None:
        self._chunks.extend(chunked(data, mode))

    def unplug(self) -> None:
        self.gone = True

    def read(self, max_bytes: int) -> bytes:
        if self.gone:
            raise SerialGone("unplugged")
        if self.stalled or not self._chunks:
            return b""
        c = self._chunks.popleft()
        if len(c) > max_bytes:
            self._chunks.appendleft(c[max_bytes:])
            c = c[:max_bytes]
        return c

    def write(self, data: bytes) -> None:
        if self.gone or self.fail_next_write:
            self.fail_next_write = False
            raise SerialGone("write failed")
        if bytes(data) == b"\r":
            self.cr_writes += 1
            return
        msg = self._decode(bytes(data))
        obj = None
        try:
            obj = json.loads(msg) if msg is not None else None
        except ValueError:
            pass
        if isinstance(obj, dict) and obj.get("op") == "deployment.get":
            self.probe_writes.append(bytes(data))
            self._answer(obj["id"])
        elif isinstance(obj, dict) and obj.get("op") == "hello" and str(obj.get("id", "")).startswith("ch-"):
            self.hello_writes.append(bytes(data))
            if self.answers_hello:
                cur = (obj.get("args") or {}).get("cursor", 0)
                self._answer_hello(obj["id"], cur)
        else:
            self.written.append(bytes(data))
            if msg is not None:
                self.messages.append(msg)
                if self.reply_hook is not None:
                    reply = self.reply_hook(msg)
                    if reply is not None:
                        self.say(reply)

    # -- a tiny independent model of the device's side of the wire --------------------------

    def _decode(self, data: bytes) -> bytes | None:
        """The message inside what the host wrote: `<` wrapper with 0x7f frames, or a console line."""
        if self.mode == "console":
            return data[7:].rstrip(b"\r\n") if data.startswith(b"mecon> ") else None
        out, i = b"", 0
        while i + 3 <= len(data) and data[i] == 0x3C:
            n = data[i + 1] | (data[i + 2] << 8)
            payload = data[i + 3 : i + 3 + n]
            if not payload or payload[0] != 0x7F:
                return None
            out += payload[4:]
            i += 3 + n
        return out or None

    def wire(self, message: bytes) -> bytes:
        """What this device would send for one interface message, in its mode's framing."""
        if self.mode == "console":
            return b"mecon> " + message + b"\r"
        with self._xid_lock:  # the test thread and the bridge thread (probe answers) both frame
            self._xid = (self._xid + 1) & 0xFF
            xid = self._xid
        n = max(1, -(-len(message) // 168))
        frames = [bytes([0x7F, xid, i, n]) + message[i * 168 : (i + 1) * 168] for i in range(n)]
        return b"".join(bytes([0x3E, len(f) & 255, len(f) >> 8]) + f for f in frames)

    def event(self, ev="health", signed=None, epoch=None, **extra) -> bytes:
        """A synthetic interface event as the device would send it."""
        signed = self.signed if signed is None else signed
        o = {"v": 1, "ev": ev, "seq": self._next_seq(), "epoch": self.epoch if epoch is None else epoch, "ts": None, "data": {}}
        o.update(extra)
        if signed:
            o.update({"usig_boot": o["epoch"], "usig_seq": o["seq"], "usig": "U1lOVEhFVElD"})  # synthetic marker
        return json.dumps(o, separators=(",", ":")).encode()

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def say(self, message: bytes, mode: str | int = "whole") -> None:
        self.feed_bytes(self.wire(message), mode)

    def _answer(self, rid: str) -> None:
        e = self.enrolment
        if e == "silent":
            return
        if e == "garbage":
            self.say(b"this is not json")
            return
        base = {"v": 1, "id": rid, "status": "ok", "epoch": self.epoch}
        if e == "refused":
            base.update(status="refused", error="not-permitted")
        elif e == "busy":  # the firmware had no memory for the answer
            base.update(status="busy", error="no-memory")
        elif e == "failed":  # the firmware could not read its storage
            base.update(status="failed", error="storage")
        elif e == "wrong_id":
            base["id"] = "cg-999999"
            base["result"] = {"state": "provisioned"}
        else:
            base["result"] = {"state": "weird" if e == "bad_state" else e}
        if e in ("provisioned", "corrupt", "busy", "failed") and self.signed:  # an enrolled device signs its errors too
            base.update({"usig_boot": self.epoch, "usig_seq": self._next_seq(), "usig": "U1lOVEhFVElD"})
        self.say(json.dumps(base, separators=(",", ":")).encode())

    def _answer_hello(self, rid: str, cursor: int = 0) -> None:
        res = self.hello_result if self.hello_page_fn is None else self.hello_page_fn(cursor)
        if res is None:
            return
        base = {"v": 1, "id": rid, "op": "hello", "status": "ok", "epoch": self.epoch, "result": dict(res)}
        if self.signed and self.enrolment in ("provisioned", "corrupt"):
            base.update({"usig_boot": self.epoch, "usig_seq": self._next_seq(), "usig": "U1lOVEhFVElD"})
        self.say(json.dumps(base, separators=(",", ":")).encode())

    def close(self) -> None:
        self.closed = True

    @property
    def written_bytes(self) -> bytes:
        return b"".join(self.written)


class FakeOpener:
    """The serial opener. plug() makes a device appear; the next open() returns it."""

    def __init__(self, device: FakeSerialDevice | None = None, mode: str = "companion", enrolment: str = "provisioned") -> None:
        self.device = device
        self.mode = mode
        self.enrolment = enrolment
        self.opens = 0
        self.ambiguous = False

    def plug(self, device: FakeSerialDevice | None = None) -> FakeSerialDevice:
        self.device = device or FakeSerialDevice(self.mode, self.enrolment)
        return self.device

    def unplug(self) -> None:
        if self.device:
            self.device.unplug()
        self.device = None

    def __call__(self) -> FakeSerialDevice:
        if self.ambiguous:
            raise SerialAmbiguous("two ports match")
        if self.device is None or self.device.gone:
            raise SerialUnavailable("not plugged in")
        self.opens += 1
        return self.device
