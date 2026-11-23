"""Request validation for the Reader API's request bodies, path parameters and query parameters.

Hand-written so the running facade needs no schema engine. `tests/test_validation_matches_openapi.py`
checks these functions against the OpenAPI document's own schemas with a real JSON Schema validator,
so the two cannot drift apart unnoticed.
"""
from __future__ import annotations

from typing import Any


class Invalid(Exception):
    """The request breaks the schema. `where` names the field for the message."""

    def __init__(self, where: str):
        self.where = where
        super().__init__(where)


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _require_object(v: Any, where: str, required: tuple[str, ...], allowed: tuple[str, ...]) -> dict:
    if not isinstance(v, dict):
        raise Invalid(where)
    for k in required:
        if k not in v:
            raise Invalid(f"{where}.{k}")
    for k in v:
        if k not in allowed:
            raise Invalid(f"{where}.{k}")
    return v


def opaque_id(v: Any, where: str) -> str:
    if not _is_str(v) or not 1 <= len(v) <= 128:
        raise Invalid(where)
    return v


def login_request(body: Any) -> dict:
    _require_object(body, "body", ("email",), ("email",))
    email = body["email"]
    # format: email is checked as the JSON Schema format checker does: an "@" in a string.
    if not _is_str(email) or len(email) > 254 or "@" not in email:
        raise Invalid("body.email")
    return body


def read_request(body: Any) -> dict:
    _require_object(body, "body", ("up_to",), ("up_to",))
    opaque_id(body["up_to"], "body.up_to")
    return body


def _target(v: Any, where: str) -> None:
    # Target is open (no additionalProperties: false in the document).
    if not isinstance(v, dict) or "kind" not in v or "id" not in v:
        raise Invalid(where)
    if v["kind"] not in ("contact", "channel"):
        raise Invalid(f"{where}.kind")
    opaque_id(v["id"], f"{where}.id")


def send_request(body: Any) -> dict:
    fields = ("client_draft_id", "client_attempt_id", "identity_id", "target", "content")
    _require_object(body, "body", fields, fields)
    for k in ("client_draft_id", "client_attempt_id", "identity_id"):
        opaque_id(body[k], f"body.{k}")
    _target(body["target"], "body.target")
    content = _require_object(body["content"], "body.content", ("kind", "text"), ("kind", "text"))
    if content["kind"] != "text":
        raise Invalid("body.content.kind")
    if not _is_str(content["text"]) or len(content["text"]) < 1:
        raise Invalid("body.content.text")
    return body


def cursor_param(v: str | None) -> str | None:
    if v is not None and len(v) > 512:
        raise Invalid("query.cursor")
    return v


def limit_param(v: str | None) -> int:
    if v is None:
        return 50
    if not (v.isascii() and v.isdigit()) or not 1 <= int(v) <= 200:
        raise Invalid("query.limit")
    return int(v)


def login_request_id(v: str) -> bool:
    """True when the poll id is well formed (16..128 characters)."""
    return 16 <= len(v) <= 128
