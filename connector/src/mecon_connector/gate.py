"""How the Connector reads the device's answer to its own `deployment.get` (the enrolment gate).

Shared by the MQTT transport (bridge.py) and the hold transport (hold.py); each decides what the
class means for its gate. See `enrolment_gate.classification` in contracts/connector/v1/mapping.json.

The firmware answers `deployment.get` with `ok`, `busy` (no memory) or `failed` (storage). `busy`
and `failed` say nothing about the record, so they are not "not provisioned".
"""

from __future__ import annotations

from typing import Any


def classify_probe(obj: dict) -> str:
    """One of: provisioned, none, corrupt, malformed (status ok), busy, failed, refused (any other status)."""
    status = obj.get("status")
    if status == "ok":
        res = obj.get("result")
        state = res.get("state") if isinstance(res, dict) else None
        if state == "provisioned":
            return "provisioned"
        if state in ("none", "corrupt"):
            return state
        return "malformed"
    if status == "busy":
        return "busy"
    if status == "failed":
        return "failed"
    return "refused"


def probe_log_fields(obj: dict) -> dict:
    """The fields of the warn line for a non-ok answer: its status and error code only, never the
    signature or the result body."""
    status = obj.get("status")
    err = obj.get("error")
    if isinstance(err, dict):
        err = err.get("code")
    return {
        "status": status[:32] if isinstance(status, str) else None,
        "error": err[:64] if isinstance(err, str) else None,
    }


class BusyRun:
    """A run of `busy` answers in a row, for one transport. Holds the count, the time of the last decided
    answer (or of the port opening) and the logging of the run. It never touches the gate itself: it only
    says how soon to ask again and whether this busy answer counts as one `failed` answer.

    - The first `busy_backoff_after` busy answers are asked again after `busy_retry_s`; later ones after `retry_s`.
    - A busy answer that arrives when no decided answer has come for more than twice `recheck_s` counts as one
      `failed`. The first recheck is already due at `recheck_s`, so the window the Connector accepts without a
      fresh answer is that one; a further `recheck_s` of nothing but busy answers is what exceeds it.
    - Only the first busy answer of a run is a warning; the rest are debug lines; the end of the run is one
      info line with the count.
    """

    def __init__(self) -> None:
        self.count = 0
        self.since = 0.0  # the last decided answer, or the port opening if there has been none

    def end(self, log: Any) -> None:
        if self.count:
            log.info("gate_probe_busy_run_ended", count=self.count)
            self.count = 0

    def decided(self, now: float, log: Any) -> None:
        """A decided answer (provisioned, none, corrupt, malformed, refused) or a newly opened port."""
        self.end(log)
        self.since = now

    def on_busy(self, obj: dict, now: float, gate: Any, log: Any) -> tuple[float, bool]:
        """Returns (seconds until the next deployment.get, whether this answer counts as one `failed`)."""
        self.count += 1
        if self.count == 1:
            log.warn("gate_probe_not_ok", **probe_log_fields(obj))
        else:
            log.debug("gate_probe_not_ok", **probe_log_fields(obj))
        delay = gate.busy_retry_s if self.count <= gate.busy_backoff_after else gate.retry_s
        return delay, (now - self.since) > 2 * gate.recheck_s
