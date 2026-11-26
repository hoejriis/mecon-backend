"""A small JSON Schema check for the reader-core answers, so the running facade needs no schema engine.

It reads the schemas copied from contracts/reader-core/v1 (`reader_core_schemas.py`) and knows exactly the keywords
those schemas use; a keyword or format it does not know fails at import, never silently passes.
`tests/test_http_core.py` checks it against a real JSON Schema validator on the contract's fixtures and on broken
variants of them.
"""
from __future__ import annotations

import functools
import ipaddress
import re
from typing import Any

from .http_lookup import parse_date_time
from .reader_core_schemas import SCHEMAS

KEYWORDS = frozenset(("type", "$ref", "properties", "required", "additionalProperties", "minLength", "maxLength",
                      "items", "allOf", "anyOf", "oneOf", "not", "enum", "const", "minimum", "maximum", "format",
                      "pattern", "uniqueItems"))
FORMATS = frozenset(("date-time", "email", "ipv4", "ipv6"))


def _type_ok(v: Any, t: str) -> bool:
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "null":
        return v is None
    if t == "integer":
        return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    raise ValueError(f"unknown type {t!r}")


def _eq(a: Any, b: Any) -> bool:
    """JSON equality: a boolean is never a number."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_eq(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    if _type_ok(a, "number") and _type_ok(b, "number"):
        return a == b
    return type(a) is type(b) and a == b


def _ecma_anchors(pattern: str) -> str:
    """The pattern with each `$` anchor (unescaped, outside a character class) written as `\\Z`.

    JSON Schema patterns are ECMA-262 regular expressions, where `$` (no multiline flag) matches only at the end of
    the input. Python's `$` also matches before a final newline, so "ab\\n" would pass "^ab$". Rewriting the anchor
    keeps the pattern's own meaning everywhere, not only where `$` is its last character."""
    out, i, in_class = [], 0, False
    while i < len(pattern):
        c = pattern[i]
        if c == "\\":
            out.append(pattern[i:i + 2])  # an escape, `\\$` included, is kept as it is
            i += 2
            continue
        if in_class:
            in_class = c != "]"
        elif c == "[":
            in_class = True
        elif c == "$":
            c = r"\Z"
        out.append(c)
        i += 1
    return "".join(out)


@functools.lru_cache(maxsize=None)
def compiled(pattern: str) -> re.Pattern:
    # re.ASCII: as in ECMA-262, \d, \w and \s are ASCII only (no other script's digits or letters).
    return re.compile(_ecma_anchors(pattern), re.ASCII)


def _format_ok(v: str, fmt: str) -> bool:
    if fmt == "date-time":
        return parse_date_time(v) is not None
    if fmt == "email":
        return "@" in v
    try:
        (ipaddress.IPv4Address if fmt == "ipv4" else ipaddress.IPv6Address)(v)
    except ValueError:
        return False
    return True


def check(schema: dict, v: Any) -> bool:
    for k, s in schema.items():
        if k == "$ref":
            if not check(SCHEMAS[s.rsplit("/", 1)[1]], v):
                return False
        elif k == "type":
            if not any(_type_ok(v, t) for t in (s if isinstance(s, list) else [s])):
                return False
        elif k == "properties":
            if isinstance(v, dict) and not all(check(sub, v[name]) for name, sub in s.items() if name in v):
                return False
        elif k == "required":
            if isinstance(v, dict) and not all(name in v for name in s):
                return False
        elif k == "additionalProperties":
            if isinstance(v, dict):
                extra = [name for name in v if name not in schema.get("properties", {})]
                if s is False and extra:
                    return False
                if isinstance(s, dict) and not all(check(s, v[name]) for name in extra):
                    return False
        elif k == "minLength":
            if isinstance(v, str) and len(v) < s:
                return False
        elif k == "maxLength":
            if isinstance(v, str) and len(v) > s:
                return False
        elif k == "items":
            if isinstance(v, list) and not all(check(s, x) for x in v):
                return False
        elif k == "allOf":
            if not all(check(sub, v) for sub in s):
                return False
        elif k == "anyOf":
            if not any(check(sub, v) for sub in s):
                return False
        elif k == "oneOf":
            if sum(1 for sub in s if check(sub, v)) != 1:
                return False
        elif k == "not":
            if check(s, v):
                return False
        elif k == "enum":
            if not any(_eq(v, e) for e in s):
                return False
        elif k == "const":
            if not _eq(v, s):
                return False
        elif k == "minimum":
            if _type_ok(v, "number") and v < s:
                return False
        elif k == "maximum":
            if _type_ok(v, "number") and v > s:
                return False
        elif k == "format":
            if isinstance(v, str) and not _format_ok(v, s):
                return False
        elif k == "pattern":
            if isinstance(v, str) and compiled(s).search(v) is None:
                return False
        elif k == "uniqueItems":
            if s and isinstance(v, list) and any(_eq(v[i], v[j]) for i in range(len(v)) for j in range(i)):
                return False
        else:
            raise ValueError(f"unsupported schema keyword {k!r}")
    return True


def valid(name: str, value: Any) -> bool:
    """True when `value` matches the contract's component schema `name`.

    The check descends only as deep as the schemas do (none refers to itself), never as deep as the value; a
    RecursionError is still answered False, so no input can make it raise."""
    try:
        return check(SCHEMAS[name], value)
    except RecursionError:
        return False


def _keywords_known(schema: Any) -> None:
    if isinstance(schema, list):
        for s in schema:
            _keywords_known(s)
        return
    if not isinstance(schema, dict):
        return
    for k, v in schema.items():
        if k not in KEYWORDS:
            raise ValueError(f"reader-core schema keyword {k!r} is not supported by core_schema")
        if k == "format" and v not in FORMATS:
            raise ValueError(f"reader-core schema format {v!r} is not supported by core_schema")
        if k == "properties":
            for sub in v.values():
                _keywords_known(sub)
        elif k in ("items", "not", "additionalProperties", "allOf", "anyOf", "oneOf"):
            _keywords_known(v)


_keywords_known(list(SCHEMAS.values()))
