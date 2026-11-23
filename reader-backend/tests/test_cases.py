"""One test per published Reader API case, replayed against the facade over the fake adapters."""
import asyncio

import pytest

from replay import NotApplicable, Replay, load_cases

CASES = load_cases()


@pytest.mark.parametrize("case", [c for _, c in CASES], ids=[c["id"] for _, c in CASES])
def test_case(case):
    try:
        asyncio.run(Replay(case).run())
    except NotApplicable as e:
        pytest.skip(f"not applicable: {e}")
