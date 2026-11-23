"""Replays every fixture file of the observation-processing contract. An unknown kind fails the test."""

import copy

import pytest
from conftest import CONTRACT, load_json
from helpers import InjectedFault, ListSource, boom_after_writes, make

from mecon_processing.documents import from_document, validate_committed
from jsonschema import Draft202012Validator

FILES = sorted((CONTRACT / "fixtures").glob("*.json"))
FIXTURE_SCHEMA = Draft202012Validator(load_json(CONTRACT / "fixtures.schema.json"))


def run_process(tmp_path, fx, name="p.sqlite3"):
    """Feed a fixture's captures through the real processor and store, honouring steps and crashes."""
    adapters = {n: s["adapter"] for n, s in fx["sources"].items()}
    store, proc = make(tmp_path, adapters, name=name)
    src = ListSource([from_document(c) for c in fx["captures"]])
    for step in fx.get("steps", [{"take": len(fx["captures"])}]):
        before = (store.outcomes(), store.packets(), store.receptions(), store.hours(), store.progress())
        if step.get("crash"):
            with pytest.raises(InjectedFault):
                proc.run_pending(src, step["take"], fault=boom_after_writes(store, len(before[0]) + 1))
            after = (store.outcomes(), store.packets(), store.receptions(), store.hours(), store.progress())
            assert after == before, "a crashed step must leave nothing of its batch"
        else:
            proc.run_pending(src, step["take"])
    return store, proc, src


def state(store):
    return {"outcomes": store.outcomes(), "packets": store.packets(), "receptions": store.receptions(),
            "hours": store.hours()}


def test_every_fixture_file_is_listed_and_valid():
    assert [f.name[0] for f in FILES] == ["A", "B", "C", "D", "E"]
    for f in FILES:
        doc = load_json(f)
        assert FIXTURE_SCHEMA.is_valid(doc), f.name
        assert doc["fixture"] == f.name[0]


def replay(fx, tmp_path, schemas):
    kind = fx["kind"]
    if kind == "process":
        replay_process(tmp_path, fx, schemas)
    elif kind == "counters":
        replay_counters(tmp_path, fx, schemas)
    elif kind == "invalid":
        replay_invalid(fx, schemas)
    else:
        pytest.fail(f"unknown fixture kind {kind!r}")


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_fixture(path, tmp_path, schemas):
    replay(load_json(path), tmp_path, schemas)


def test_an_unknown_fixture_kind_fails(tmp_path, schemas):
    with pytest.raises(pytest.fail.Exception):
        replay({"fixture": "Z", "kind": "mystery"}, tmp_path, schemas)


def replay_process(tmp_path, fx, schemas):
    for c in fx["captures"]:
        assert validate_committed(c) == []
        assert schemas["committed-capture"].is_valid(c)
    store, proc, src = run_process(tmp_path, fx)
    got, want = state(store), fx["expect"]
    for key in ("outcomes", "packets", "receptions", "hours"):
        assert got[key] == want[key], key
    for key, schema in (("outcomes", "outcome"), ("packets", "packet"), ("receptions", "reception"), ("hours", "hour")):
        for doc in got[key]:
            assert schemas[schema].is_valid(doc), (key, doc)
    # nothing is left pending, and the stored hours equal a fold over the receptions
    assert src.pending(store.progress()) == (0, None)
    assert store.hours() == store.computed_hours()
    assert store.rebuild_hours() == store.hours() == want["hours"]
    # the same captures in one uninterrupted pass give the same state
    one = copy.deepcopy(fx)
    one.pop("steps", None)
    store2, _, _ = run_process(tmp_path, one, name="one.sqlite3")
    assert state(store2) == got


def replay_counters(tmp_path, fx, schemas):
    total = None
    for i, letter in enumerate(fx["after"]):
        src_fx = load_json(next((CONTRACT / "fixtures").glob(f"{letter}-*.json")))
        assert src_fx["kind"] == "process"
        store, proc, src = run_process(tmp_path, src_fx, name=f"c{i}.sqlite3")
        c = proc.counters(src)
        assert schemas["counters"].is_valid(c)
        assert c["processed"] == c["receptions"] + sum(c["skipped"].values())
        if total is None:
            total = c
        else:
            total["processed"] += c["processed"]
            total["receptions"] += c["receptions"]
            for k, v in c["skipped"].items():
                total["skipped"][k] += v
    assert total == fx["counters"]
    assert schemas["counters"].is_valid(fx["counters"])


def replay_invalid(fx, schemas):
    for case in fx["cases"]:
        assert not schemas[case["schema"]].is_valid(case["value"]), case["note"]
        if case["schema"] == "committed-capture":
            assert validate_committed(case["value"]) != [], case["note"]
            with pytest.raises(ValueError):
                from_document(case["value"])
