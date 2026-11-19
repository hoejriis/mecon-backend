"""Static checks on the deployment files: the unit's hardening, no secrets, no root, the udev template
and the compose example. These guard the packaging rules and fail when a line is broken (see
scripts/mutation_deploy.py)."""

import pathlib
import re

import pytest

DEPLOY = pathlib.Path(__file__).resolve().parents[1] / "deploy"
UNIT = DEPLOY / "systemd" / "mecon-connector.service"
RULES = DEPLOY / "udev" / "99-mecon-connector.rules"
COMPOSE = DEPLOY / "docker-compose.example.yml"
INSTALL = DEPLOY / "install.sh"


def unit():
    """{section: {key: [values...]}} of the unit file; comments and blank lines skipped."""
    out, sec = {}, None
    for raw in UNIT.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("["):
            sec = line.strip("[]")
            out[sec] = {}
            continue
        k, _, v = line.partition("=")
        out[sec].setdefault(k, []).append(v)
    return out


def svc(key):
    return unit()["Service"].get(key, [])


def test_runs_as_a_dedicated_non_root_user():
    assert svc("User") == ["mecon-connector"]
    assert svc("Group") == ["mecon-connector"]
    assert "DynamicUser" not in unit()["Service"]  # a fixed user owns the group-readable config
    for v in svc("User") + svc("Group"):
        assert v not in ("root", "0", "")


def test_serial_group_is_supplementary_only():
    assert svc("SupplementaryGroups") == ["dialout"]


@pytest.mark.parametrize(
    "key,value",
    [
        ("NoNewPrivileges", "true"),
        ("ProtectSystem", "strict"),
        ("ProtectHome", "true"),
        ("PrivateTmp", "true"),
        ("CapabilityBoundingSet", ""),
        ("AmbientCapabilities", ""),
        ("ProtectKernelTunables", "true"),
        ("ProtectKernelModules", "true"),
        ("ProtectControlGroups", "true"),
        ("RestrictSUIDSGID", "true"),
        ("LockPersonality", "true"),
        ("RestrictNamespaces", "true"),
        ("DevicePolicy", "closed"),
        ("Restart", "on-failure"),
        ("KillSignal", "SIGTERM"),
        ("RestartPreventExitStatus", "2 3"),
    ],
)
def test_hardening_directive(key, value):
    assert svc(key) == [value]


def test_address_families_are_inet_inet6_unix_only():
    (v,) = svc("RestrictAddressFamilies")
    assert set(v.split()) == {"AF_INET", "AF_INET6", "AF_UNIX"}


def test_only_serial_devices_are_allowed():
    assert sorted(svc("DeviceAllow")) == ["char-ttyACM rw", "char-ttyUSB rw"]


def test_writable_paths_are_state_only():
    assert svc("ReadWritePaths") == ["/var/lib/mecon-connector"]
    assert svc("StateDirectory") == ["mecon-connector"]


def test_memory_is_bounded_for_a_512_mb_board():
    def mb(s):
        m = re.fullmatch(r"(\d+)M", s)
        assert m, s
        return int(m.group(1))

    (hi,), (mx,) = svc("MemoryHigh"), svc("MemoryMax")
    assert 64 <= mb(mx) <= 256 and mb(hi) < mb(mx)


def test_stop_timeout_covers_the_clean_shutdown():
    (t,) = svc("TimeoutStopSec")
    assert 10 <= int(t) <= 90  # the shutdown takes about a second (tests/test_shutdown_signal.py bounds it)


def test_exec_and_config_paths():
    (e,) = svc("ExecStart")
    assert e == "/opt/mecon-connector/bin/mecon-connector --config /etc/mecon-connector/config.toml"


def test_secret_comes_from_a_credential_not_the_unit_or_environment():
    assert svc("LoadCredential") == ["broker-password:/etc/mecon-connector/credentials/broker-password"]
    allowed = {"PYTHONUNBUFFERED=1", "PYTHONDONTWRITEBYTECODE=1"}
    assert set(svc("Environment")) <= allowed, "only these non-secret variables may be set in the unit"
    for key in ("EnvironmentFile", "PassEnvironment", "SetCredential", "SetCredentialEncrypted"):
        assert key not in unit()["Service"], key
    text = UNIT.read_text()
    # an assignment that looks like a secret anywhere in the file, comments aside
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        assert not re.search(r"(?i)(pass(word)?|secret|token|api[_-]?key)\s*=\s*\S", line.split("LoadCredential")[0]), line


def test_config_reaches_the_credential_through_the_runtime_path_only():
    ex = (DEPLOY / "config.systemd.example.toml").read_text()
    assert 'password_file = "/run/credentials/mecon-connector.service/broker-password"' in ex
    assert not re.search(r"(?m)^\s*password\s*=", ex)


def test_udev_template_ships_no_real_ids_and_does_nothing_by_default():
    active = [ln for ln in RULES.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert active == [], "the shipped rule must be inert until the operator fills it in"
    template = [ln for ln in RULES.read_text().splitlines() if ln.startswith("# SUBSYSTEM==")]
    assert len(template) == 1
    t = template[0]
    for placeholder in ('"VID"', '"PID"', '"SERIAL"'):
        assert placeholder in t
    assert 'ENV{ID_MM_DEVICE_IGNORE}="1"' in t and 'GROUP="dialout"' in t
    assert not re.search(r"(?i)idVendor\}==\"[0-9a-f]{4}\"", t)


def test_install_script_fails_closed():
    s = INSTALL.read_text()
    assert re.search(r"(?m)^set -euo pipefail$", s)
    assert '[ "$(id -u)" -eq 0 ] || die' in s
    pips = [ln for ln in s.splitlines() if 'bin/pip" install' in ln]
    assert len(pips) == 3
    for ln in pips:  # every download is hash-checked; the one local build uses the pinned, already installed backend
        assert "--require-hashes" in ln or ("--no-build-isolation" in ln and '"$TMP"' in ln), ln
    assert 'id -u "$SVC")" -ne 0' in s  # refuses a service user with uid 0
    # the config is installed only in the branch where none exists (the install test checks the behaviour)
    head, _, tail = s.partition('if [ -e "$CONF_DIR/config.toml" ]; then')
    kept, _, created = tail.partition("\nelse")
    assert "install " not in kept and "config.systemd.example.toml" in created


def test_compose_example():
    c = COMPOSE.read_text()
    assert re.search(r"(?m)^\s+read_only:\s*true\s*(#.*)?$", c)
    assert re.search(r'(?m)^\s+user:\s*"?10001:10001"?\s*(#.*)?$', c)
    assert re.search(r"(?m)^\s+devices:\s*$", c)
    assert "/healthz" in c and "no-new-privileges" in c and "cap_drop" in c
    assert not re.search(r"(?m)^\s+privileged:\s*true", c)
    assert not re.search(r"(?mi)^\s+(MQTT_)?PASSWORD\s*[:=]", c)
