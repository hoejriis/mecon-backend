"""Guards: the replay covers every published case and operation, and the facade matches the document."""
import asyncio
import json

from mecon_reader_backend.app import DECLARED, PREFIX
from replay import CASE_FILES, CASES_DIR, OPS, WORLDS, Replay, case_files_on_disk, load_cases

from mecon_reader_backend import create_app
from mecon_reader_backend.fakes import build


def test_every_case_file_on_disk_is_replayed():
    assert sorted(CASE_FILES) == case_files_on_disk()


def test_case_count_equals_the_files():
    on_disk = sum(len(json.loads((CASES_DIR / f"{f}.json").read_text())["cases"]) for f in case_files_on_disk())
    cases = load_cases()
    assert len(cases) == on_disk
    assert len({c["id"] for _, c in cases}) == on_disk


def test_every_operation_is_exercised_by_a_case():
    used = {s["request"]["operation"] for _, c in load_cases() for s in c["steps"] if "request" in s}
    assert used == set(OPS), sorted(set(OPS) ^ used)


def test_every_world_action_is_mapped():
    declared = set(WORLDS["actions"])
    used = {s["action"] for _, c in load_cases() for s in c["steps"] if "action" in s}
    assert used <= declared
    assert declared == set(Replay.ACTIONS)


def test_every_case_world_exists():
    assert {c["world"] for _, c in load_cases()} <= set(WORLDS["worlds"])


def test_the_facade_routes_every_operation_at_its_documented_path_and_method():
    world, lookup, core = build(WORLDS["worlds"]["two-fleets"])
    app = create_app(lookup, core)
    assert app.state.operations == {op: (o["method"], PREFIX + o["path"]) for op, o in OPS.items()}


def test_the_declared_status_table_matches_the_document():
    assert {op: set(s) for op, s in DECLARED.items()} == {op: o["statuses"] for op, o in OPS.items()}


def test_csrf_operations_are_exactly_the_writes():
    assert {op for op, o in OPS.items() if o["csrf"]} == {"logout", "markConversationRead", "createSendAttempt", "createLease"}


def test_the_contract_version_matches_the_document():
    from mecon_reader_backend.app import CONTRACT_VERSION
    from replay import OPENAPI
    major, minor = OPENAPI["info"]["version"].split("-")[0].split(".")[:2]
    assert CONTRACT_VERSION == f"{major}.{minor}"
