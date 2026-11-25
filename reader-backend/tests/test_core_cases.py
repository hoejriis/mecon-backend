"""One test per published reader-core case and target: a stub core over loopback HTTP, and the fake core.

A case either passes or is skipped as not applicable with its reason; a case is never counted as passed without
being run. Every not-applicable case is listed below with its reason, and the guards fail if a case is skipped
that is not listed, or listed but runs.
"""
import asyncio
import json

import pytest
from jsonschema import Draft202012Validator

from core_replay import FAKE_NO_SCHEMA, FAKE_NO_TOKEN, MODES, CoreReplay
from replay import NotApplicable
from stub_reader_core import CORE

CASES = CORE.load_cases()
CASE_IDS = [c["id"] for _, c in CASES]

# mode -> case id -> why the case does not apply to that target. Nothing else may be skipped.
NOT_APPLICABLE = {
    "http": {},
    "fake": {"transport-01": FAKE_NO_TOKEN, "transport-02": FAKE_NO_TOKEN, "transport-03": FAKE_NO_SCHEMA,
             "transport-04": FAKE_NO_TOKEN, "transport-05": FAKE_NO_SCHEMA},
}


@pytest.mark.parametrize("mode,case", [(m, c) for m in MODES for _, c in CASES],
                         ids=[f"{m}-{c['id']}" for m in MODES for _, c in CASES])
def test_core_case(mode, case):
    listed = NOT_APPLICABLE[mode].get(case["id"])
    try:
        asyncio.run(asyncio.wait_for(CoreReplay(case, mode).run(), 30))
    except NotApplicable as e:
        assert listed is not None, f"{case['id']} skipped on {mode} but not listed as not applicable: {e}"
        assert str(e) == listed, f"{case['id']} on {mode}: skipped for {e!r}, listed for {listed!r}"
        pytest.skip(f"not applicable: {e}")
    assert listed is None, f"{case['id']} is listed as not applicable on {mode} but ran"


def test_every_listed_case_exists_and_ids_are_unique():
    assert len(CASE_IDS) == len(set(CASE_IDS)), "case ids are unique"
    for mode in MODES:
        assert set(NOT_APPLICABLE[mode]) <= set(CASE_IDS), f"{mode} lists a case that does not exist"


def test_every_case_file_on_disk_is_replayed():
    assert sorted(CORE.case_files) == CORE.case_files_on_disk()


def test_case_count_equals_the_files():
    on_disk = sum(len(json.loads((CORE.cases_dir / f"{f}.json").read_text())["cases"])
                  for f in CORE.case_files_on_disk())
    assert len(CASES) == on_disk


def test_the_case_files_follow_their_schema():
    schema = json.loads((CORE.cases_dir / "cases.schema.json").read_text())
    val = Draft202012Validator(schema)
    for f in CORE.case_files_on_disk():
        errs = list(val.iter_errors(json.loads((CORE.cases_dir / f"{f}.json").read_text())))
        assert not errs, f"{f}: {errs[0].message}"


def test_every_operation_is_exercised_by_a_case_on_the_fake_too():
    used = {s["request"]["operation"] for _, c in CASES for s in c["steps"] if "request" in s}
    assert used == set(CORE.ops), sorted(set(CORE.ops) ^ used)
    na = set(NOT_APPLICABLE["fake"])
    on_fake = {s["request"]["operation"] for _, c in CASES if c["id"] not in na for s in c["steps"] if "request" in s}
    assert on_fake == set(CORE.ops), sorted(set(CORE.ops) - on_fake)


def test_every_world_action_is_mapped():
    declared = set(CORE.worlds["actions"])
    used = {s["action"] for _, c in CASES for s in c["steps"] if "action" in s}
    assert used <= declared
    assert declared == set(CORE.actions)


def test_every_case_world_exists():
    assert {c["world"] for _, c in CASES} <= set(CORE.worlds["worlds"])


@pytest.mark.parametrize("case_id,step,pointer,wrong", [
    ("reads-05", -2, "/code", "forbidden"),  # another user's conversation must stay a 404 not_found
    ("send-02", -1, None, 201),  # a repeat must answer 200
])
def test_the_runner_fails_a_case_whose_expectation_is_not_met(case_id, step, pointer, wrong):
    """A self-test: the same case with a wrong expectation fails on both targets."""
    case = json.loads(json.dumps(next(c for _, c in CASES if c["id"] == case_id)))
    if pointer is None:
        case["steps"][step]["expect"]["status"] = wrong
    else:
        case["steps"][step]["expect"]["body"][pointer] = wrong
    for mode in MODES:
        with pytest.raises(AssertionError):
            asyncio.run(CoreReplay(case, mode).run())
