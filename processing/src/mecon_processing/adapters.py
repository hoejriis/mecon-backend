"""The two payload formats (contract section 2): where the observer comes from, and the packet bytes and readings."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

ADAPTERS = ("observer_envelope", "raw_hex")

DEVICE_TIME_FLOOR = 1735689600  # 2025-01-01T00:00:00Z
DEVICE_TIME_AHEAD_S = 60

_HEX = re.compile(r"(?:[0-9a-fA-F]{2})*")
_NUMERIC = re.compile(r"[ \t\n\r\f\v]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\r\f\v]*")


@dataclass(frozen=True)
class Extraction:
    skip: str | None = None  # not_a_packet or malformed
    data: bytes = b""
    rssi: float | None = None
    snr: float | None = None
    device_observed_at: int | None = None


def observer_key(adapter: str, topic: str) -> str | None:
    parts = topic.split("/")
    if adapter == "observer_envelope":
        return parts[-2] if len(parts) >= 4 and parts[-2] else None
    if adapter == "raw_hex":
        return parts[-1] if len(parts) >= 2 and parts[-1] else None
    raise ValueError(f"unknown adapter {adapter!r}")


def number(v: object) -> float | int | None:
    """A JSON number, or a string holding one in the contract's grammar; anything else, and anything not
    finite, is null. A boolean is not a number."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        out = v
    elif isinstance(v, str) and _NUMERIC.fullmatch(v):
        out = float(v)
    else:
        return None
    if isinstance(out, float) and not math.isfinite(out):
        return None
    return out


def epoch_ms(received_at: str) -> int:
    dt = datetime.strptime(received_at, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000 + 0.5)


def trusted_device_time(raw: object, received_at: str) -> int | None:
    n = number(raw)
    if n is None:
        return None
    ts = math.trunc(n)
    if ts < DEVICE_TIME_FLOOR or ts * 1000 > epoch_ms(received_at) + DEVICE_TIME_AHEAD_S * 1000:
        return None
    return ts


def _reject_constant(name: str) -> None:
    raise ValueError(name)  # NaN, Infinity: not JSON


def extract(adapter: str, topic: str, payload: bytes, received_at: str) -> Extraction:
    if adapter == "observer_envelope":
        return _envelope(topic, payload, received_at)
    if adapter == "raw_hex":
        return _raw_hex(payload)
    raise ValueError(f"unknown adapter {adapter!r}")


def _envelope(topic: str, payload: bytes, received_at: str) -> Extraction:
    if not (topic.endswith("/packets") or topic.endswith("/raw")):
        return Extraction(skip="not_a_packet")
    try:
        env = json.loads(payload.decode("utf-8", errors="replace"), parse_constant=_reject_constant)
    except ValueError:
        return Extraction(skip="malformed")
    if not isinstance(env, dict):
        return Extraction(skip="malformed")
    if env.get("direction") == "tx":
        return Extraction(skip="not_a_packet")
    key = next((k for k in ("data", "raw_data", "raw") if k in env), None)
    hexs = env[key] if key is not None else None
    if not (isinstance(hexs, str) and _HEX.fullmatch(hexs)):
        return Extraction(skip="malformed")
    origin = env.get("origin_id")
    observer = observer_key("observer_envelope", topic)
    # Surrounding (ASCII) whitespace is ignored on both sides, and a blank origin_id is no claim (README section 2).
    if isinstance(origin, str) and origin.strip(" \t\r\n") and observer is not None \
            and origin.strip(" \t\r\n").lower() != observer.strip(" \t\r\n").lower():
        return Extraction(skip="origin_mismatch")
    rssi = number(env["RSSI"] if "RSSI" in env else env.get("rssi"))
    snr = number(env["SNR"] if "SNR" in env else env.get("snr"))
    if rssi == 0:
        rssi = None  # exactly 0 means "not measured"
    return Extraction(data=bytes.fromhex(hexs), rssi=rssi, snr=snr,
                      device_observed_at=trusted_device_time(env.get("ts"), received_at))


def _raw_hex(payload: bytes) -> Extraction:
    try:
        payload.decode("ascii")  # any byte over 0x7f is malformed
        text = payload.strip().decode("ascii")  # bytes.strip removes ASCII whitespace only
    except UnicodeDecodeError:
        return Extraction(skip="malformed")
    if not text or not _HEX.fullmatch(text):
        return Extraction(skip="malformed")
    return Extraction(data=bytes.fromhex(text))
