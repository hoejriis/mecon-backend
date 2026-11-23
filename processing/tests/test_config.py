import pytest
from conftest import CONTRACT

from mecon_processing.config import ConfigError, load, parse

GOOD = {"archive": {"path": "/a"}, "store": {"path": "/s"}, "sources": {"own-broker": {"adapter": "observer_envelope"}}}


def test_the_example_config_loads():
    cfg = load(str(CONTRACT.parents[2] / "processing" / "config.example.toml"))
    assert cfg.sources == {"own-broker": "observer_envelope", "open-feed": "raw_hex"}
    assert cfg.batch_max == 500 and cfg.health.bind == "127.0.0.1"


def test_defaults():
    cfg = parse(GOOD)
    assert (cfg.batch_max, cfg.interval_s, cfg.health.enabled, cfg.health.port, cfg.log_level) == (500, 3.0, True, 9471, "info")


@pytest.mark.parametrize("change,needle", [
    ({"sources": {"x": {"adapter": "observer_envelop"}}}, "adapter"),
    ({"sources": {"x": {}}}, "adapter"),
    ({"sources": {"x": {"adapter": "observer_envelope", "extra": 1}}}, "unknown setting"),
    ({"sources": {"X": {"adapter": "raw_hex"}}}, "source name"),
    ({"sources": {}}, "at least one"),
    ({"sources": None}, "at least one"),
    ({"archive": {}}, "archive.path"),
    ({"store": {"path": ""}}, "store.path"),
    ({"processor": {"batch_max": 501}}, "batch_max"),
    ({"processor": {"batch_max": 0}}, "batch_max"),
    ({"processor": {"batch_max": True}}, "batch_max"),
    ({"processor": {"interval_s": 0}}, "interval_s"),
    ({"processor": {"nope": 1}}, "unknown setting"),
    ({"health": {"port": 70000}}, "health.port"),
    ({"log": {"level": "loud"}}, "log.level"),
    ({"surprise": {}}, "unknown section"),
])
def test_config_problems_are_listed(change, needle):
    raw = {**GOOD, **change}
    if change.get("sources") is None and "sources" in change:
        raw["sources"] = None
    with pytest.raises(ConfigError) as e:
        parse(raw)
    assert needle in str(e.value)


def test_load_errors(tmp_path):
    with pytest.raises(ConfigError):
        load(str(tmp_path / "missing.toml"))
    (tmp_path / "bad.toml").write_text("[[[")
    with pytest.raises(ConfigError):
        load(str(tmp_path / "bad.toml"))
