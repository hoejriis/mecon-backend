import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
sys.dont_write_bytecode = True

from jsonschema import Draft202012Validator  # noqa: E402

CONTRACT = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "observation-processing" / "v1"


def load_json(p):
    return json.loads(pathlib.Path(p).read_text())


@pytest.fixture(scope="session")
def schemas():
    names = ["committed-capture", "outcome", "packet", "reception", "hour", "counters"]
    return {n: Draft202012Validator(load_json(CONTRACT / "schemas" / f"{n}.schema.json")) for n in names}
