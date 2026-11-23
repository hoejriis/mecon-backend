"""One test per published observation case (contracts/observations/v1/cases), replayed against the same app."""
import asyncio

import pytest

from replay import OBSERVATIONS, NotApplicable, Replay

CASES = OBSERVATIONS.load_cases()


@pytest.mark.parametrize("case", [c for _, c in CASES], ids=[c["id"] for _, c in CASES])
def test_case(case):
    try:
        asyncio.run(Replay(case, contract=OBSERVATIONS).run())
    except NotApplicable as e:
        pytest.fail(f"a published case is not applicable here, and none may be: {e}")
