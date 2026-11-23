"""MeshCore packet framing and packet identity (contract section 3)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

PAYLOAD_TYPES = {
    0x00: "REQUEST", 0x01: "RESPONSE", 0x02: "TEXT_MESSAGE", 0x03: "ACK", 0x04: "ADVERT", 0x05: "GROUP_TEXT",
    0x06: "GROUP_DATA", 0x07: "ANON_REQUEST", 0x08: "PATH", 0x09: "TRACE", 0x0A: "MULTIPART", 0x0B: "CONTROL",
    0x0F: "RAW_CUSTOM",
}
TRACE = 0x09
MAX_PATH_BYTES = 64
MAX_PAYLOAD_BYTES = 184


@dataclass(frozen=True)
class Parsed:
    route_type: int
    payload_type: int
    path_byte: int
    hop_count: int
    payload: bytes


def payload_type_name(t: int) -> str:
    return PAYLOAD_TYPES.get(t, f"UNKNOWN_0x{t:02x}")


def parse_packet(data: bytes) -> Parsed | None:
    """The packet's framing, or None for bytes that are truncated, use the reserved hash mode, carry a path over
    64 bytes or a payload outside 1 to 184 bytes."""
    if len(data) < 2:
        return None
    header = data[0]
    route_type = header & 0x03
    payload_type = (header >> 2) & 0x0F
    offset = 1
    if route_type in (0, 3):  # transport routes carry four bytes of transport codes
        if len(data) < offset + 4:
            return None
        offset += 4
    if len(data) < offset + 1:
        return None
    path_byte = data[offset]
    offset += 1
    hash_mode = (path_byte >> 6) & 0x03
    if hash_mode == 3:
        return None
    hop_count = path_byte & 0x3F
    path_len = hop_count * (hash_mode + 1)
    if path_len > MAX_PATH_BYTES or len(data) < offset + path_len:
        return None
    offset += path_len
    payload_len = len(data) - offset
    if payload_len < 1 or payload_len > MAX_PAYLOAD_BYTES:
        return None
    return Parsed(route_type, payload_type, path_byte, hop_count, bytes(data[offset:]))


def packet_id(p: Parsed) -> str:
    """First 16 hex digits, uppercase, of SHA-256 over the payload type byte, for TRACE the path byte as two
    bytes little-endian, and the payload. Route type, transport codes and path are not part of it."""
    h = hashlib.sha256()
    h.update(bytes([p.payload_type]))
    if p.payload_type == TRACE:
        h.update(p.path_byte.to_bytes(2, "little"))
    h.update(p.payload)
    return h.hexdigest()[:16].upper()


def packet_type_name_of(p: Parsed) -> str:
    return payload_type_name(p.payload_type)
