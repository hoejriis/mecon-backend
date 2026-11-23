"""Configuration: a TOML file, validated up front. Profiles follow profile.schema.json exactly."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from typing import Any, Mapping

NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
ENV_REF_RE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
ADAPTER_RE = re.compile(r"[a-z][a-z0-9_]{0,31}")
TAG_RE = re.compile(r"[a-z0-9]{1,8}")
PREFIX_RE = re.compile(r"[A-Za-z0-9._-]{1,32}")

DEFAULT_MAX_PAYLOAD_BYTES = 65536
DEFAULT_MAX_RECEIVE_BYTES = 65536
MAX_BATCH = 500


class ConfigError(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_profile(p: Any) -> list[str]:
    """The reasons `p` is not a valid source profile (profile.schema.json); empty when it is valid.

    Written out by hand so the ingester needs no JSON Schema library; the tests check it against
    the schema's own fixtures and against the schema itself.
    """
    if not isinstance(p, dict):
        return ["a profile must be an object"]
    out: list[str] = []
    allowed = {"name", "host", "port", "transport", "ws_path", "tls", "topics", "qos", "credential", "adapter"}
    for k in sorted(set(p) - allowed):
        out.append(f"unknown field {k!r}")
    for k in ("name", "host", "port", "transport", "tls", "topics", "adapter"):
        if k not in p:
            out.append(f"missing {k!r}")
    name = p.get("name")
    if "name" in p and not (isinstance(name, str) and NAME_RE.fullmatch(name)):
        out.append("name must match [a-z0-9][a-z0-9-]{0,62}")
    host = p.get("host")
    if "host" in p and not (isinstance(host, str) and 1 <= len(host) <= 253):
        out.append("host must be a string of 1 to 253 characters")
    port = p.get("port")
    if "port" in p and not (_is_int(port) and 1 <= port <= 65535):
        out.append("port must be an integer from 1 to 65535")
    transport = p.get("transport")
    if "transport" in p and transport not in ("tcp", "websockets"):
        out.append("transport must be 'tcp' or 'websockets'")
    if "ws_path" in p:
        ws = p["ws_path"]
        if not (isinstance(ws, str) and ws.startswith("/")):
            out.append("ws_path must be a string starting with '/'")
        if transport == "tcp":
            out.append("ws_path is only for transport 'websockets'")
    if "tls" in p:
        tls = p["tls"]
        if not isinstance(tls, dict):
            out.append("tls must be an object")
        else:
            for k in sorted(set(tls) - {"enabled", "verify"}):
                out.append(f"unknown field tls.{k}")
            if not isinstance(tls.get("enabled"), bool):
                out.append("tls.enabled must be a boolean")
            if tls.get("verify") is not True:
                out.append("tls.verify must be true: a profile cannot turn certificate verification off")
    if "topics" in p:
        t = p["topics"]
        if not isinstance(t, list) or not 1 <= len(t) <= 32:
            out.append("topics must be a list of 1 to 32 topic filters")
        else:
            if not all(isinstance(x, str) and 1 <= len(x) <= 256 and "\x00" not in x for x in t):
                out.append("each topic must be a string of 1 to 256 characters without NUL")
            elif len(set(t)) != len(t):
                out.append("topics must be unique")
    if "qos" in p and not (_is_int(p["qos"]) and p["qos"] == 0):
        out.append("qos must be 0: subscriptions are QoS 0")
    if "credential" in p:
        c = p["credential"]
        if not isinstance(c, dict):
            out.append("credential must be an object of environment variable names")
        else:
            for k in sorted(set(c) - {"username_ref", "password_ref"}):
                out.append(f"unknown field credential.{k}: a credential holds names, never values")
            if "username_ref" not in c:
                out.append("credential.username_ref is required")
            for k in ("username_ref", "password_ref"):
                if k in c and not (isinstance(c[k], str) and ENV_REF_RE.fullmatch(c[k])):
                    out.append(f"credential.{k} must be an environment variable name ([A-Z][A-Z0-9_]{{0,63}})")
    if "adapter" in p and not (isinstance(p["adapter"], str) and ADAPTER_RE.fullmatch(p["adapter"])):
        out.append("adapter must match [a-z][a-z0-9_]{0,31}")
    return out


@dataclass(frozen=True)
class Profile:
    name: str
    host: str
    port: int
    transport: str
    tls_enabled: bool
    topics: tuple[str, ...]
    adapter: str
    ws_path: str = "/mqtt"
    username_ref: str | None = None
    password_ref: str | None = None


def profile_from_dict(p: dict[str, Any]) -> Profile:
    problems = validate_profile(p)
    if problems:
        raise ConfigError(problems)
    cred = p.get("credential", {})
    return Profile(
        name=p["name"], host=p["host"], port=p["port"], transport=p["transport"],
        tls_enabled=p["tls"]["enabled"], topics=tuple(p["topics"]), adapter=p["adapter"],
        ws_path=p.get("ws_path", "/mqtt"),
        username_ref=cred.get("username_ref"), password_ref=cred.get("password_ref"),
    )


@dataclass(frozen=True)
class HealthConfig:
    enabled: bool = True
    bind: str = "127.0.0.1"
    port: int = 9470


@dataclass(frozen=True)
class Config:
    profiles: tuple[Profile, ...]
    archive_path: str
    max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES
    instance_tag: str = "a"
    client_id_prefix: str = "mecon-capture"
    buffer_max: int = 5000
    max_receive_bytes: int = DEFAULT_MAX_RECEIVE_BYTES
    batch_max: int = MAX_BATCH
    flush_interval_s: float = 1.0
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
    for k in sorted(set(raw) - {"archive", "ingester", "health", "log", "profile"}):
        problems.append(f"unknown section {k!r}")
    arch = _section(raw, "archive", {"path", "max_payload_bytes"}, problems)
    ing = _section(raw, "ingester", {"instance_tag", "client_id_prefix", "buffer_max", "max_receive_bytes", "batch_max", "flush_interval_s"}, problems)
    hl = _section(raw, "health", {"enabled", "bind", "port"}, problems)
    lg = _section(raw, "log", {"level"}, problems)

    path = arch.get("path")
    if not (isinstance(path, str) and path):
        problems.append("archive.path is required")
    mpb = arch.get("max_payload_bytes", DEFAULT_MAX_PAYLOAD_BYTES)
    if not (_is_int(mpb) and 1 <= mpb <= 1 << 30):
        problems.append("archive.max_payload_bytes must be an integer from 1 to 1073741824")
    tag = ing.get("instance_tag")
    if not (isinstance(tag, str) and TAG_RE.fullmatch(tag)):
        problems.append("ingester.instance_tag is required: 1 to 8 characters of [a-z0-9], unique per ingester instance")
    prefix = ing.get("client_id_prefix", "mecon-capture")
    if not (isinstance(prefix, str) and PREFIX_RE.fullmatch(prefix)):
        problems.append("ingester.client_id_prefix must be 1 to 32 characters of [A-Za-z0-9._-]")
    bmax = ing.get("buffer_max", 5000)
    if not (_is_int(bmax) and 1 <= bmax <= 1_000_000):
        problems.append("ingester.buffer_max must be an integer from 1 to 1000000")
    mrb = ing.get("max_receive_bytes", DEFAULT_MAX_RECEIVE_BYTES)
    if not (_is_int(mrb) and mrb >= 1):
        problems.append("ingester.max_receive_bytes must be an integer of at least 1")
    batch = ing.get("batch_max", MAX_BATCH)
    if not (_is_int(batch) and 1 <= batch <= MAX_BATCH):
        problems.append(f"ingester.batch_max must be an integer from 1 to {MAX_BATCH}")
    fi = ing.get("flush_interval_s", 1.0)
    if not (isinstance(fi, (int, float)) and not isinstance(fi, bool) and 0.01 <= fi <= 60):
        problems.append("ingester.flush_interval_s must be a number from 0.01 to 60")
    h_enabled = hl.get("enabled", True)
    h_bind = hl.get("bind", "127.0.0.1")
    h_port = hl.get("port", 9470)
    if not isinstance(h_enabled, bool):
        problems.append("health.enabled must be a boolean")
    if not (isinstance(h_bind, str) and h_bind):
        problems.append("health.bind must be a string")
    if not (_is_int(h_port) and 0 <= h_port <= 65535):
        problems.append("health.port must be an integer from 0 to 65535")
    level = lg.get("level", "info")
    if level not in ("debug", "info", "warn", "error"):
        problems.append("log.level must be debug, info, warn or error")

    profiles: list[Profile] = []
    rawp = raw.get("profile")
    if not isinstance(rawp, list) or not rawp:
        problems.append("at least one [[profile]] is required")
    else:
        seen: set[str] = set()
        for i, p in enumerate(rawp):
            errs = validate_profile(p)
            problems.extend(f"profile[{i}]: {e}" for e in errs)
            if not errs:
                if p["name"] in seen:
                    problems.append(f"profile[{i}]: duplicate name {p['name']!r}")
                seen.add(p["name"])
                profiles.append(profile_from_dict(p))
    if problems:
        raise ConfigError(problems)
    return Config(
        profiles=tuple(profiles), archive_path=path, max_payload_bytes=mpb, instance_tag=tag,
        client_id_prefix=prefix, buffer_max=bmax, max_receive_bytes=mrb, batch_max=batch, flush_interval_s=float(fi),
        health=HealthConfig(h_enabled, h_bind, h_port), log_level=level,
    )


def load(path: str) -> Config:
    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except OSError as e:
        raise ConfigError([f"cannot read config: {type(e).__name__}"]) from e
    except tomllib.TOMLDecodeError as e:
        raise ConfigError([f"config is not valid TOML: {e}"]) from e
    return parse(raw)


class CredentialError(Exception):
    """A named environment variable is not set. Carries the variable's name, never a value."""


def read_credentials(profile: Profile, environ: Mapping[str, str] | None = None) -> tuple[str | None, str | None]:
    """(username, password) read from the environment now, at connect time."""
    env = os.environ if environ is None else environ
    user = pw = None
    if profile.username_ref is not None:
        user = env.get(profile.username_ref)
        if not user:
            raise CredentialError(f"environment variable {profile.username_ref} is not set")
    if profile.password_ref is not None:
        pw = env.get(profile.password_ref)
        if pw is None:
            raise CredentialError(f"environment variable {profile.password_ref} is not set")
    return user, pw
