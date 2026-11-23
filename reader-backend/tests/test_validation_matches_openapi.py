"""The hand-written request validators agree with the OpenAPI schemas on a battery of bodies."""
import copy

import pytest

from mecon_reader_backend import validation as v
from replay import schema_validator


def _variants(valid: dict) -> list:
    out = [valid, None, [], "x", {}]
    def walk(obj, path):
        for k in list(obj):
            for repl in (None, "", 1, "x" * 129, [], {}, "x" * 255 + "@x"):
                d = copy.deepcopy(valid)
                ref = d
                for p in path:
                    ref = ref[p]
                ref[k] = repl
                out.append(d)
            d = copy.deepcopy(valid)
            ref = d
            for p in path:
                ref = ref[p]
            del ref[k]
            out.append(d)
            d = copy.deepcopy(valid)
            ref = d
            for p in path:
                ref = ref[p]
            ref["extra"] = True
            out.append(d)
            if isinstance(obj[k], dict):
                walk(obj[k], path + [k])
    walk(valid, [])
    return out


SEND = {"client_draft_id": "d", "client_attempt_id": "a", "identity_id": "i",
        "target": {"kind": "contact", "id": "c"}, "content": {"kind": "text", "text": "t"}}
EXTRA = [dict(SEND, target={"kind": "room", "id": "c"}), dict(SEND, content={"kind": "image", "text": "t"}),
         dict(SEND, target={"kind": "channel", "id": "x" * 128})]

BATTERIES = [
    ("LoginRequest", v.login_request, _variants({"email": "a@example.test"})
     + [{"email": "no-at-sign"}, {"email": "a" * 250 + "@x.t"}, {"email": "@"}]),
    ("ReadRequest", v.read_request, _variants({"up_to": "msg_1"}) + [{"up_to": "x" * 128}]),
    ("SendRequest", v.send_request, _variants(SEND) + EXTRA),
]


@pytest.mark.parametrize("schema,fn,bodies", BATTERIES, ids=[b[0] for b in BATTERIES])
def test_validator_agrees_with_the_document(schema, fn, bodies):
    val = schema_validator(schema)
    disagreements = []
    for body in bodies:
        want = val.is_valid(body)
        try:
            fn(body)
            got = True
        except v.Invalid:
            got = False
        if want != got:
            disagreements.append((body, want, got))
    assert not disagreements, disagreements[:3]
    assert any(val.is_valid(b) for b in bodies) and not all(val.is_valid(b) for b in bodies)


@pytest.mark.parametrize("value,ok", [(None, True), ("1", True), ("200", True), ("0", False), ("201", False),
                                      ("-1", False), ("x", False), ("1.5", False), ("", False)])
def test_limit_follows_the_document(value, ok):
    try:
        v.limit_param(value)
        assert ok
    except v.Invalid:
        assert not ok
