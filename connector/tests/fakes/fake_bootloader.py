"""A fake bootloader speaking the device side of legacy Nordic serial DFU (HCI packets in SLIP frames).

Written independently of mecon_connector.nordic_dfu (its own CRC, header and SLIP code), so a shared mistake in
the codec cannot pass both. It implements SerialLink: what the host writes is parsed at once, and the
acknowledgements it would send are queued for read(). It checks each frame (header checksum, flags, type,
length, CRC), the sequence numbers, and the packet order start, init, data..., stop, and records the image.

Faults: acks dropped for chosen packets, a stale ack sent instead of processing a chosen packet (as if it was
lost on the wire), noise around acks, a dead bootloader that never answers, and a port that disappears.
"""

from __future__ import annotations

import struct

from mecon_connector.transport import SerialGone


def crc_ccitt(data: bytes) -> int:
    """Bitwise CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): a different algorithm from the codec's."""
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def unslip(body: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(body):
        if body[i] == 0xDB:
            out.append({0xDC: 0xC0, 0xDD: 0xDB}[body[i + 1]])
            i += 2
        else:
            out.append(body[i])
            i += 1
    return bytes(out)


def ack_frame(ack: int) -> bytes:
    """An acknowledgement: a header with only the ack field set, no payload, no CRC, framed by C0."""
    h = [(ack & 7) << 3, 0, 0]
    h.append((256 - sum(h) % 256) % 256)
    body = bytearray()
    for b in h:
        body += b"\xdb\xdc" if b == 0xC0 else b"\xdb\xdd" if b == 0xDB else bytes((b,))
    return b"\xc0" + bytes(body) + b"\xc0"


class FakeBootloader:
    def __init__(self, clock=None, drop_acks=(), stale_instead=(), noise=False, dead=False, gone_after=None):
        self.clock = clock
        self.drop_acks = set(drop_acks)  # packet numbers (0 = start) whose first ack is lost
        self.stale_instead = set(stale_instead)  # packet numbers lost on first sending; the previous ack is repeated
        self.noise = noise
        self.dead = dead
        self.gone_after = gone_after  # the port disappears after this many processed packets
        self.gone = False
        self.closed = False
        self._rx = bytearray()
        self._out = bytearray()
        self.last_seq: int | None = None
        self.processed = 0  # packets taken, in order
        self.duplicates = 0  # a packet received again (its ack was lost) and acknowledged again
        self.frames = 0  # every frame written by the host
        self.raw_frames: list[bytes] = []  # each frame exactly as written, C0 ... C0
        self.acks_sent: list[bytes] = []
        self.errors: list[str] = []
        self.order: list[str] = []
        self.start: tuple[int, int, int, int] | None = None  # mode, softdevice, bootloader, application size
        self.init: bytes | None = None
        self.image = bytearray()
        self.data_sizes: list[int] = []
        self.stopped = False
        self.times: list[float] = []  # the clock when each packet was taken
        self._seen_first: set[int] = set()

    # -- SerialLink --------------------------------------------------------------------------------

    def write(self, data: bytes) -> None:
        if self.gone:
            raise SerialGone("bootloader gone")
        for b in bytes(data):
            if b == 0xC0:
                if self._rx:
                    self.raw_frames.append(b"\xc0" + bytes(self._rx) + b"\xc0")
                    self._frame(bytes(self._rx))
                self._rx.clear()
            else:
                self._rx.append(b)

    def read(self, max_bytes: int) -> bytes:
        if self.gone:
            raise SerialGone("bootloader gone")
        out = bytes(self._out[:max_bytes])
        del self._out[:max_bytes]
        return out

    def close(self) -> None:
        self.closed = True

    # -- the device side ----------------------------------------------------------------------------

    def _send_ack(self, ack: int) -> None:
        self.acks_sent.append(ack_frame(ack))
        if self.noise:
            self._out += b"\x00\xff\x11"  # bytes outside any frame
        self._out += ack_frame(ack)

    def _frame(self, raw: bytes) -> None:
        self.frames += 1
        try:
            f = unslip(raw)
        except (KeyError, IndexError):
            self.errors.append("bad escape")
            return
        if len(f) < 6 or (f[0] + f[1] + f[2] + f[3]) & 0xFF:
            self.errors.append("bad header")
            return
        seq, ack, dip, rp = f[0] & 7, (f[0] >> 3) & 7, (f[0] >> 6) & 1, f[0] >> 7
        ptype, length = f[1] & 0x0F, (f[1] >> 4) | (f[2] << 4)
        payload, crc = f[4:-2], f[-2] | (f[-1] << 8)
        if ack != (seq + 1) % 8 or not dip or not rp or ptype != 14:
            self.errors.append("bad header fields")
            return
        if length != len(payload):
            self.errors.append("bad length")
            return
        if crc != crc_ccitt(f[:-2]):
            self.errors.append("bad crc")
            return
        if self.dead:
            return
        n = self.processed
        if self.last_seq is not None and seq == self.last_seq:
            self.duplicates += 1  # the same packet again: its ack was lost; acknowledge, do not take it twice
            self._send_ack((seq + 1) % 8)
            return
        if self.last_seq is not None and seq != (self.last_seq + 1) % 8:
            self.errors.append(f"out of order: seq {seq} after {self.last_seq}")
            self._send_ack((self.last_seq + 1) % 8)
            return
        if n in self.stale_instead and n not in self._seen_first:
            self._seen_first.add(n)
            if self.last_seq is not None:
                self._send_ack((self.last_seq + 1) % 8)  # the previous packet's ack, again
            return
        self._take(payload)
        self.last_seq = seq
        self.processed += 1
        if self.clock is not None:
            self.times.append(self.clock())
        if n in self.drop_acks and n not in self._seen_first:
            self._seen_first.add(n)
        else:
            self._send_ack((seq + 1) % 8)
        if self.gone_after is not None and self.processed >= self.gone_after:
            self.gone = True

    def _take(self, p: bytes) -> None:
        op = struct.unpack_from("<I", p)[0] if len(p) >= 4 else -1
        kind = {3: "start", 1: "init", 4: "data", 5: "stop"}.get(op, "unknown")
        self.order.append(kind)
        if kind == "start":
            if self.start is not None:
                self.errors.append("second start")
            self.start = struct.unpack_from("<IIII", p, 4)
            if len(p) != 20:
                self.errors.append("start length")
        elif kind == "init":
            if self.start is None or self.init is not None:
                self.errors.append("init out of order")
            if p[-2:] != b"\x00\x00":
                self.errors.append("init without padding")
            self.init = p[4:-2]
        elif kind == "data":
            if self.init is None or self.stopped:
                self.errors.append("data out of order")
            self.data_sizes.append(len(p) - 4)
            self.image += p[4:]
        elif kind == "stop":
            if not self.image or len(p) != 4:
                self.errors.append("stop out of order")
            if self.start is not None and len(self.image) != self.start[3]:
                self.errors.append("image size differs from start")
            self.stopped = True
        else:
            self.errors.append(f"unknown opcode {op}")

    @property
    def complete(self) -> bool:
        return self.stopped and not self.errors


class FakeBootOpener:
    """The bootloader port's opener. appear() makes a bootloader port exist; opens counts every open."""

    def __init__(self) -> None:
        self.device: FakeBootloader | None = None
        self.opens = 0
        self.calls = 0  # every attempt, also while no port exists
        self.factory = None  # callable() -> FakeBootloader: a fresh one per open (a new attempt)

    def appear(self, dev: FakeBootloader | None = None, factory=None) -> None:
        self.device = dev
        self.factory = factory

    def vanish(self) -> None:
        self.device = None
        self.factory = None

    def __call__(self):
        from mecon_connector.transport import SerialUnavailable

        self.calls += 1
        if self.factory is not None:
            self.device = self.factory()
        if self.device is None:
            raise SerialUnavailable("no bootloader port")
        self.opens += 1
        return self.device
