"""Guards: the observation replay covers every published case and operation, and the module matches the document."""
import json

from mecon_reader_backend import create_app
from mecon_reader_backend.fakes import build_observations
from mecon_reader_backend.observations import DECLARED, PREFIX
from replay import OBSERVATIONS as C
from replay import Replay

EXPECTED_CASES = 14
EXPECTED_OPERATIONS = {"listObservers", "getObservationSnapshot", "streamObservationEvents"}


def test_the_contract_is_the_observation_contract():
    assert C.name == "mecon-observations"
    doc = json.loads((C.cases_dir / "observations.json").read_text())
    assert doc["contract"].startswith("mecon-observations/")


def test_every_case_file_on_disk_is_replayed():
    assert sorted(C.case_files) == C.case_files_on_disk()


def test_fourteen_cases_and_none_missing():
    cases = C.load_cases()
    on_disk = sum(len(json.loads((C.cases_dir / f"{f}.json").read_text())["cases"]) for f in C.case_files_on_disk())
    assert len(cases) == on_disk == EXPECTED_CASES
    assert len({c["id"] for _, c in cases}) == EXPECTED_CASES


def test_three_operations_exist_and_every_one_is_exercised():
    assert set(C.ops) == EXPECTED_OPERATIONS
    used = {s["request"]["operation"] for _, c in C.load_cases() for s in c["steps"] if "request" in s}
    assert used == EXPECTED_OPERATIONS


def test_every_world_action_is_mapped():
    declared = set(C.worlds["actions"])
    used = {s["action"] for _, c in C.load_cases() for s in c["steps"] if "action" in s}
    assert used <= declared
    assert declared == set(C.actions)


def test_every_case_world_exists():
    assert {c["world"] for _, c in C.load_cases()} <= set(C.worlds["worlds"])


def test_the_app_routes_every_operation_at_its_documented_path_and_method():
    world, lookup, core, ports = build_observations(C.worlds["worlds"]["two-fleets-observed"])
    app = create_app(lookup, core, **ports)
    assert app.state.observation_operations == {op: (o["method"], PREFIX + o["path"]) for op, o in C.ops.items()}
    assert C.openapi["servers"][0]["url"] == PREFIX


def test_the_declared_status_table_matches_the_document():
    assert {op: set(s) for op, s in DECLARED.items()} == {op: o["statuses"] for op, o in C.ops.items()}


def test_every_operation_is_get_only_with_no_csrf():
    assert {o["method"] for o in C.ops.values()} == {"GET"}
    assert not any(o["csrf"] for o in C.ops.values())


def test_an_action_the_contract_does_not_map_is_not_applicable():
    import asyncio

    import pytest

    from replay import NotApplicable
    case = {"id": "x-01", "world": "two-fleets-observed", "steps": [{"action": "rotate-lease-key"}]}
    with pytest.raises(NotApplicable):
        asyncio.run(Replay(case, contract=C).run())


def test_the_runner_fails_an_observation_case_whose_expectation_is_not_met():
    import asyncio
    import copy

    import pytest

    from replay import CaseFailed
    by_id = {c["id"]: c for _, c in C.load_cases()}
    edits = [
        ("observations-02", lambda c: c["steps"][1]["expect"]["match"][3].update(count=1)),
        ("observations-02", lambda c: c["steps"][1]["expect"]["headers"].update({"Cache-Control": "public"})),
        ("observations-10", lambda c: c["steps"][1]["expect"].update(status=200)),
        ("observations-06", lambda c: c["steps"][4]["expect"]["stream"]["match"][1].update(count=1)),
        ("observations-11", lambda c: c["steps"][1]["expect"]["body"].update({"/items": [1]})),
    ]
    for case_id, edit in edits:
        case = copy.deepcopy(by_id[case_id])
        edit(case)
        with pytest.raises(CaseFailed):
            asyncio.run(Replay(case, contract=C).run())
