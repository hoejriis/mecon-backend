import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
sys.dont_write_bytecode = True

from jsonschema import Draft202012Validator  # noqa: E402

CONTRACTS = pathlib.Path(__file__).resolve().parents[2] / "contracts"
SUB = CONTRACTS / "observation-subscription" / "v1"
RAW = CONTRACTS / "raw-capture" / "v1"


def load_json(p):
    return json.loads(pathlib.Path(p).read_text())


def schema_validator(path):
    return Draft202012Validator(load_json(path))


@pytest.fixture(scope="session")
def schemas():
    return {
        "profile": schema_validator(SUB / "schemas" / "profile.schema.json"),
        "status": schema_validator(SUB / "schemas" / "status.schema.json"),
        "capture": schema_validator(RAW / "schemas" / "capture.schema.json"),
        "append-request": schema_validator(RAW / "schemas" / "append-request.schema.json"),
        "append-result": schema_validator(RAW / "schemas" / "append-result.schema.json"),
        "counters": schema_validator(RAW / "schemas" / "counters.schema.json"),
    }


def raw_fixture(name):
    return load_json(next(RAW.joinpath("fixtures").glob(name + "-*.json")))


def sub_fixture(name):
    return load_json(next(SUB.joinpath("fixtures").glob(name + "-*.json")))
