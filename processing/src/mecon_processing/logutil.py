"""Structured, redacted logging: one JSON object per line on stderr.

Callers pass field values, never payloads. Bytes are replaced by their length,
long strings are cut, and the names of credential fields are refused, so a
packet dump or a secret cannot reach the log by accident.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any, TextIO

_FORBIDDEN = ("password", "secret", "token", "key", "payload", "cookie")


class Log:
    def __init__(self, stream: TextIO | None = None, level: str = "info") -> None:
        self._stream = stream
        self._debug = level == "debug"

    def event(self, level: str, event: str, **fields: Any) -> None:
        if level == "debug" and not self._debug:
            return
        rec: dict[str, Any] = {"ts": round(time.time(), 3), "level": level, "event": event}
        for k, v in fields.items():
            if any(f in k.lower() for f in _FORBIDDEN):
                raise ValueError(f"log field {k!r} is not allowed")
            if isinstance(v, (bytes, bytearray)):
                v = f"<{len(v)} bytes>"
            elif isinstance(v, str) and len(v) > 200:
                v = v[:200] + "..."
            elif not isinstance(v, (str, int, float, bool, type(None))):
                v = str(v)[:200]
            rec[k] = v
        out = self._stream or sys.stderr
        out.write(json.dumps(rec, separators=(",", ":")) + "\n")
        out.flush()

    def info(self, event: str, **f: Any) -> None:
        self.event("info", event, **f)

    def warn(self, event: str, **f: Any) -> None:
        self.event("warn", event, **f)

    def error(self, event: str, **f: Any) -> None:
        self.event("error", event, **f)

    def debug(self, event: str, **f: Any) -> None:
        self.event("debug", event, **f)
