"""Replays every contracts/raw-capture/v1 fixture against the real Archive."""

import pytest

from conftest import RAW_FIXTURES, raw_fixture
from fakes.faulty_connection import FaultyConnection
from mecon_capture.archive import Archive, content_hash, is_valid_capture


def restore(arch, faulty):
    arch._conn = faulty._real


def run_append(arch, fx):
    """Apply an `append` fixture's request to the archive the way its limits and expected result say."""
    arch.max_payload_bytes = fx["limits"]["max_payload_bytes"]
    faulty = None
    if fx["result"]["storage"] == "unavailable":
        faulty = make_unavailable(arch)
    try:
        return arch.append(fx["request"]["batch_id"], fx["request"]["captures"])
    finally:
        if faulty is not None:
            restore(arch, faulty)


def make_unavailable(arch):
    faulty = FaultyConnection(arch._conn, lambda word, n: word == "BEGIN")
    arch._conn = faulty
    return faulty


def check_append(tmp_path, schemas, name, fx):
    arch = Archive(str(tmp_path / "a.sqlite3"))
    assert schemas["append-request"].is_valid(fx["request"]), name
    before = arch.counters()
    result = run_append(arch, fx)
    assert result == fx["result"], name
    assert schemas["append-result"].is_valid(result), name
    n = len(fx["request"]["captures"])
    after = arch.counters()
    if result["storage"] == "available":
        # the result is consistent with the request (README section 3), and accepted at the commit (section 4)
        assert result["committed"] + len(result["rejected"]) == n, name
        assert after["received"] - before["received"] == n, name
    else:
        assert (after["received"], after["committed"]) == (0, 0) and after["unavailable_batches"] == 1, name


def replay_after(tmp_path, names):
    arch = Archive(str(tmp_path / "d.sqlite3"))
    for fname in names:
        fx = dict(RAW_FIXTURES)[fname]
        assert fx["kind"] == "append", fname
        assert run_append(arch, fx) == fx["result"], fname
    return arch


def check_counters(tmp_path, schemas, name, fx):
    arch = replay_after(tmp_path, fx["after"])
    counters = arch.counters()
    assert counters == fx["counters"], name
    assert schemas["counters"].is_valid(counters), name
    assert counters["received"] == counters["committed"] + counters["rejected"] + counters["buffered"] + counters["dropped"]


def check_invalid(schemas, name, fx):
    assert fx["cases"], name
    for case in fx["cases"]:
        assert not schemas[case["schema"]].is_valid(case["value"]), case["note"]
        if case["schema"] == "capture":
            assert not is_valid_capture(case["value"]), case["note"]


KINDS = {"append": check_append, "counters": check_counters, "invalid": check_invalid}


def test_the_fixture_directory_is_not_empty_and_has_the_known_files():
    names = [n for n, _ in RAW_FIXTURES]
    assert len(names) >= 6 and any(n.startswith("F-") for n in names)


@pytest.mark.parametrize("name,fx", RAW_FIXTURES, ids=[n for n, _ in RAW_FIXTURES])
def test_every_raw_capture_fixture(tmp_path, schemas, name, fx):
    """Every file in contracts/raw-capture/v1/fixtures, dispatched on its kind. A kind not handled here fails."""
    kind = fx.get("kind")
    if kind == "append":
        check_append(tmp_path, schemas, name, fx)
    elif kind == "counters":
        check_counters(tmp_path, schemas, name, fx)
    elif kind == "invalid":
        check_invalid(schemas, name, fx)
    else:
        pytest.fail(f"{name}: unknown fixture kind {kind!r}; teach this test to replay it")


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


def test_fixture_f_stored_rows(tmp_path):
    fx = raw_fixture("F")
    arch = Archive(str(tmp_path / "f.sqlite3"))
    assert arch.append("f-1", fx["request"]["captures"])["stubbed"] == [0]
    stub, full = arch.read_committed()
    given = fx["request"]["captures"][0]["stub"]
    assert stub["stub"] and stub["payload"] is None
    assert (stub["payload_size"], stub["content_hash"]) == (given["size"], given["content_hash"])
    assert not full["stub"] and full["payload"] == b'{"raw":"1500aa"}'


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
