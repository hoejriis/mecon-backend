"""A fake serial device: replays scripted bytes and injects the faults a real one has.

Faults: split and coalesced chunks (chunking), garbage, oversize lengths (built by
the caller from bytes), unplug and replug, stall (silence), and write failure.
"""

from __future__ import annotations

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

    def __init__(self) -> None:
        self._chunks: deque[bytes] = deque()
        self.written: list[bytes] = []
        self.gone = False
        self.stalled = False
        self.fail_next_write = False
        self.closed = False

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
        self.written.append(bytes(data))

    def close(self) -> None:
        self.closed = True

    @property
    def written_bytes(self) -> bytes:
        return b"".join(self.written)


class FakeOpener:
    """The serial opener. plug() makes a device appear; the next open() returns it."""

    def __init__(self, device: FakeSerialDevice | None = None) -> None:
        self.device = device
        self.opens = 0
        self.ambiguous = False

    def plug(self, device: FakeSerialDevice | None = None) -> FakeSerialDevice:
        self.device = device or FakeSerialDevice()
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
