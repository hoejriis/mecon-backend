"""Serial framing: the wrapper, the MECON interface frames and console lines.

Original implementation of the rules the public docs state (see
docs/USB_CONNECTOR_IMPLEMENTATION_DESIGN.md and contracts/connector/v1). Every
reader here is bounded: no input, however hostile, makes it hold more than its
documented maximum, and none looks inside a payload. Classification uses only
the transport header (marker, length, command byte, xid/index/count) or the
console prefix.
"""

from __future__ import annotations

from dataclasses import dataclass

MAX_FRAME_SIZE = 176  # largest wrapper payload the firmware accepts
MARKER_FROM_DEVICE = 0x3E  # '>'
MARKER_TO_DEVICE = 0x3C  # '<'
HEADER_SIZE = 3  # marker + 16-bit little-endian length

CMD_MECON = 0x7F  # first payload byte of an interface frame
MECON_FRAME_BODY = 168
MECON_MAX_FRAMES = 25
MECON_MAX_MESSAGE = 4096
MECON_INCOMPLETE_S = 5.0

CONSOLE_PREFIX = b"mecon> "
CONSOLE_JSON_PREFIX = CONSOLE_PREFIX + b"{"
CONSOLE_MAX_WIRE = 1600  # the device bound: bytes of envelope after "mecon> ", terminator not counted
CONSOLE_MAX_LINE = 7 + CONSOLE_MAX_WIRE  # a whole line: prefix included, terminator excluded (1,609 with CRLF)


class FrameEncodeError(ValueError):
    pass


def encode_serial_frame(payload: bytes, marker: int = MARKER_TO_DEVICE) -> bytes:
    if not payload:
        raise FrameEncodeError("empty frame")
    if len(payload) > MAX_FRAME_SIZE:
        raise FrameEncodeError(f"frame {len(payload)} > {MAX_FRAME_SIZE}")
    return bytes((marker, len(payload) & 0xFF, len(payload) >> 8)) + payload


def encode_mecon_frames(xid: int, message: bytes) -> list[bytes]:
    """Split one message into interface frame payloads: 7f xid index count body."""
    if not message:
        raise FrameEncodeError("empty message")
    count = -(-len(message) // MECON_FRAME_BODY)
    if count > MECON_MAX_FRAMES or len(message) > MECON_MAX_MESSAGE:
        raise FrameEncodeError("message too long")
    return [
        bytes((CMD_MECON, xid & 0xFF, i, count)) + message[i * MECON_FRAME_BODY : (i + 1) * MECON_FRAME_BODY]
        for i in range(count)
    ]


def encode_console_line(message: bytes) -> bytes:
    """`mecon> <message>` plus CR. The caller has already refused CR/LF inside."""
    line = CONSOLE_PREFIX + message
    if len(line) > CONSOLE_MAX_LINE:
        raise FrameEncodeError("console line too long")
    return line + b"\r"


@dataclass
class DeframerStats:
    skipped_bytes: int = 0
    oversize_lengths: int = 0
    empty_frames: int = 0
    discarded_partial_bytes: int = 0
    frames_out: int = 0
    high_water: int = 0  # most bytes ever held for one partial frame (header included)


_IDLE, _LEN_LO, _LEN_HI, _BODY = range(4)


class SerialDeframer:
    """Streaming deframer for the marker + 16-bit length wrapper.

    There is no checksum, so a corrupted length that still looks plausible
    cannot be detected; the reader can skip non-frame bytes, refuse lengths
    above MAX_FRAME_SIZE at once (rescanning from the byte after the marker)
    and be reset by the caller when a partial frame stalls.
    """

    def __init__(self, marker: int = MARKER_FROM_DEVICE) -> None:
        self.marker = marker
        self.stats = DeframerStats()
        self._state = _IDLE
        self._len_lo = 0
        self._want = 0
        self._buf = bytearray()

    @property
    def pending_bytes(self) -> int:
        if self._state == _IDLE:
            return 0
        if self._state == _LEN_LO:
            return 1
        if self._state == _LEN_HI:
            return 2
        return HEADER_SIZE + len(self._buf)

    def feed(self, chunk: bytes) -> list[bytes]:
        out: list[bytes] = []
        for b in chunk:
            self._step(b, out)
            if self.pending_bytes > self.stats.high_water:
                self.stats.high_water = self.pending_bytes
        return out

    def reset(self) -> int:
        n = self.pending_bytes
        self.stats.discarded_partial_bytes += n
        self._state = _IDLE
        self._buf = bytearray()
        return n

    def _step(self, b: int, out: list[bytes]) -> None:
        if self._state == _IDLE:
            if b == self.marker:
                self._state = _LEN_LO
            else:
                self.stats.skipped_bytes += 1
        elif self._state == _LEN_LO:
            self._len_lo = b
            self._state = _LEN_HI
        elif self._state == _LEN_HI:
            length = self._len_lo | (b << 8)
            if length == 0:
                self.stats.empty_frames += 1
                self._state = _IDLE
            elif length > MAX_FRAME_SIZE:
                # Refuse now. The two length bytes may hold the next marker: rescan them.
                self.stats.oversize_lengths += 1
                self.stats.skipped_bytes += 1
                self._state = _IDLE
                lo = self._len_lo
                self._step(lo, out)
                self._step(b, out)
            else:
                self._want = length
                self._buf = bytearray()
                self._state = _BODY
        else:
            self._buf.append(b)
            if len(self._buf) >= self._want:
                out.append(bytes(self._buf))
                self.stats.frames_out += 1
                self._buf = bytearray()
                self._state = _IDLE


@dataclass
class AssemblerStats:
    messages: int = 0
    malformed: int = 0
    duplicate_frames: int = 0
    discarded_incomplete: int = 0  # messages abandoned (new xid, timeout, reset)
    oversize: int = 0
    high_water: int = 0  # most body bytes ever held


class MeconAssembler:
    """Reassembles `7f xid index count body` interface frames into a message.

    One message at a time. A frame of a new xid discards the incomplete one; a
    repeated frame is ignored; a message incomplete after 5 s is dropped. The
    last completed xid is remembered so a repeat of its frames (a split or
    resent frame) never publishes the message a second time.
    """

    def __init__(self) -> None:
        self.stats = AssemblerStats()
        self._reset()
        self._done: tuple[int, int] | None = None

    def _reset(self) -> None:
        self._xid: int | None = None
        self._count = 0
        self._slots: dict[int, bytes] = {}
        self._started = 0.0

    @property
    def pending_bytes(self) -> int:
        return sum(len(v) for v in self._slots.values())

    def reset(self) -> int:
        n = self.pending_bytes
        if self._slots:
            self.stats.discarded_incomplete += 1
        self._reset()
        self._done = None
        return n

    def expire(self, now: float) -> bool:
        if self._slots and now - self._started >= MECON_INCOMPLETE_S:
            self.stats.discarded_incomplete += 1
            self._reset()
            return True
        return False

    def feed(self, payload: bytes, now: float) -> bytes | None:
        """`payload` is one wrapper payload whose first byte is CMD_MECON."""
        if len(payload) < 4:
            self.stats.malformed += 1
            return None
        _, xid, index, count = payload[0], payload[1], payload[2], payload[3]
        body = payload[4:]
        if not (1 <= count <= MECON_MAX_FRAMES) or index >= count or len(body) > MECON_FRAME_BODY:
            self.stats.malformed += 1
            return None
        last = index == count - 1
        if (not last and len(body) != MECON_FRAME_BODY) or (last and len(body) == 0):
            self.stats.malformed += 1
            return None
        if self._done == (xid, count):
            self.stats.duplicate_frames += 1
            return None
        if self._xid != xid:
            if self._slots:
                self.stats.discarded_incomplete += 1
            self._reset()
            self._xid, self._count, self._started = xid, count, now
        elif count != self._count:
            self.stats.malformed += 1
            self.stats.discarded_incomplete += 1
            self._reset()
            return None
        if index in self._slots:
            self.stats.duplicate_frames += 1
            return None
        self._slots[index] = bytes(body)
        self.stats.high_water = max(self.stats.high_water, self.pending_bytes)
        if len(self._slots) < self._count:
            return None
        message = b"".join(self._slots[i] for i in range(self._count))
        self._done = (xid, count)
        self._reset()
        if len(message) > MECON_MAX_MESSAGE:
            self.stats.oversize += 1
            return None
        self.stats.messages += 1
        return message


@dataclass
class ConsoleStats:
    lines_out: int = 0
    skipped_bytes: int = 0  # bytes of lines that were not interface lines
    oversize_lines: int = 0
    discarded_partial_bytes: int = 0
    high_water: int = 0


class ConsoleLineReader:
    """Takes `mecon> {` lines from a Repeater or Room console; skips the rest.

    Bounded by CONSOLE_MAX_LINE. A line that does not start with the prefix is
    skipped as soon as that is known, without buffering it. A terminator is CR
    or LF. The emitted message is the line after the prefix, byte for byte.
    """

    _LEAD = len(CONSOLE_JSON_PREFIX)

    def __init__(self) -> None:
        self.stats = ConsoleStats()
        self._buf = bytearray()
        self._skipping = False  # discarding the rest of a line
        self._skipped_in_line = 0

    @property
    def pending_bytes(self) -> int:
        return len(self._buf)

    def reset(self) -> int:
        n = len(self._buf)
        self.stats.discarded_partial_bytes += n
        self._buf = bytearray()
        self._skipping = False
        return n

    def feed(self, chunk: bytes) -> list[bytes]:
        out: list[bytes] = []
        for b in chunk:
            if b in (0x0D, 0x0A):
                if not self._skipping and self._buf:
                    if self._buf.startswith(CONSOLE_JSON_PREFIX):
                        out.append(bytes(self._buf[len(CONSOLE_PREFIX) :]))
                        self.stats.lines_out += 1
                    else:
                        self.stats.skipped_bytes += len(self._buf)
                self._buf = bytearray()
                self._skipping = False
                continue
            if self._skipping:
                self.stats.skipped_bytes += 1
                continue
            self._buf.append(b)
            n = len(self._buf)
            if n <= self._LEAD:
                if self._buf != CONSOLE_JSON_PREFIX[:n]:
                    self._skip_line()
            elif n > CONSOLE_MAX_LINE:
                self.stats.oversize_lines += 1
                self._skip_line()
            if len(self._buf) > self.stats.high_water:
                self.stats.high_water = len(self._buf)
        return out

    def _skip_line(self) -> None:
        self.stats.skipped_bytes += len(self._buf)
        self._buf = bytearray()
        self._skipping = True
