"""The replay runner fails a case whose expectation is not met (it is not a rubber stamp)."""
import asyncio
import copy

import pytest

from replay import CaseFailed, Replay, load_cases

BY_ID = {c["id"]: c for _, c in load_cases()}


def _broken(case_id, edit):
    case = copy.deepcopy(BY_ID[case_id])
    edit(case)
    return case


@pytest.mark.parametrize("case_id,edit", [
    ("session-01", lambda c: c["steps"][0]["expect"].update(status=201)),
    ("session-01", lambda c: c["steps"][0]["expect"]["headers"].update({"Cache-Control": "public"})),
    ("session-01", lambda c: c["steps"][0]["expect"].update(schema="Session")),
    ("devices-01", lambda c: c["steps"][1]["expect"]["match"][1].update(count=1)),
    ("events-01", lambda c: c["steps"][6]["expect"]["stream"]["match"][0]["where"].update({"/kind": "message"})),
    ("leases-01", lambda c: c["steps"][3]["expect"]["lease"].update(user_id="usr_someone_else")),
    ("leases-02", lambda c: c["steps"][3]["expect"]["lease"].update(operations_exclude=["receive"])),
    ("session-02", lambda c: c["steps"][1]["expect"]["body"].update({"/state": "approved"})),
], ids=["status", "header", "schema", "match", "stream", "lease-user", "lease-ops", "body"])
def test_runner_fails_an_unmet_expectation(case_id, edit):
    with pytest.raises(CaseFailed):
        asyncio.run(Replay(_broken(case_id, edit)).run())


def test_runner_fails_a_lease_signed_by_an_unserved_key():
    case = copy.deepcopy(BY_ID["leases-06"])
    case["steps"][2] = {"action": "revoke-lease-keys"}  # revoked keys are dropped: the lease no longer verifies
    case["steps"][3]["expect"]["match"] = []
    with pytest.raises(CaseFailed, match="not in the served keys"):
        asyncio.run(Replay(case).run())
