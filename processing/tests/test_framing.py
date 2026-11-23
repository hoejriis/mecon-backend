import hashlib

import pytest
from helpers import packet

from mecon_processing.framing import packet_id, parse_packet, payload_type_name


def pid(b):
    return packet_id(parse_packet(b))


def test_identity_is_sha256_over_type_and_payload_uppercase_16_hex():
    p = packet(ptype=5, payload=b"hello")
    want = hashlib.sha256(bytes([5]) + b"hello").hexdigest()[:16].upper()
    assert pid(p) == want and len(want) == 16 and want == want.upper()


def test_identity_ignores_route_type_transport_codes_and_path():
    base = pid(packet(route=1, ptype=4, payload=b"same"))
    assert pid(packet(route=2, ptype=4, payload=b"same")) == base
    assert pid(packet(route=0, ptype=4, payload=b"same", transport=b"\x01\x02\x03\x04")) == base
    assert pid(packet(route=3, ptype=4, payload=b"same", transport=b"\xff\xff\xff\xff")) == base
    assert pid(packet(route=1, ptype=4, payload=b"same", path=b"\xaa\xbb")) == base
    assert pid(packet(route=1, ptype=4, payload=b"same", path=b"\xaa\xbb\xcc\xdd", hash_mode=1)) == base


def test_the_payload_type_is_part_of_the_identity():
    assert pid(packet(ptype=4, payload=b"x")) != pid(packet(ptype=5, payload=b"x"))


def test_trace_identity_includes_the_path_byte_little_endian_as_two_bytes():
    a = packet(ptype=9, payload=b"trace", path=b"\x01")
    b = packet(ptype=9, payload=b"trace", path=b"\x01\x02")
    assert pid(a) != pid(b)
    want = hashlib.sha256(bytes([9]) + bytes([1, 0]) + b"trace").hexdigest()[:16].upper()
    assert pid(a) == want
    # a hash-mode bit is part of the path byte too
    assert pid(packet(ptype=9, payload=b"t", path=b"\x01\x02", hash_mode=1)) != pid(packet(ptype=9, payload=b"t", path=b"\x01\x02"))


def test_a_non_trace_packet_does_not_include_the_path_byte():
    assert pid(packet(ptype=8, payload=b"p", path=b"\x01")) == pid(packet(ptype=8, payload=b"p", path=b"\x01\x02"))


def test_fields():
    p = parse_packet(packet(route=0, ptype=5, payload=b"abc", path=b"\x01\x02", transport=b"\x09\x09\x09\x09"))
    assert (p.route_type, p.payload_type, p.hop_count, p.payload) == (0, 5, 2, b"abc")
    assert p.path_byte == 2
    p = parse_packet(packet(route=3, payload=b"z", path=b"\x01\x02\x03\x04", hash_mode=1))
    assert (p.route_type, p.hop_count, p.payload) == (3, 2, b"z")


@pytest.mark.parametrize("route", [0, 3])
def test_transport_routes_need_four_code_bytes(route):
    assert parse_packet(packet(route=route, payload=b"x")) is not None
    full = packet(route=route, payload=b"x")
    assert parse_packet(full[:4]) is None  # codes cut short
    assert parse_packet(bytes([route | (4 << 2), 0, 0, 0, 0])) is None  # no path byte


def test_a_non_transport_route_has_no_code_bytes():
    assert parse_packet(bytes([1 | (4 << 2), 0, 0xAA])).payload == b"\xaa"
    assert parse_packet(bytes([2 | (4 << 2), 0, 0xAA])).payload == b"\xaa"


def test_payload_bounds_1_to_184():
    assert parse_packet(packet(payload=b"x" * 184)) is not None
    assert parse_packet(packet(payload=b"x" * 185)) is None
    assert parse_packet(packet(payload=b"")) is None
    assert parse_packet(packet(route=0, payload=b"x" * 185)) is None


def test_path_bounds_and_hash_mode():
    assert parse_packet(packet(path=b"x" * 64, hash_mode=1, payload=b"p")) is not None  # 32 hops * 2
    assert parse_packet(packet(path=b"x" * 63, hash_mode=2, payload=b"p")) is not None  # 21 hops * 3
    assert parse_packet(packet(path=b"x" * 66, hash_mode=2, payload=b"p")) is None  # 22 hops * 3 = 66
    assert parse_packet(packet(path=b"x" * 64, hash_mode=0, payload=b"p")) is not None  # 63 hops max is 63
    assert parse_packet(packet(path=b"x" * 68, hash_mode=1, payload=b"p")) is None  # 34 * 2
    assert parse_packet(packet(path=b"x", hash_mode=3, payload=b"p", hops=1)) is None  # reserved
    assert parse_packet(packet(path=b"", hash_mode=3, payload=b"p", hops=0)) is None


def test_truncation_anywhere_is_unparseable():
    assert parse_packet(b"") is None
    assert parse_packet(b"\x11") is None
    assert parse_packet(b"\x11\x00") is None  # no payload
    full = packet(path=b"\x01\x02\x03", payload=b"p")
    assert parse_packet(full[:-1]) is None  # path cut, no payload
    assert parse_packet(packet(path=b"", hops=5, payload=b"p")) is None  # the path claims more than there is


def test_payload_type_names():
    assert payload_type_name(0) == "REQUEST" and payload_type_name(9) == "TRACE" and payload_type_name(0x0F) == "RAW_CUSTOM"
    assert payload_type_name(0x0C) == "UNKNOWN_0x0c"
    assert payload_type_name(0x0E) == "UNKNOWN_0x0e"
    assert parse_packet(packet(ptype=0x0D)).payload_type == 0x0D
