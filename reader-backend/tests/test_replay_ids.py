"""The replay's `unsequenced` checker itself (contracts/observations/v1/cases/README.md, "Id form checks")."""
import secrets

import pytest

from replay import looks_like_a_counter


@pytest.mark.parametrize("values", [
    ["x_1", "x_2", "x_12"],  # a plain counter
    ["x_0001a", "x_0002a"],  # a counter with a suffix
    ["x_000a", "x_000b"],  # a hex counter
    ["1_x", "2_x"],  # a leading counter
    ["obs_7", "obs_8"],  # row numbers behind a prefix
    ["x_1", "x_12"],  # one remainder empty after the common prefix
])
def test_every_counter_shape_is_caught(values):
    assert looks_like_a_counter(values)


def test_two_random_96_bit_ids_pass():
    for _ in range(200):
        a, b = "ob_" + secrets.token_hex(12), "ob_" + secrets.token_hex(12)
        assert not looks_like_a_counter([a, b]), (a, b)
    assert not looks_like_a_counter(["ob_3f9c0d1e2a4b5c6d7e8f9012", "ob_a07b1c2d3e4f506172839405"])


def test_base64_ids_pass():
    assert not looks_like_a_counter(["ob_Zx3-aQ9_bK2mN0pL7rT4uV", "ob_c8YwE1fG6hJ5kM2nP0qR9s"])
