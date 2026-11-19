#!/usr/bin/env python3
"""Mutation check for the deployment packaging rules.

Each mutant breaks one rule in a COPY of connector/ (the checkout is never modified, so there is
nothing to restore); the static tests and the install test must then fail. Run from connector/:

    python scripts/mutation_deploy.py [--no-install]

The install test needs root on Debian; elsewhere it runs in a disposable debian container (docker).
In CI it runs inside the Debian container that already runs the install test.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEBIAN = "debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc"

# (id, rule, file, [(old, new)], tests that must fail: any of "static", "install")
MUTANTS = [
    # (a) the install script overwrites an existing config
    ("a1", "config overwritten: the existence check is bypassed", "deploy/install.sh",
     [('if [ -e "$CONF_DIR/config.toml" ]; then', "if false; then")], ("static", "install")),
    ("a2", "config overwritten in the 'kept' branch (subtle: message says kept)", "deploy/install.sh",
     [('  echo "kept existing $CONF_DIR/config.toml"',
       '  install -o root -g "$SVC" -m 0640 "$SRC/deploy/config.systemd.example.toml" "$CONF_DIR/config.toml"\n  echo "kept existing $CONF_DIR/config.toml"')],
     ("install",)),
    ("a3", "config mode reset on every run", "deploy/install.sh",
     [('  echo "kept existing $CONF_DIR/config.toml"', '  chmod 0644 "$CONF_DIR/config.toml"\n  echo "kept existing $CONF_DIR/config.toml"')], ("install",)),
    # (b) a secret in the unit or the environment
    ("b1", "secret in the unit's Environment=", "deploy/systemd/mecon-connector.service",
     [("Environment=PYTHONUNBUFFERED=1\n", "Environment=PYTHONUNBUFFERED=1\nEnvironment=MQTT_PASSWORD=synthetic-not-a-secret\n")], ("static", "install")),
    ("b2", "secret via EnvironmentFile=", "deploy/systemd/mecon-connector.service",
     [("Environment=PYTHONUNBUFFERED=1\n", "Environment=PYTHONUNBUFFERED=1\nEnvironmentFile=/etc/mecon-connector/credentials/broker-password\n")], ("static",)),
    ("b3", "credential copied into the unit by the installer", "deploy/install.sh",
     [("if [ \"$PREFIX\" != /opt/mecon-connector ]; then",
       'if [ -f "$CONF_DIR/credentials/broker-password" ]; then\n  printf \'# %s\\n\' "$(cat "$CONF_DIR/credentials/broker-password")" >>/etc/systemd/system/mecon-connector.service\nfi\nif [ "$PREFIX" != /opt/mecon-connector ]; then')],
     ("install",)),
    ("b4", "credential printed by the installer", "deploy/install.sh",
     [('echo "installed $(', 'cat "$CONF_DIR/credentials/broker-password" 2>/dev/null || true\necho "installed $(')], ("install",)),
    ("b5", "credential no longer loaded through LoadCredential=", "deploy/systemd/mecon-connector.service",
     [("LoadCredential=broker-password:/etc/mecon-connector/credentials/broker-password\n", "")], ("static", "install")),
    # (c) the service runs as root
    ("c1", "unit User=root", "deploy/systemd/mecon-connector.service", [("User=mecon-connector\n", "User=root\n")], ("static", "install")),
    ("c2", "unit has no User= (systemd then runs it as root)", "deploy/systemd/mecon-connector.service", [("User=mecon-connector\n", "")], ("static", "install")),
    ("c3", "service user created with uid 0", "deploy/install.sh", [("useradd --system --gid", "useradd --system --uid 0 --non-unique --gid")], ("install",)),
    ("c4", "NoNewPrivileges dropped", "deploy/systemd/mecon-connector.service", [("NoNewPrivileges=true", "NoNewPrivileges=false")], ("static",)),
    ("c5", "capabilities kept (CapabilityBoundingSet no longer empty)", "deploy/systemd/mecon-connector.service",
     [("CapabilityBoundingSet=\n", "CapabilityBoundingSet=CAP_NET_ADMIN\n")], ("static",)),
    # the rest of the packaging contract
    ("d1", "installer runs for a non-root caller", "deploy/install.sh", [('[ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo $0)"\n', "")], ("static",)),
    ("d2", "dependencies installed without hash checking", "deploy/install.sh", [('"$PREFIX/bin/pip" install --quiet --require-hashes --no-deps -r "$SRC/requirements.lock"',
                                                                                   '"$PREFIX/bin/pip" install --quiet --no-deps paho-mqtt pyserial')], ("static",)),
    ("d3", "installed tree writable by the service user", "deploy/install.sh", [('chown -R root:root "$PREFIX"', 'chown -R "$SVC" "$PREFIX"')], ("install",)),
    ("d4", "config dir world-readable", "deploy/install.sh", [('install -d -o root -g "$SVC" -m 0750 "$CONF_DIR"', 'install -d -o root -g "$SVC" -m 0755 "$CONF_DIR"')], ("install",)),
    ("d5", "uninstall leaves the venv", "deploy/uninstall.sh", [('rm -rf "$PREFIX"\n', "")], ("install",)),
    ("d6", "writable paths widened", "deploy/systemd/mecon-connector.service", [("ReadWritePaths=/var/lib/mecon-connector", "ReadWritePaths=/var/lib/mecon-connector /etc")], ("static",)),
    ("d7", "stop timeout shorter than the clean shutdown", "deploy/systemd/mecon-connector.service", [("TimeoutStopSec=15", "TimeoutStopSec=1")], ("static",)),
    ("d8", "compose: writable root filesystem", "deploy/docker-compose.example.yml", [("read_only: true ", "read_only: false")], ("static",)),
    ("d9", "compose: runs as root", "deploy/docker-compose.example.yml", [('user: "10001:10001"', 'user: "0:0"')], ("static",)),
    ("d10", "udev template ships an active rule", "deploy/udev/99-mecon-connector.rules", [('# SUBSYSTEM=="tty"', 'SUBSYSTEM=="tty"')], ("static",)),
]


def copy_tree(dst: pathlib.Path) -> pathlib.Path:
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".venv", "__pycache__", "*.pyc", ".pytest_cache", "build", "*.egg-info"))
    return dst


def run_static(tree: pathlib.Path) -> tuple[int, str]:
    tests = ["tests/test_deploy_static.py"]
    if shutil.which("mosquitto"):
        tests.append("tests/test_shutdown_signal.py")
    p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", *tests], cwd=tree, capture_output=True, text=True,
                       env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    return p.returncode, p.stdout + p.stderr


def run_install(tree: pathlib.Path) -> tuple[int, str]:
    if os.geteuid() == 0 and pathlib.Path("/etc/debian_version").exists():
        cmd = ["bash", str(tree / "deploy" / "test-install.sh"), str(tree)]
    else:
        cmd = ["docker", "run", "--rm", "-v", f"{tree}:/connector:ro", DEBIAN, "bash", "/connector/deploy/test-install.sh", "/connector"]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main() -> int:
    do_install = "--no-install" not in sys.argv
    work = pathlib.Path(tempfile.mkdtemp(prefix="mutation-deploy-"))
    survivors = []
    try:
        base = copy_tree(work / "base")
        rc, out = run_static(base)
        if rc != 0:
            print("baseline (static) fails; fix the tests first\n" + out[-2000:])
            return 2
        if do_install:
            rc, out = run_install(base)
            if rc != 0:
                print("baseline (install test) fails; fix it first\n" + out[-2000:])
                return 2
        print("baseline passes (static" + (" and install)" if do_install else ")"))
        for mid, desc, rel, edits, tests in MUTANTS:
            tree = copy_tree(work / mid)
            path = tree / rel
            text = path.read_text()
            for old, new in edits:
                if text.count(old) != 1:
                    print(f"{mid}: pattern not found exactly once ({text.count(old)}): {old[:70]!r}")
                    survivors.append(mid)
                    break
                text = text.replace(old, new)
            else:
                path.write_text(text)
                killed_by = []
                if "static" in tests:
                    rc, out = run_static(tree)
                    if rc != 0:
                        killed_by.append("static: " + next((ln.split(" - ")[0] for ln in out.splitlines() if ln.startswith("FAILED")), "failure"))
                if do_install and "install" in tests:
                    rc, out = run_install(tree)
                    if rc != 0:
                        killed_by.append("install: " + next((ln for ln in out.splitlines() if ln.startswith("FAIL")), "failure"))
                needed = [t for t in tests if t != "install" or do_install]
                got = {k.split(":")[0] for k in killed_by}
                if not killed_by or (not do_install and "static" not in got and "static" in tests):
                    survivors.append(mid)
                    print(f"{mid}: SURVIVED  {desc}")
                else:
                    print(f"{mid}: killed    {desc}")
                    for k in killed_by:
                        print(f"        by {k}")
                    if set(needed) - got and mid in ("a1", "b1", "c1", "c2", "b5"):
                        print(f"        note: not killed by all of {needed}")
            shutil.rmtree(tree, ignore_errors=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"{len(MUTANTS) - len(survivors)} of {len(MUTANTS)} mutants killed; the checkout was not modified")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
