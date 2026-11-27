"""The local marker of a board that needs a UF2 copy (contracts/connector-hold/v1, section 12.9).

On the nRF52 boards tested, a serial DFU that ends without completing once data writing has begun left a
bootloader that only a UF2 copy recovered: a later serial DFU printed success and the application never started. The Connector keeps one
small file in its state directory for as long as that is so, so a restart does not forget it. Fields only: the
job id, the data packets acknowledged and their total, a Unix timestamp, a short reason and the identity of the
device (from its hello) the transfer was for; never package bytes.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

MARKER_NAME = "dfu-needs-uf2.json"
_JOB_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$")
UNREADABLE = {"job": "unknown", "sent": 0, "total": 0, "at": 0, "reason": "marker-unreadable", "device": None}


def marker_path(state_dir: str) -> str:
    return os.path.join(state_dir, MARKER_NAME)


def write_marker(state_dir: str, mark: dict[str, Any]) -> None:
    """Writes the marker atomically: a temporary file in the same directory, flushed to disk, then renamed over
    the marker, so a reader sees the old file or the whole new one and never a part of it."""
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    path = marker_path(state_dir)
    tmp = path + ".tmp"
    data = (json.dumps(mark, separators=(",", ":"), sort_keys=True) + "\n").encode()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    try:
        dfd = os.open(state_dir, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass  # the rename is done; a directory that cannot be synced is not a reason to lose the marker


def check_writable(state_dir: str) -> None:
    """Raises OSError unless a file can be created, flushed to disk and removed in state_dir (a marker could be kept)."""
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    tmp = os.path.join(state_dir, f".probe.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, b"x")
        os.fsync(fd)
    finally:
        os.close(fd)
        os.unlink(tmp)


def read_marker(state_dir: str) -> dict[str, Any] | None:
    """The marker, or None when there is none. A file that is there but cannot be read as a marker still counts
    as one (the board is not known to be fine), with job "unknown" and the reason "marker-unreadable"."""
    path = marker_path(state_dir)
    try:
        with open(path, "rb") as f:
            raw = f.read(4096)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return dict(UNREADABLE)
    try:
        o = json.loads(raw)
        job, sent, total, at, reason = o["job"], o["sent"], o["total"], o["at"], o["reason"]
        device = o.get("device")
        if not (device is None or (isinstance(device, str) and 0 < len(device) <= 128)):
            device = None
        ok = (isinstance(job, str) and _JOB_RE.match(job) and all(type(v) is int and v >= 0 for v in (sent, total, at))
              and isinstance(reason, str))
    except (ValueError, KeyError, TypeError):
        ok = False
    if not ok:
        return dict(UNREADABLE)
    return {"job": job, "sent": sent, "total": total, "at": at, "reason": reason[:64], "device": device}


def clear_marker(state_dir: str) -> None:
    try:
        os.unlink(marker_path(state_dir))
    except FileNotFoundError:
        pass
