"""Configuration: TOML file, validated up front, fail closed on anything unsafe."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .framing import CONSOLE_MAX_WIRE, MECON_MAX_MESSAGE


class ConfigError(Exception):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ROOT_RE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
TOPIC_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
BROKER_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")


EVENT_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")  # an `ev` value that may become a topic level


@dataclass(frozen=True)
class Selector:
    by_id: str | None = None  # fnmatch pattern against a /dev/serial/by-id entry name
    path: str | None = None  # an explicit device path, normally a udev-provided stable symlink
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
    topic_resp: str  # device -> broker: a response (a message with an `id`)
    topic_ev: str  # device -> broker: events go to f"{topic_ev}/<event name>"
    topic_req: str  # broker -> device: requests
    topic_status: str  # the Connector's retained {"online":...} state
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
    busy_retry_s: float = 3.0  # a `busy` answer (the device had no memory) is asked again this soon; nothing changes
    failed_threshold: int = 3  # this many `failed` answers in a row (storage) close the gate; fewer keep it as it is
    busy_backoff_after: int = 3  # after this many `busy` answers in a row, ask again on retry_s instead of busy_retry_s


@dataclass(frozen=True)
class HealthConfig:
    enabled: bool
    bind: str
    port: int


@dataclass(frozen=True)
class HoldConfig:
    """The WebSocket hold transport (contracts/connector-hold/v1)."""

    base_url: str  # as configured: https (or wss); plain only with insecure_allow_plain
    ws_url: str  # {base}/gateway/ws with a ws or wss scheme
    token_file: str
    token_presentation: str  # "header" (Authorization: Bearer) or "subprotocol" (mecon-bridge, bearer.<token>)
    insecure_allow_plain: bool
    ca_file: str | None
    connect_timeout_s: float
    request_timeout_s: float  # how long one relayed request may wait for the device before it is abandoned
    ping_interval_s: float  # WebSocket control pings; 0 turns them off


@dataclass(frozen=True)
class DfuConfig:
    """Bootloader serial DFU for the hold transport (contracts/connector-hold/v1, section 12). Present only when
    [dfu] enabled = true; the bootloader port is opened only for a job the Backend armed on the live socket."""

    bootloader: Selector  # the bootloader's own USB serial port (a different USB device from the application's)
    bootloader_wait_s: float  # how long to look for the bootloader port after the application port dropped
    app_return_wait_s: float  # how long to wait for the application port after a transfer
    arm_window_s: float  # from `ready`, a device reset keeps the socket only within this long
    attempts: int  # transfer attempts before the job is reported failed
    package_max_bytes: int
    failed_hold_s: float = 1800.0  # how long a failed job keeps the socket without a device link
    stop_wait_s: float = 5.0  # at shutdown: how long to wait for a running transfer to finish its frame and close the port
    state_dir: str = "/var/lib/mecon-connector"  # where the "needs a UF2 copy" marker is kept (the unit's StateDirectory)


@dataclass(frozen=True)
class Config:
    device: DeviceConfig
    mqtt: MqttConfig | None  # None when transport = "hold"
    gate: GateConfig
    queues: QueueConfig
    health: HealthConfig
    log_level: str = "info"
    problems: list[str] = field(default_factory=list, compare=False)
    transport: str = "mqtt"  # "mqtt" | "hold"
    hold: HoldConfig | None = None  # set when transport = "hold"
    dfu: DfuConfig | None = None  # set when [dfu] enabled = true (hold transport only)


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


RAW_TTY_RE = re.compile(r"^/dev/(tty(USB|ACM|AMA|S)|cu\.)")


def check_path(path: str, where: str) -> list[str]:
    """An explicit port path must be absolute, plain, and a stable name rather than a kernel tty node."""
    errs: list[str] = []
    if not path.startswith("/dev/") or path.endswith("/") or ".." in path.split("/") or re.search(r"[\s*?\[\]]", path):
        errs.append(f"{where} must be an absolute /dev/... path with no wildcard or '..'")
    elif RAW_TTY_RE.match(path):
        errs.append(
            f"{where} {path} is a kernel tty node that changes between plugs; use a udev symlink "
            "such as /dev/bench/<name> or a /dev/serial/by-id entry"
        )
    return errs


def check_selector(sel: Selector, where: str = "device.select") -> list[str]:
    errs = [e.replace("device.select", where) for e in _check_selector(sel)]
    return errs


def _check_selector(sel: Selector) -> list[str]:
    errs: list[str] = []
    n = sum(x is not None for x in (sel.by_id, sel.path)) + (1 if sel.vid is not None or sel.pid is not None else 0)
    if n == 0 or (sel.vid is None) != (sel.pid is None):
        errs.append(
            "device.select needs exactly one of path, by_id, or vid and pid (a raw /dev/ttyUSB0 path is not a stable id)"
        )
    elif n > 1:
        errs.append("device.select takes only one of path, by_id, or vid and pid")
    if sel.usb_serial is not None and sel.vid is None:
        errs.append("device.select.usb_serial needs vid and pid")
    if sel.by_id is not None and "/" in sel.by_id:
        errs.append("device.select.by_id is a name from /dev/serial/by-id, not a path")
    if sel.by_id == "*":
        errs.append("device.select.by_id '*' matches any device; name the one you mean")
    if sel.path is not None:
        errs.extend(check_path(sel.path, "device.select.path"))
    return errs


TOKEN_RE = re.compile(r"^[\x21-\x7e]{1,1024}$")  # visible ASCII, no whitespace: valid in a header value
SUBPROTOCOL_TOKEN_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,1024}$")  # RFC 9110 token characters


def parse_hold(h: dict[str, Any], errs: list[str]) -> HoldConfig | None:
    """The [hold] table. Fail closed: https or wss only, unless the operator says the link is a test link."""
    _check_unknown(
        h,
        {"base_url", "token_file", "token_presentation", "insecure_allow_plain", "ca_file", "connect_timeout_s",
         "request_timeout_s", "ping_interval_s"},
        "hold",
        errs,
    )
    base = _get(h, "base_url", str, "", errs, "hold")
    plain_ok = _get(h, "insecure_allow_plain", bool, False, errs, "hold")
    ws_url = ""
    m = re.match(r"^(https|wss|http|ws)://([^/?#@\s]+)((?:/[A-Za-z0-9._~%!$&'()*+,;=:@-]*)*)$", base or "")
    if not m:
        errs.append("hold.base_url is required: https://host[:port][/prefix] (no credentials, query or fragment)")
    else:
        scheme, hostport, path = m.group(1), m.group(2), m.group(3).rstrip("/")
        secure = scheme in ("https", "wss")
        if not secure and not plain_ok:
            errs.append("hold.base_url: plain http/ws needs insecure_allow_plain = true (loopback or a closed test LAN only)")
        if secure and plain_ok:
            errs.append("hold.insecure_allow_plain is meaningless with an https or wss base_url")
        ws_url = f"{'wss' if secure else 'ws'}://{hostport}{path}/gateway/ws"
    token_file = _get(h, "token_file", str, "", errs, "hold")
    if not token_file or not token_file.startswith("/"):
        errs.append("hold.token_file is required: an absolute path to a file holding the connector token")
    pres = _get(h, "token_presentation", str, "header", errs, "hold")
    if pres not in ("header", "subprotocol"):
        errs.append("hold.token_presentation must be 'header' (default) or 'subprotocol'")
    ca = _get(h, "ca_file", str, None, errs, "hold")
    if ca is not None and m and m.group(1) in ("http", "ws"):
        errs.append("hold.ca_file needs an https or wss base_url")
    ctimeout = float(_get(h, "connect_timeout_s", (int, float), 10.0, errs, "hold"))
    rtimeout = float(_get(h, "request_timeout_s", (int, float), 15.0, errs, "hold"))
    ping = float(_get(h, "ping_interval_s", (int, float), 20.0, errs, "hold"))
    if not 1 <= ctimeout <= 60:
        errs.append("hold.connect_timeout_s must be 1-60")
    if not 2 <= rtimeout <= 30:
        errs.append("hold.request_timeout_s must be 2-30 (the device drops an incomplete message at 5 s)")
    if ping != 0 and not 5 <= ping <= 120:
        errs.append("hold.ping_interval_s must be 0 (off) or 5-120")
    if not ws_url or not token_file:
        return None
    return HoldConfig(base, ws_url, token_file, pres, plain_ok, ca, ctimeout, rtimeout, ping)


def parse_dfu(d: dict[str, Any], device_sel: Selector, transport: str, errs: list[str]) -> DfuConfig | None:
    """The [dfu] table. Off unless enabled = true; enabling needs the hold transport and a bootloader selector
    (path, by_id, or vid and pid, as device.select) that is not the application port's own."""
    if not isinstance(d, dict):
        errs.append("dfu must be a table")
        return None
    _check_unknown(
        d,
        {"enabled", "bootloader", "bootloader_wait_s", "app_return_wait_s", "arm_window_s", "attempts",
         "package_max_bytes", "failed_hold_s", "stop_wait_s", "state_dir"},
        "dfu",
        errs,
    )
    enabled = _get(d, "enabled", bool, False, errs, "dfu")
    b = d.get("bootloader", {})
    if not isinstance(b, dict):
        errs.append("dfu.bootloader must be a table")
        b = {}
    _check_unknown(b, {"by_id", "path", "vid", "pid", "usb_serial"}, "dfu.bootloader", errs)
    sel = Selector(
        by_id=_get(b, "by_id", str, None, errs, "dfu.bootloader"),
        path=_get(b, "path", str, None, errs, "dfu.bootloader"),
        vid=_get(b, "vid", int, None, errs, "dfu.bootloader"),
        pid=_get(b, "pid", int, None, errs, "dfu.bootloader"),
        usb_serial=_get(b, "usb_serial", str, None, errs, "dfu.bootloader"),
    )
    boot_wait = float(_get(d, "bootloader_wait_s", (int, float), 30.0, errs, "dfu"))
    app_wait = float(_get(d, "app_return_wait_s", (int, float), 120.0, errs, "dfu"))
    window = float(_get(d, "arm_window_s", (int, float), 60.0, errs, "dfu"))
    attempts = _get(d, "attempts", int, 3, errs, "dfu")
    max_bytes = _get(d, "package_max_bytes", int, 2 * 1024 * 1024, errs, "dfu")
    failed_hold = float(_get(d, "failed_hold_s", (int, float), 1800.0, errs, "dfu"))
    stop_wait = float(_get(d, "stop_wait_s", (int, float), 5.0, errs, "dfu"))
    state_dir = _get(d, "state_dir", str, "/var/lib/mecon-connector", errs, "dfu")
    if not enabled:
        return None
    if transport != "hold":
        errs.append("dfu.enabled needs transport = 'hold' (the Backend arms a DFU job on the hold's socket)")
    if not b:
        errs.append("dfu.enabled needs a dfu.bootloader selector: path, by_id, or vid and pid of the bootloader's port")
    else:
        errs.extend(check_selector(sel, "dfu.bootloader"))
        if sel == device_sel:
            errs.append("dfu.bootloader must select the bootloader's port, not the same port as device.select")
    if not 5 <= boot_wait <= 300:
        errs.append("dfu.bootloader_wait_s must be 5-300")
    if not 10 <= app_wait <= 900:
        errs.append("dfu.app_return_wait_s must be 10-900")
    if not 10 <= window <= 600:
        errs.append("dfu.arm_window_s must be 10-600")
    if not 1 <= attempts <= 10:
        errs.append("dfu.attempts must be 1-10")
    if not 64 * 1024 <= max_bytes <= 16 * 1024 * 1024:
        errs.append("dfu.package_max_bytes must be 65536-16777216")
    if not 60 <= failed_hold <= 86400:
        errs.append("dfu.failed_hold_s must be 60-86400")
    if not 0.5 <= stop_wait <= 30:
        errs.append("dfu.stop_wait_s must be 0.5-30")
    if not isinstance(state_dir, str) or not state_dir.startswith("/"):
        errs.append("dfu.state_dir must be an absolute path")
        state_dir = "/var/lib/mecon-connector"
    return DfuConfig(sel, boot_wait, app_wait, window, attempts, max_bytes, failed_hold, stop_wait, state_dir)


def parse(raw: dict[str, Any]) -> Config:
    errs: list[str] = []
    _check_unknown(raw, {"transport", "device", "mqtt", "hold", "dfu", "downlink", "queues", "health", "log"}, "", errs)
    transport = raw.get("transport", "mqtt")
    if transport not in ("mqtt", "hold"):
        errs.append("transport must be 'mqtt' or 'hold'")
        transport = "mqtt"
    if transport == "hold" and "mqtt" in raw:
        errs.append("transport = 'hold' takes a [hold] table, not [mqtt]")
    if transport == "mqtt" and "hold" in raw:
        errs.append("a [hold] table needs transport = 'hold'")

    dev = raw.get("device", {})
    _check_unknown(dev, {"mode", "baud", "select", "stall_s", "max_downlink_bytes"}, "device", errs)
    mode = _get(dev, "mode", str, None, errs, "device")
    if mode not in ("companion", "console"):
        errs.append("device.mode must be 'companion' or 'console' (it is never auto-detected)")
    baud = _get(dev, "baud", int, 115200, errs, "device")
    sel = dev.get("select", {})
    _check_unknown(sel, {"by_id", "path", "vid", "pid", "usb_serial"}, "device.select", errs)
    selector = Selector(
        by_id=_get(sel, "by_id", str, None, errs, "device.select"),
        path=_get(sel, "path", str, None, errs, "device.select"),
        vid=_get(sel, "vid", int, None, errs, "device.select"),
        pid=_get(sel, "pid", int, None, errs, "device.select"),
        usb_serial=_get(sel, "usb_serial", str, None, errs, "device.select"),
    )
    errs.extend(check_selector(selector))
    stall_s = float(_get(dev, "stall_s", (int, float), 2.0, errs, "device"))
    default_max = CONSOLE_MAX_WIRE if mode == "console" else 1536
    max_down = _get(dev, "max_downlink_bytes", int, default_max, errs, "device")
    if mode == "console" and max_down > CONSOLE_MAX_WIRE:
        errs.append("device.max_downlink_bytes exceeds the console line limit")
    if mode == "companion" and max_down > MECON_MAX_MESSAGE:
        errs.append("device.max_downlink_bytes exceeds the interface message limit (4096)")
    if not 0.2 <= stall_s <= 5.0:
        errs.append("device.stall_s must be between 0.2 and 5 (the interface drops an incomplete message at 5 s)")
    device = DeviceConfig(mode or "companion", baud, selector, stall_s, max_down)

    mqtt: MqttConfig | None = None
    hold_cfg: HoldConfig | None = None
    if transport == "hold":
        hold_cfg = parse_hold(raw.get("hold", {}), errs)
    else:
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
        _check_unknown(topics, {"resp", "ev", "req", "status"}, "mqtt.topics", errs)
        names = {}
        for key, default in (("resp", "resp"), ("ev", "ev"), ("req", "req"), ("status", "status")):
            n = _get(topics, key, str, default, errs, "mqtt.topics")
            if not TOPIC_NAME_RE.match(n):
                errs.append(f"mqtt.topics.{key} is not a plain topic suffix")
            names[key] = n
        if len(set(names.values())) != 4:
            errs.append("mqtt.topics resp, ev, req and status must differ")
        elif any(a != b and (a.startswith(b + "/") or b.startswith(a + "/")) for a in names.values() for b in names.values()):
            errs.append("mqtt.topics must not be below one another (ev is a prefix for event names)")
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
            client_id, root, f"{root}/{names['resp']}", f"{root}/{names['ev']}", f"{root}/{names['req']}",
            f"{root}/{names['status']}",
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
    _check_unknown(g, {"recheck_s", "retry_s", "timeout_s", "busy_retry_s", "failed_threshold", "busy_backoff_after"}, "downlink.gate", errs)
    gate = GateConfig(
        float(_get(g, "recheck_s", (int, float), 600.0, errs, "downlink.gate")),
        float(_get(g, "retry_s", (int, float), 30.0, errs, "downlink.gate")),
        float(_get(g, "timeout_s", (int, float), 8.0, errs, "downlink.gate")),
        float(_get(g, "busy_retry_s", (int, float), 3.0, errs, "downlink.gate")),
        _get(g, "failed_threshold", int, 3, errs, "downlink.gate"),
        _get(g, "busy_backoff_after", int, 3, errs, "downlink.gate"),
    )
    if not (30 <= gate.recheck_s <= 3600 and 5 <= gate.retry_s <= 600 and 2 <= gate.timeout_s <= 30):
        errs.append("downlink.gate: recheck_s must be 30-3600, retry_s 5-600, timeout_s 2-30")
    if not (1 <= gate.busy_retry_s <= 60 and 1 <= gate.failed_threshold <= 10 and 1 <= gate.busy_backoff_after <= 100):
        errs.append("downlink.gate: busy_retry_s must be 1-60, failed_threshold 1-10, busy_backoff_after 1-100")
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
    dfu = parse_dfu(raw["dfu"], selector, transport, errs) if "dfu" in raw else None
    if errs:
        raise ConfigError(errs)
    return Config(device, mqtt, gate, queues, health, level, transport=transport, hold=hold_cfg, dfu=dfu)


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


def read_token(path: str, presentation: str = "header") -> str:
    """Reads the connector token file at connect time. The value is never logged or stored in config.

    Refused, with the path and the reason class only (never the content): an unreadable file, a file any
    user can read (mode bit o+r), an empty file, or content that cannot be carried in the chosen
    presentation. A trailing newline is removed. Group access is allowed so a root-owned 0640 file shared
    with the service group works; a systemd credential is 0400.
    """
    what = f"hold.token_file {path}"
    try:
        if os.stat(path).st_mode & 0o004:
            raise ConfigError([f"{what} is readable by every user; make it mode 600 or 640"])
        value = Path(path).read_text(encoding="utf-8").rstrip("\r\n")
    except (OSError, UnicodeDecodeError) as e:
        raise ConfigError([f"cannot read {what}: {type(e).__name__}"]) from e
    pattern = SUBPROTOCOL_TOKEN_RE if presentation == "subprotocol" else TOKEN_RE
    if not pattern.match(value):
        raise ConfigError([f"{what} does not hold a usable token (empty, or characters not allowed in a {presentation})"])
    return value


def check_secrets(cfg: Config, missing_ok: bool = False) -> list[str]:
    """Startup check: every configured password_file must be readable now. Raises ConfigError.

    missing_ok (--check-config): an absent file is not an error, because the file may be provided only at
    run time (systemd LoadCredential, a container secret) and `--check-config` is run by installers and CI
    where it is not there. Returns the notes to print for such files. A file that exists but cannot be read
    is always an error.
    """
    problems: list[str] = []
    notes: list[str] = []
    if cfg.hold is not None:
        h = cfg.hold
        if missing_ok and not os.path.lexists(h.token_file):
            notes.append(f"token_file {h.token_file} does not exist here; it must exist when the service starts")
        else:
            try:
                read_token(h.token_file, h.token_presentation)
            except ConfigError as e:
                problems.extend(e.problems)
    for b in cfg.mqtt.brokers if cfg.mqtt is not None else ():
        if b.username and b.password_file:
            if missing_ok and not os.path.lexists(b.password_file):
                notes.append(f"password_file {b.password_file} does not exist here; it must exist when the service starts")
                continue
            try:
                read_secret(b.password_file)
            except ConfigError as e:
                problems.extend(e.problems)
    if problems:
        raise ConfigError(problems)
    return notes
