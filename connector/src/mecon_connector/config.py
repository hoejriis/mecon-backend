"""Configuration: TOML file, validated up front, fail closed on anything unsafe."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .framing import CONSOLE_MAX_LINE, CONSOLE_PREFIX, MECON_MAX_MESSAGE


class ConfigError(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ROOT_RE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
TOPIC_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
BROKER_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")


@dataclass(frozen=True)
class Selector:
    by_id: str | None = None  # fnmatch pattern against a /dev/serial/by-id entry name
    vid: int | None = None
    pid: int | None = None
    usb_serial: str | None = None


@dataclass(frozen=True)
class DeviceConfig:
    mode: str  # "companion" | "console"
    baud: int
    selector: Selector
    stall_s: float
    max_downlink_bytes: int


@dataclass(frozen=True)
class BrokerConfig:
    name: str
    host: str
    port: int
    tls: bool
    ca_file: str | None
    username: str | None
    password_file: str | None
    insecure_allow_plain: bool


@dataclass(frozen=True)
class MqttConfig:
    client_id: str
    topic_root: str
    topic_up: str
    topic_down: str
    topic_status: str
    upstream_qos: int
    keepalive_s: int
    brokers: tuple[BrokerConfig, ...]
    connect_timeout_s: float
    backoff_base_s: float
    backoff_max_s: float
    backoff_jitter: float
    stable_after_s: float
    hold_down_s: float


@dataclass(frozen=True)
class QueueConfig:
    upstream_max_messages: int
    upstream_max_bytes: int
    upstream_ttl_s: float
    upstream_max_inflight: int
    downlink_max_messages: int
    downlink_ttl_s: float


@dataclass(frozen=True)
class GateConfig:
    """The enrolment gate: how often the Connector asks the device `deployment.get`."""

    recheck_s: float  # while open, ask again this often
    retry_s: float  # while closed, ask again this often
    timeout_s: float  # an unanswered request counts as "closed"


@dataclass(frozen=True)
class HealthConfig:
    enabled: bool
    bind: str
    port: int


@dataclass(frozen=True)
class Config:
    device: DeviceConfig
    mqtt: MqttConfig
    gate: GateConfig
    queues: QueueConfig
    health: HealthConfig
    log_level: str = "info"
    problems: list[str] = field(default_factory=list, compare=False)


def _get(d: dict[str, Any], key: str, typ: type | tuple, default: Any, errs: list[str], where: str) -> Any:
    if key not in d:
        return default
    v = d[key]
    if isinstance(v, bool) and typ is not bool:
        errs.append(f"{where}.{key} must be {typ}")
        return default
    if not isinstance(v, typ):
        errs.append(f"{where}.{key} has the wrong type")
        return default
    return v


def _check_unknown(d: dict[str, Any], allowed: set[str], where: str, errs: list[str]) -> None:
    for k in d:
        if k not in allowed:
            errs.append(f"unknown key {where}.{k}")


def parse(raw: dict[str, Any]) -> Config:
    errs: list[str] = []
    _check_unknown(raw, {"device", "mqtt", "downlink", "queues", "health", "log"}, "", errs)

    dev = raw.get("device", {})
    _check_unknown(dev, {"mode", "baud", "select", "stall_s", "max_downlink_bytes"}, "device", errs)
    mode = _get(dev, "mode", str, None, errs, "device")
    if mode not in ("companion", "console"):
        errs.append("device.mode must be 'companion' or 'console' (it is never auto-detected)")
    baud = _get(dev, "baud", int, 115200, errs, "device")
    sel = dev.get("select", {})
    _check_unknown(sel, {"by_id", "vid", "pid", "usb_serial"}, "device.select", errs)
    selector = Selector(
        by_id=_get(sel, "by_id", str, None, errs, "device.select"),
        vid=_get(sel, "vid", int, None, errs, "device.select"),
        pid=_get(sel, "pid", int, None, errs, "device.select"),
        usb_serial=_get(sel, "usb_serial", str, None, errs, "device.select"),
    )
    if selector.by_id is None and (selector.vid is None or selector.pid is None):
        errs.append("device.select needs by_id, or vid and pid (a raw /dev/ttyUSB0 path is not a stable id)")
    if selector.by_id is not None and "/" in selector.by_id:
        errs.append("device.select.by_id is a name from /dev/serial/by-id, not a path")
    if selector.by_id == "*":
        errs.append("device.select.by_id '*' matches any device; name the one you mean")
    stall_s = float(_get(dev, "stall_s", (int, float), 2.0, errs, "device"))
    default_max = CONSOLE_MAX_LINE - len(CONSOLE_PREFIX) if mode == "console" else 1536
    max_down = _get(dev, "max_downlink_bytes", int, default_max, errs, "device")
    if mode == "console" and max_down > CONSOLE_MAX_LINE - len(CONSOLE_PREFIX):
        errs.append("device.max_downlink_bytes exceeds the console line limit")
    if mode == "companion" and max_down > MECON_MAX_MESSAGE:
        errs.append("device.max_downlink_bytes exceeds the interface message limit (4096)")
    if not 0.2 <= stall_s <= 5.0:
        errs.append("device.stall_s must be between 0.2 and 5 (the interface drops an incomplete message at 5 s)")
    device = DeviceConfig(mode or "companion", baud, selector, stall_s, max_down)

    m = raw.get("mqtt", {})
    _check_unknown(
        m,
        {"client_id", "topic_root", "topics", "upstream_qos", "keepalive_s", "brokers", "connect_timeout_s", "backoff"},
        "mqtt",
        errs,
    )
    client_id = _get(m, "client_id", str, "", errs, "mqtt")
    if not CLIENT_ID_RE.match(client_id or ""):
        errs.append("mqtt.client_id is required: 1-64 chars of A-Za-z0-9._- (set it to the broker login's id)")
    root = _get(m, "topic_root", str, "", errs, "mqtt")
    if not ROOT_RE.match(root or ""):
        errs.append("mqtt.topic_root is required: plain topic levels, no wildcards, no leading slash, no $SYS")
    elif root.startswith("$"):
        errs.append("mqtt.topic_root must not start with $")
    topics = m.get("topics", {})
    _check_unknown(topics, {"up", "down", "status"}, "mqtt.topics", errs)
    names = {}
    for key, default in (("up", "up"), ("down", "down"), ("status", "connector/status")):
        n = _get(topics, key, str, default, errs, "mqtt.topics")
        if not TOPIC_NAME_RE.match(n):
            errs.append(f"mqtt.topics.{key} is not a plain topic suffix")
        names[key] = n
    if len(set(names.values())) != 3:
        errs.append("mqtt.topics up, down and status must differ")
    qos = _get(m, "upstream_qos", int, 1, errs, "mqtt")
    if qos not in (0, 1):
        errs.append("mqtt.upstream_qos must be 0 or 1 (QoS 2 is not used)")
    keepalive = _get(m, "keepalive_s", int, 30, errs, "mqtt")
    if not 5 <= keepalive <= 600:
        errs.append("mqtt.keepalive_s must be 5-600")
    ctimeout = float(_get(m, "connect_timeout_s", (int, float), 10.0, errs, "mqtt"))
    bo = m.get("backoff", {})
    _check_unknown(bo, {"base_s", "max_s", "jitter", "stable_after_s", "hold_down_s"}, "mqtt.backoff", errs)
    base = float(_get(bo, "base_s", (int, float), 1.0, errs, "mqtt.backoff"))
    bmax = float(_get(bo, "max_s", (int, float), 60.0, errs, "mqtt.backoff"))
    jitter = float(_get(bo, "jitter", (int, float), 0.2, errs, "mqtt.backoff"))
    stable = float(_get(bo, "stable_after_s", (int, float), 30.0, errs, "mqtt.backoff"))
    hold = float(_get(bo, "hold_down_s", (int, float), 60.0, errs, "mqtt.backoff"))
    if not (0.1 <= base <= bmax <= 3600) or not 0 <= jitter <= 0.5:
        errs.append("mqtt.backoff needs 0.1 <= base_s <= max_s <= 3600 and 0 <= jitter <= 0.5")

    brokers: list[BrokerConfig] = []
    braw = m.get("brokers", [])
    if not isinstance(braw, list) or not braw:
        errs.append("mqtt.brokers needs at least one [[mqtt.brokers]] entry (first is primary, the rest fallbacks)")
        braw = []
    if len(braw) > 6:
        errs.append("mqtt.brokers allows at most 6 entries")
    seen: set[str] = set()
    for i, b in enumerate(braw):
        w = f"mqtt.brokers[{i}]"
        if not isinstance(b, dict):
            errs.append(f"{w} must be a table")
            continue
        _check_unknown(
            b, {"name", "host", "port", "tls", "ca_file", "username", "password_file", "insecure_allow_plain"}, w, errs
        )
        name = _get(b, "name", str, f"broker{i}", errs, w)
        if not BROKER_NAME_RE.match(name) or name in seen:
            errs.append(f"{w}.name must be unique, 1-32 chars of A-Za-z0-9._-")
        seen.add(name)
        host = _get(b, "host", str, "", errs, w)
        if not host or re.search(r"[\s/@#]", host):
            errs.append(f"{w}.host is required and must be a host name or address")
        tls = _get(b, "tls", bool, True, errs, w)
        plain_ok = _get(b, "insecure_allow_plain", bool, False, errs, w)
        if not tls and not plain_ok:
            errs.append(f"{w}: plain MQTT needs insecure_allow_plain = true (loopback or a closed test LAN only)")
        if tls and plain_ok:
            errs.append(f"{w}: insecure_allow_plain is meaningless with tls = true")
        port = _get(b, "port", int, 8883 if tls else 1883, errs, w)
        if not 1 <= port <= 65535:
            errs.append(f"{w}.port out of range")
        ca = _get(b, "ca_file", str, None, errs, w)
        if ca is not None and not tls:
            errs.append(f"{w}.ca_file needs tls = true")
        brokers.append(
            BrokerConfig(
                name, host, port, tls, ca,
                _get(b, "username", str, None, errs, w),
                _get(b, "password_file", str, None, errs, w),
                plain_ok,
            )
        )
    mqtt = MqttConfig(
        client_id, root, f"{root}/{names['up']}", f"{root}/{names['down']}", f"{root}/{names['status']}",
        qos, keepalive, tuple(brokers), ctimeout, base, bmax, jitter, stable, hold,
    )

    dl = raw.get("downlink", {})
    if "enabled" in dl:
        errs.append(
            "downlink.enabled was removed: downlink opens by itself, and only while the device reports an "
            "enrolled Deployment record (deployment.get). Delete the key."
        )
    _check_unknown(dl, {"enabled", "gate"}, "downlink", errs)
    g = dl.get("gate", {})
    _check_unknown(g, {"recheck_s", "retry_s", "timeout_s"}, "downlink.gate", errs)
    gate = GateConfig(
        float(_get(g, "recheck_s", (int, float), 600.0, errs, "downlink.gate")),
        float(_get(g, "retry_s", (int, float), 30.0, errs, "downlink.gate")),
        float(_get(g, "timeout_s", (int, float), 8.0, errs, "downlink.gate")),
    )
    if not (30 <= gate.recheck_s <= 3600 and 5 <= gate.retry_s <= 600 and 2 <= gate.timeout_s <= 30):
        errs.append("downlink.gate: recheck_s must be 30-3600, retry_s 5-600, timeout_s 2-30")
    q = raw.get("queues", {})
    _check_unknown(
        q,
        {"upstream_max_messages", "upstream_max_bytes", "upstream_ttl_s", "upstream_max_inflight",
         "downlink_max_messages", "downlink_ttl_s"},
        "queues", errs,
    )
    queues = QueueConfig(
        _get(q, "upstream_max_messages", int, 64, errs, "queues"),
        _get(q, "upstream_max_bytes", int, 262144, errs, "queues"),
        float(_get(q, "upstream_ttl_s", (int, float), 60.0, errs, "queues")),
        _get(q, "upstream_max_inflight", int, 16, errs, "queues"),
        _get(q, "downlink_max_messages", int, 8, errs, "queues"),
        float(_get(q, "downlink_ttl_s", (int, float), 5.0, errs, "queues")),
    )
    if not (1 <= queues.upstream_max_messages <= 4096 and 1024 <= queues.upstream_max_bytes <= 16 * 1024 * 1024
            and 1 <= queues.downlink_max_messages <= 256 and queues.upstream_max_inflight >= 1
            and queues.upstream_ttl_s > 0 and queues.downlink_ttl_s > 0):
        errs.append("queues: a limit is out of range")
    h = raw.get("health", {})
    _check_unknown(h, {"enabled", "bind", "port"}, "health", errs)
    health = HealthConfig(
        _get(h, "enabled", bool, True, errs, "health"),
        _get(h, "bind", str, "127.0.0.1", errs, "health"),
        _get(h, "port", int, 9464, errs, "health"),
    )
    lg = raw.get("log", {})
    level = _get(lg, "level", str, "info", errs, "log")
    if level not in ("info", "debug"):
        errs.append("log.level must be info or debug")
    if errs:
        raise ConfigError(errs)
    return Config(device, mqtt, gate, queues, health, level)


def load(path: str | Path) -> Config:
    try:
        raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError([f"cannot read config: {type(e).__name__}"]) from e
    return parse(raw)


def read_secret(path: str) -> str:
    """Reads a secret file at connect time. The value is never logged or stored in config.

    An unreadable file (absent, wrong owner or mode, a directory, not UTF-8) raises ConfigError naming the
    path and the error class only, never the content or the OS message.
    """
    try:
        return Path(path).read_text(encoding="utf-8").rstrip("\r\n")
    except (OSError, UnicodeDecodeError) as e:
        raise ConfigError([f"cannot read password_file {path}: {type(e).__name__}"]) from e


def check_secrets(cfg: Config) -> None:
    """Startup check: every configured password_file must be readable now. Raises ConfigError."""
    problems: list[str] = []
    for b in cfg.mqtt.brokers:
        if b.username and b.password_file:
            try:
                read_secret(b.password_file)
            except ConfigError as e:
                problems.extend(e.problems)
    if problems:
        raise ConfigError(problems)
