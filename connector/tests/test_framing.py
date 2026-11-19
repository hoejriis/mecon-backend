import random

import pytest

from mecon_connector.framing import (
    CONSOLE_MAX_LINE,
    ConsoleLineReader,
    FrameEncodeError,
    MAX_FRAME_SIZE,
    MeconAssembler,
    SerialDeframer,
    encode_console_line,
    encode_mecon_frames,
    encode_serial_frame,
)


def feed_split(d, data, size):
    out = []
    for i in range(0, len(data), size):
        out += d.feed(data[i : i + size])
    return out


def test_deframer_single_frame_every_split_point():
    wire = encode_serial_frame(b"\x7f\x01\x00\x01hello", marker=0x3E)
    for cut in range(1, len(wire)):
        d = SerialDeframer()
        got = d.feed(wire[:cut]) + d.feed(wire[cut:])
        assert got == [b"\x7f\x01\x00\x01hello"], cut


def test_deframer_coalesced_and_garbage():
    f1, f2 = encode_serial_frame(b"aaa", 0x3E), encode_serial_frame(b"bbbb", 0x3E)
    d = SerialDeframer()
    assert d.feed(b"\x00\x01" + f1 + b"zz" + f2) == [b"aaa", b"bbbb"]
    assert d.stats.skipped_bytes == 4


def test_deframer_oversize_length_refused_without_buffering():
    d = SerialDeframer()
    good = encode_serial_frame(b"ok", 0x3E)
    got = d.feed(bytes([0x3E, 0xFF, 0xFF]) + b"\x41" * 70000 + good)
    assert got == [b"ok"]
    assert d.stats.oversize_lengths == 1
    assert d.stats.high_water <= 3 + MAX_FRAME_SIZE


def test_deframer_oversize_length_may_hide_next_marker():
    # '>' 0x3E then lengths whose bytes are themselves a marker and a small length.
    d = SerialDeframer()
    good = encode_serial_frame(b"hi", 0x3E)
    got = d.feed(bytes([0x3E, 0xB1]) + good)  # 0xB1 | (0x3E<<8) is huge; the real marker is inside it
    assert got == [b"hi"]


def test_deframer_exact_max_accepted_and_one_over_refused():
    d = SerialDeframer()
    assert d.feed(bytes([0x3E, 176, 0]) + b"a" * 176) == [b"a" * 176]
    assert d.feed(bytes([0x3E, 177, 0]) + b"a" * 177) == []
    assert d.stats.oversize_lengths == 1


def test_deframer_reset_reports_partial():
    d = SerialDeframer()
    d.feed(bytes([0x3E, 10, 0]) + b"abc")
    assert d.reset() == 6
    assert d.pending_bytes == 0


def test_deframer_random_stream_never_exceeds_bound():
    rng = random.Random(7)
    d = SerialDeframer()
    for _ in range(200):
        d.feed(bytes(rng.randrange(256) for _ in range(500)))
    assert d.stats.high_water <= 3 + MAX_FRAME_SIZE


def test_encode_roundtrip_through_deframer():
    rng = random.Random(1)
    for n in (1, 2, 100, 176):
        p = bytes(rng.randrange(256) for _ in range(n))
        d = SerialDeframer(marker=0x3C)
        assert feed_split(d, encode_serial_frame(p), 1) == [p]
    with pytest.raises(FrameEncodeError):
        encode_serial_frame(b"")
    with pytest.raises(FrameEncodeError):
        encode_serial_frame(b"x" * 177)


# ---- interface frame assembler -------------------------------------------------------------


def test_assembler_roundtrip_all_sizes():
    rng = random.Random(3)
    for n in (1, 167, 168, 169, 336, 337, 1000, 4096):
        msg = bytes(rng.randrange(256) for _ in range(n))
        a = MeconAssembler()
        got = [a.feed(f, 0.0) for f in encode_mecon_frames(9, msg)]
        assert got[:-1] == [None] * (len(got) - 1)
        assert got[-1] == msg


def test_assembler_any_order():
    msg = bytes(range(256)) * 3
    frames = encode_mecon_frames(4, msg)
    a = MeconAssembler()
    results = [a.feed(f, 0.0) for f in reversed(frames)]
    assert results[-1] == msg and all(r is None for r in results[:-1])


def test_assembler_duplicate_frame_never_publishes_twice():
    msg = b"m" * 400
    frames = encode_mecon_frames(2, msg)
    a = MeconAssembler()
    outs = [a.feed(f, 0.0) for f in frames + frames]
    assert [o for o in outs if o is not None] == [msg]


def test_assembler_new_xid_discards_incomplete():
    a = MeconAssembler()
    a.feed(encode_mecon_frames(1, b"a" * 400)[0], 0.0)
    out = a.feed(encode_mecon_frames(2, b"b")[0], 0.1)
    assert out == b"b"
    assert a.stats.discarded_incomplete == 1


def test_assembler_incomplete_expires_after_five_seconds():
    a = MeconAssembler()
    f = encode_mecon_frames(1, b"a" * 400)
    a.feed(f[0], 0.0)
    assert not a.expire(4.9)
    assert a.expire(5.0)
    assert a.pending_bytes == 0
    # the rest of the old message must not complete it
    assert a.feed(f[1], 5.1) is None and a.feed(f[2], 5.1) is None


@pytest.mark.parametrize(
    "frame",
    [b"\x7f\x01\x00", b"\x7f\x01\x00\x00x", b"\x7f\x01\x02\x02x", b"\x7f\x01\x00\x1ax", b"\x7f\x01\x00\x01" + b"x" * 169,
     b"\x7f\x01\x00\x02" + b"x" * 10, b"\x7f\x01\x00\x01"],
)
def test_assembler_malformed(frame):
    a = MeconAssembler()
    assert a.feed(frame, 0.0) is None
    assert a.stats.malformed == 1 and a.pending_bytes == 0


def test_assembler_oversize_message_dropped():
    # 25 frames, last full: 4200 bytes > 4096
    a = MeconAssembler()
    frames = [bytes([0x7F, 1, i, 25]) + b"x" * 168 for i in range(25)]
    outs = [a.feed(f, 0.0) for f in frames]
    assert outs[-1] is None and a.stats.oversize == 1


def test_assembler_memory_bound():
    a = MeconAssembler()
    for xid in range(256):
        for i in range(24):
            a.feed(bytes([0x7F, xid, i, 25]) + b"x" * 168, 0.0)
    assert a.stats.high_water <= 24 * 168


# ---- console -------------------------------------------------------------------------------


def test_console_line_terminators():
    r = ConsoleLineReader()
    out = r.feed(b'mecon> {"a":1}\rmecon> {"b":2}\nmecon> {"c":3}\r\n\r\n')
    assert out == [b'{"a":1}', b'{"b":2}', b'{"c":3}']


def test_console_every_split_point():
    wire = b'junk\r\nmecon> \r\nmecon> {"a":1} \r'
    for cut in range(1, len(wire)):
        r = ConsoleLineReader()
        assert r.feed(wire[:cut]) + r.feed(wire[cut:]) == [b'{"a":1} ']


def test_console_limit_boundary():
    ok = b"{" + b"a" * (CONSOLE_MAX_LINE - 7 - 2) + b"}"
    assert 7 + len(ok) == CONSOLE_MAX_LINE
    r = ConsoleLineReader()
    assert r.feed(b"mecon> " + ok + b"\r") == [ok]
    r = ConsoleLineReader()
    assert r.feed(b"mecon> " + ok + b"x\r") == []
    assert r.stats.oversize_lines == 1
    assert r.feed(b'mecon> {"n":1}\r') == [b'{"n":1}']


def test_console_never_buffers_unbounded():
    r = ConsoleLineReader()
    r.feed(b"mecon> {" + b"q" * 1_000_000)
    assert r.stats.high_water <= CONSOLE_MAX_LINE + 1
    r.feed(b"zzzz" * 100_000)
    assert r.pending_bytes <= CONSOLE_MAX_LINE
    assert r.feed(b'\rmecon> {"ok":1}\r') == [b'{"ok":1}']


def test_console_non_interface_line_not_buffered():
    r = ConsoleLineReader()
    r.feed(b"x" * 100000)
    assert r.pending_bytes == 0


def test_encode_console_line_limits():
    assert encode_console_line(b"{}") == b"mecon> {}\r"
    with pytest.raises(FrameEncodeError):
        encode_console_line(b"x" * (CONSOLE_MAX_LINE - 6))


def test_assembler_keeps_trailing_nul_cr_lf_and_high_bytes():
    # The bridge now routes only JSON envelopes, so the codec's byte transparency is checked here, directly.
    for tail in (b"\x00", b"\x00\x00\x00", b"\r\n", b" ", b"\xff\x00", b"\x7f"):
        for body_len in (1, 168 - len(tail), 169, 400):
            msg = b"A" * body_len + tail
            a = MeconAssembler()
            got = [a.feed(f, 0.0) for f in encode_mecon_frames(7, msg)]
            assert got[-1] == msg
