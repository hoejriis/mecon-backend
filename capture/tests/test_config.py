import copy

import pytest

from conftest import schema_validator, SUB, sub_fixture
from mecon_capture import config as C

GOOD = {
    "archive": {"path": "/tmp/x.sqlite3"},
    "ingester": {"instance_tag": "a"},
    "profile": [sub_fixture("A")["cases"][0]["value"]],
}


def test_every_valid_profile_is_accepted():
    for case in sub_fixture("A")["cases"]:
        assert C.validate_profile(case["value"]) == [], case["note"]
        C.profile_from_dict(case["value"])


def test_every_invalid_profile_is_refused_with_a_reason():
    for case in sub_fixture("B")["cases"]:
        problems = C.validate_profile(case["value"])
        assert problems, case["note"]
        with pytest.raises(C.ConfigError):
            C.profile_from_dict(case["value"])


def test_validator_agrees_with_the_schema_on_mutated_profiles(schemas):
    """Single-field edits of the valid profiles: the code and the JSON Schema give the same verdict."""
    edits = [
        ("name", "Bad Name"), ("name", ""), ("name", "a" * 64), ("host", ""), ("host", "h" * 254), ("port", 0),
        ("port", 65536), ("port", "1883"), ("port", True), ("transport", "udp"), ("topics", []),
        ("topics", ["a", "a"]), ("topics", [""]), ("topics", ["a\u0000b"]), ("topics", ["t"] * 33),
        ("topics", "a/#"), ("qos", 0), ("qos", 1), ("qos", True), ("adapter", "Bad"), ("adapter", ""),
        ("ws_path", "mqtt"), ("ws_path", "/x"), ("tls", {"enabled": True}), ("tls", {"enabled": "yes", "verify": True}),
        ("tls", {"enabled": True, "verify": 1}), ("credential", {"password_ref": "PW"}), ("credential", {"username_ref": "lower"}),
        ("credential", {"username_ref": "U", "password_ref": "A" * 65}), ("extra", 1),
    ]
    checked = 0
    for case in sub_fixture("A")["cases"]:
        for key, val in edits:
            p = copy.deepcopy(case["value"])
            p[key] = val
            assert (C.validate_profile(p) == []) == schemas["profile"].is_valid(p), (key, val, case["note"])
            checked += 1
    for key in ("name", "host", "port", "transport", "tls", "topics", "adapter"):
        p = copy.deepcopy(sub_fixture("A")["cases"][0]["value"])
        del p[key]
        assert C.validate_profile(p)
        assert not schemas["profile"].is_valid(p)
    assert checked > 80


def test_profile_without_credential_has_no_refs():
    p = C.profile_from_dict(sub_fixture("A")["cases"][2]["value"])
    assert p.username_ref is None and p.ws_path == "/mqtt" and not p.tls_enabled


def test_parse_ok_and_defaults():
    cfg = C.parse(copy.deepcopy(GOOD))
    assert cfg.max_payload_bytes == 65536 and cfg.buffer_max == 5000 and cfg.max_receive_bytes == 65536 and cfg.health.bind == "127.0.0.1"
    assert cfg.profiles[0].name == "own-broker"


@pytest.mark.parametrize("mut", [
    lambda r: r["archive"].pop("path"),
    lambda r: r["ingester"].pop("instance_tag"),
    lambda r: r["archive"].update(max_payload_bytes=0),
    lambda r: r["ingester"].update(buffer_max=0),
    lambda r: r["ingester"].update(max_receive_bytes=0),
    lambda r: r["ingester"].update(max_receive_bytes=True),
    lambda r: r["ingester"].update(max_receive_bytes="64k"),
    lambda r: r["ingester"].update(batch_max=501),
    lambda r: r.update(profile=[]),
    lambda r: r.update(profile=r["profile"] * 2),  # duplicate name
    lambda r: r.update(unknown={}),
    lambda r: r["archive"].update(extra=1),
    lambda r: r["profile"][0]["tls"].update(verify=False),
])
def test_parse_refuses(mut):
    raw = copy.deepcopy(GOOD)
    mut(raw)
    with pytest.raises(C.ConfigError) as e:
        C.parse(raw)
    assert e.value.problems


def test_max_receive_bytes_is_configurable_from_one_up():
    raw = copy.deepcopy(GOOD)
    raw["ingester"]["max_receive_bytes"] = 1
    assert C.parse(raw).max_receive_bytes == 1


def test_load_toml_and_example_config(tmp_path):
    import pathlib
    ex = pathlib.Path(__file__).resolve().parents[1] / "config.example.toml"
    cfg = C.load(str(ex))
    assert [p.name for p in cfg.profiles] == ["own-broker", "feed-wss"]
    assert cfg.profiles[1].transport == "websockets"
    bad = tmp_path / "bad.toml"
    bad.write_text("not = [valid")
    with pytest.raises(C.ConfigError):
        C.load(str(bad))
    with pytest.raises(C.ConfigError):
        C.load(str(tmp_path / "missing.toml"))


def test_credentials_come_from_the_environment_at_call_time():
    p = C.profile_from_dict(sub_fixture("A")["cases"][0]["value"])
    env = {"OBSERVER_USERNAME": "u1", "OBSERVER_PASSWORD": "pw1"}
    assert C.read_credentials(p, env) == ("u1", "pw1")
    env["OBSERVER_PASSWORD"] = "pw2"  # read again, not cached
    assert C.read_credentials(p, env) == ("u1", "pw2")
    with pytest.raises(C.CredentialError) as e:
        C.read_credentials(p, {"OBSERVER_USERNAME": "u1"})
    assert "OBSERVER_PASSWORD" in str(e.value) and "pw" not in str(e.value).replace("OBSERVER_PASSWORD", "")


def test_config_holds_names_never_values():
    p = C.profile_from_dict(sub_fixture("A")["cases"][0]["value"])
    assert "pw" not in repr(p) and p.password_ref == "OBSERVER_PASSWORD"
