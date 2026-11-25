"""One test per published session-lookup case and target: the HTTP adapter against a stub core, and the fake.

A case either passes or is skipped as not applicable with its reason; a case is never counted as passed
without being run. Every not-applicable case is listed below with its reason, and the guards fail if a
case is skipped that is not listed, or listed but runs.
"""
import asyncio
import json

import pytest
from jsonschema import Draft202012Validator

from lookup_replay import FAKE_NO_TOKEN, LOOKUP, MODES, LookupReplay
from replay import NotApplicable

CASES = LOOKUP.load_cases()
CASE_IDS = [c["id"] for _, c in CASES]

# mode -> case id -> why the case does not apply to that target. Nothing else may be skipped.
NOT_APPLICABLE = {
    "http": {},
    "fake": {"lookup-15": FAKE_NO_TOKEN, "lookup-16": FAKE_NO_TOKEN, "lookup-20": FAKE_NO_TOKEN},
}


@pytest.mark.parametrize("mode,case", [(m, c) for m in MODES for _, c in CASES],
                         ids=[f"{m}-{c['id']}" for m in MODES for _, c in CASES])
def test_lookup_case(mode, case, tmp_path):
    listed = NOT_APPLICABLE[mode].get(case["id"])
    try:
        asyncio.run(asyncio.wait_for(LookupReplay(case, mode, tmp_path).run(), 30))
    except NotApplicable as e:
        assert listed is not None, f"{case['id']} skipped on {mode} but not listed as not applicable: {e}"
        assert str(e) == listed, f"{case['id']} on {mode}: skipped for {e!r}, listed for {listed!r}"
        pytest.skip(f"not applicable: {e}")
    assert listed is None, f"{case['id']} is listed as not applicable on {mode} but ran"


def test_every_case_id_is_run_or_listed():
    assert len(CASE_IDS) == len(set(CASE_IDS)), "case ids are unique"
    for mode in MODES:
        assert set(NOT_APPLICABLE[mode]) <= set(CASE_IDS), f"{mode} lists a case that does not exist"
    assert {c["id"] for _, c in CASES} == set(CASE_IDS)


def test_every_case_file_on_disk_is_replayed():
    assert sorted(LOOKUP.case_files) == LOOKUP.case_files_on_disk()


def test_case_count_equals_the_files():
    on_disk = sum(len(json.loads((LOOKUP.cases_dir / f"{f}.json").read_text())["cases"])
                  for f in LOOKUP.case_files_on_disk())
    assert len(CASES) == on_disk


def test_the_case_files_follow_their_schema():
    schema = json.loads((LOOKUP.cases_dir / "cases.schema.json").read_text())
    val = Draft202012Validator(schema)
    for f in LOOKUP.case_files_on_disk():
        errs = list(val.iter_errors(json.loads((LOOKUP.cases_dir / f"{f}.json").read_text())))
        assert not errs, f"{f}: {errs[0].message}"


def test_every_operation_is_exercised_by_a_case():
    used = {s["request"]["operation"] for _, c in CASES for s in c["steps"] if "request" in s}
    assert used == set(LOOKUP.ops), sorted(set(LOOKUP.ops) ^ used)


def test_every_world_action_is_mapped():
    declared = set(LOOKUP.worlds["actions"])
    used = {s["action"] for _, c in CASES for s in c["steps"] if "action" in s}
    assert used <= declared
    assert declared == set(LOOKUP.actions)


def test_every_case_world_exists():
    assert {c["world"] for _, c in CASES} <= set(LOOKUP.worlds["worlds"])


def test_the_runner_fails_a_case_whose_expectation_is_not_met(tmp_path):
    """A self-test: the same case with a wrong expected reason fails on both targets."""
    case = json.loads(json.dumps(next(c for _, c in CASES if c["id"] == "lookup-03")))
    case["steps"][-1]["expect"]["body"]["/reason"] = "revoked"
    for mode in MODES:
        with pytest.raises(AssertionError):
            asyncio.run(LookupReplay(case, mode, tmp_path).run())
