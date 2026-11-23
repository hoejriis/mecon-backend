"""Configuration: a TOML file, validated up front. An unknown adapter is a configuration error, never a fallback."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from typing import Any

from .adapters import ADAPTERS

NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
MAX_BATCH = 500


class ConfigError(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_sources(sources: Any) -> list[str]:
    """The reasons a source-to-adapter map is not valid; empty when it is."""
    if not isinstance(sources, dict) or not sources:
        return ["at least one [sources.<name>] is required"]
    out: list[str] = []
    for name, s in sources.items():
        if not (isinstance(name, str) and NAME_RE.fullmatch(name)):
            out.append(f"source name {name!r} must match [a-z0-9][a-z0-9-]{{0,62}}")
        if not isinstance(s, dict):
            out.append(f"sources.{name} must be a table")
            continue
        for k in sorted(set(s) - {"adapter"}):
            out.append(f"unknown setting sources.{name}.{k}")
        if s.get("adapter") not in ADAPTERS:
            out.append(f"sources.{name}.adapter must be one of {', '.join(ADAPTERS)}; got {s.get('adapter')!r}")
    return out


@dataclass(frozen=True)
class HealthConfig:
    enabled: bool = True
    bind: str = "127.0.0.1"
    port: int = 9471


@dataclass(frozen=True)
class Config:
    archive_path: str
    store_path: str
    sources: dict[str, str]  # source name -> adapter
    batch_max: int = MAX_BATCH
    interval_s: float = 3.0
    health: HealthConfig = field(default_factory=HealthConfig)
    log_level: str = "info"


def _section(raw: dict[str, Any], key: str, allowed: set[str], problems: list[str]) -> dict[str, Any]:
    sec = raw.get(key, {})
    if not isinstance(sec, dict):
        problems.append(f"[{key}] must be a table")
        return {}
    for k in sorted(set(sec) - allowed):
        problems.append(f"unknown setting {key}.{k}")
    return sec


def parse(raw: dict[str, Any]) -> Config:
    problems: list[str] = []
    for k in sorted(set(raw) - {"archive", "store", "processor", "health", "log", "sources"}):
        problems.append(f"unknown section {k!r}")
    arch = _section(raw, "archive", {"path"}, problems)
    store = _section(raw, "store", {"path"}, problems)
    proc = _section(raw, "processor", {"batch_max", "interval_s"}, problems)
    hl = _section(raw, "health", {"enabled", "bind", "port"}, problems)
    lg = _section(raw, "log", {"level"}, problems)
    for name, sec in (("archive", arch), ("store", store)):
        if not (isinstance(sec.get("path"), str) and sec["path"]):
            problems.append(f"{name}.path is required")
    batch = proc.get("batch_max", MAX_BATCH)
    if not (_is_int(batch) and 1 <= batch <= MAX_BATCH):
        problems.append(f"processor.batch_max must be an integer from 1 to {MAX_BATCH}")
    interval = proc.get("interval_s", 3.0)
    if not (isinstance(interval, (int, float)) and not isinstance(interval, bool) and 0.01 <= interval <= 3600):
        problems.append("processor.interval_s must be a number from 0.01 to 3600")
    enabled, bind, port = hl.get("enabled", True), hl.get("bind", "127.0.0.1"), hl.get("port", 9471)
    if not isinstance(enabled, bool):
        problems.append("health.enabled must be a boolean")
    if not (isinstance(bind, str) and bind):
        problems.append("health.bind must be a string")
    if not (_is_int(port) and 0 <= port <= 65535):
        problems.append("health.port must be an integer from 0 to 65535")
    level = lg.get("level", "info")
    if level not in ("debug", "info", "warn", "error"):
        problems.append("log.level must be debug, info, warn or error")
    src = raw.get("sources")
    problems.extend(validate_sources(src))
    if problems:
        raise ConfigError(problems)
    return Config(archive_path=arch["path"], store_path=store["path"],
                  sources={n: s["adapter"] for n, s in src.items()}, batch_max=batch, interval_s=float(interval),
                  health=HealthConfig(enabled, bind, port), log_level=level)


def load(path: str) -> Config:
    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except OSError as e:
        raise ConfigError([f"cannot read config: {type(e).__name__}"]) from e
    except tomllib.TOMLDecodeError as e:
        raise ConfigError([f"config is not valid TOML: {e}"]) from e
    return parse(raw)
