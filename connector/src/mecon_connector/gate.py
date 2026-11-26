"""How the Connector reads the device's answer to its own `deployment.get` (the enrolment gate).

Shared by the MQTT transport (bridge.py) and the hold transport (hold.py); each decides what the
class means for its gate. See `enrolment_gate.classification` in contracts/connector/v1/mapping.json.

The firmware answers `deployment.get` with `ok`, `busy` (no memory) or `failed` (storage). `busy`
and `failed` say nothing about the record, so they are not "not provisioned".
"""

from __future__ import annotations


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
