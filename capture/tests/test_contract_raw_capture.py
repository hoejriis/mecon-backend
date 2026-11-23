"""Replays contracts/raw-capture/v1 fixtures A to E against the real Archive."""

import pytest

from conftest import raw_fixture
from fakes.faulty_connection import FaultyConnection
from mecon_capture.archive import Archive, content_hash, is_valid_capture


def make_unavailable(arch):
    arch._conn = FaultyConnection(arch._conn, lambda word, n: word == "BEGIN")


def restore(arch, faulty):
    arch._conn = faulty._real


def test_fixtures_a_to_d(tmp_path, schemas):
    arch = Archive(str(tmp_path / "a.sqlite3"))
    for name in "ABC":
        fx = raw_fixture(name)
        assert schemas["append-request"].is_valid(fx["request"])
        arch.max_payload_bytes = fx["limits"]["max_payload_bytes"]
        if name == "C":
            make_unavailable(arch)
        result = arch.append(fx["request"]["batch_id"], fx["request"]["captures"])
        assert result == fx["result"], name
        assert schemas["append-result"].is_valid(result)
        # the result is consistent with the request (README section 3)
        n = len(fx["request"]["captures"])
        if result["storage"] == "available":
            assert result["committed"] + len(result["rejected"]) == n
    d = raw_fixture("D")
    assert d["after"] == ["A-committed-batch.json", "B-one-malformed-one-oversized.json", "C-storage-unavailable.json"]
    counters = arch.counters()
    assert counters == d["counters"]
    assert schemas["counters"].is_valid(counters)
    assert counters["received"] == counters["committed"] + counters["rejected"] + counters["buffered"] + counters["dropped"]


def test_fixture_a_to_c_stored_rows(tmp_path):
    arch = Archive(str(tmp_path / "a.sqlite3"))
    fa, fb = raw_fixture("A"), raw_fixture("B")
    arch.append("a-1", fa["request"]["captures"])
    arch.max_payload_bytes = 16
    arch.append("b-1", fb["request"]["captures"])
    rows = arch.read_committed()
    assert [r["capture_id"] for r in rows] == sorted(r["capture_id"] for r in rows)
    assert len({r["capture_id"] for r in rows}) == 6
    assert [r["retained"] for r in rows[:3]] == [False, True, False]
    stub = [r for r in rows if r["stub"]]
    assert len(stub) == 1 and stub[0]["payload"] is None
    assert stub[0]["payload_size"] == 41
    assert stub[0]["content_hash"] == content_hash(stub[0]["topic"], b"this payload is longer than sixteen bytes")
    assert rows[0]["payload"] == b'{"raw":"1500aa"}' and rows[0]["received_at"] == "2026-01-01T00:00:00.120Z"


def test_fixture_e_invalid_documents_are_rejected(schemas):
    e = raw_fixture("E")
    assert e["cases"]
    seen_capture = 0
    for case in e["cases"]:
        assert not schemas[case["schema"]].is_valid(case["value"]), case["note"]
        if case["schema"] == "capture":
            seen_capture += 1
            assert not is_valid_capture(case["value"]), case["note"]
    assert seen_capture == 3


def test_capture_validator_agrees_with_the_schema(schemas):
    base = raw_fixture("A")["request"]["captures"][0]
    edits = [
        ("source", "Upper"), ("source", ""), ("source", 5), ("topic", ""), ("topic", "t" * 512), ("topic", "t" * 513),
        ("topic", 7), ("payload_b64", ""), ("payload_b64", "AAAA"), ("payload_b64", "a b"), ("payload_b64", "AA=="),
        ("payload_b64", 5), ("retained", 1), ("retained", "true"), ("received_at", "2026-01-01T00:00:00Z"),
        ("received_at", "2026-01-01T00:00:00.1234Z"),
        ("received_at", "2026-01-01 00:00:00.123Z"),
    ]
    for key, val in edits:
        c = dict(base, **{key: val})
        assert is_valid_capture(c) == schemas["capture"].is_valid(c), (key, val)
    # ECMA-262 `$` (what the contract's validator uses) does not match before a trailing newline; Python's
    # jsonschema would, so this case is asserted on the archive's validator alone.
    assert not is_valid_capture(dict(base, received_at="2026-01-01T00:00:00.123Z\n"))
    assert not is_valid_capture(dict(base, source="own-broker\n"))
    assert not is_valid_capture(dict(base, received_at="\u0662026-01-01T00:00:00.123Z"))  # \d is ASCII in ECMA-262
    for key in base:
        c = {k: v for k, v in base.items() if k != key}
        assert not is_valid_capture(c) and not schemas["capture"].is_valid(c)
    extra = dict(base, extra=1)
    assert not is_valid_capture(extra) and not schemas["capture"].is_valid(extra)
    assert not is_valid_capture("x") and not is_valid_capture(None)


def test_payloads_that_pass_the_pattern_but_are_not_base64_are_malformed(tmp_path):
    """The schema's pattern admits 'A' and 'YQ' (not decodable); the archive cannot store them as bytes."""
    arch = Archive(str(tmp_path / "a.sqlite3"))
    base = raw_fixture("A")["request"]["captures"][0]
    caps = [dict(base, payload_b64="A"), dict(base, payload_b64="YQ"), dict(base, payload_b64="YQ==")]
    r = arch.append("x-1", caps)
    assert r["rejected"] == [{"index": 0, "reason": "malformed"}, {"index": 1, "reason": "malformed"}]
    assert r["committed"] == 1


def test_topic_that_cannot_be_utf8_is_malformed_not_a_storage_error(tmp_path):
    arch = Archive(str(tmp_path / "a.sqlite3"))
    base = raw_fixture("A")["request"]["captures"][0]
    r = arch.append("x-2", [dict(base, topic="bad\ud800topic"), base])
    assert r["storage"] == "available" and r["rejected"] == [{"index": 0, "reason": "malformed"}] and r["committed"] == 1


def test_content_hash_definition():
    import hashlib
    assert content_hash("a/b", b"xyz") == hashlib.sha256(b"a/b\x00xyz").hexdigest()
    assert content_hash("a/b", b"") != content_hash("a/b\x00", b"")  # not ambiguous at the boundary...
    assert content_hash("é", b"\x01") == hashlib.sha256("é".encode() + b"\x00\x01").hexdigest()
