#!/usr/bin/env bash
# Install-script test. Run as root in a disposable Debian container (it installs a user, files under
# /etc and /opt, and removes them). Needs network for pip (hash-pinned) and apt.
#
#   docker run --rm -v "$PWD/connector:/connector:ro" debian:bookworm-slim bash /connector/deploy/test-install.sh /connector
#
# The argument is the connector/ directory to test (default: the one containing this script).
# Mutation runs pass a mutated copy.
set -euo pipefail

SRC=$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)
SVC=mecon-connector
FAILS=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*" >&2; FAILS=$((FAILS + 1)); }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
mode_of() { stat -c '%a %U:%G' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root in a container" >&2; exit 2; }
[ -f /etc/debian_version ] || { echo "not Debian; refusing" >&2; exit 2; }
if ! command -v python3 >/dev/null || ! python3 -m venv --help >/dev/null 2>&1 || ! python3 -c 'import ensurepip' 2>/dev/null; then
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 python3-venv >/dev/null
fi

INSTALL="$SRC/deploy/install.sh"
UNINSTALL="$SRC/deploy/uninstall.sh"
cleanup() {
  bash "$UNINSTALL" --purge >/dev/null 2>&1 || true
  rm -f /etc/udev/rules.d/99-mecon-connector.rules
  # a broken (mutated) installer can leave a user that userdel will not remove (for example uid 0);
  # this container is disposable, so make sure the next run starts clean
  if getent passwd "$SVC" >/dev/null; then
    userdel -f "$SVC" >/dev/null 2>&1 || sed -i "/^$SVC:/d" /etc/passwd /etc/shadow
  fi
  if getent group "$SVC" >/dev/null; then groupdel "$SVC" >/dev/null 2>&1 || sed -i "/^$SVC:/d" /etc/group /etc/gshadow; fi
  rm -rf /etc/mecon-connector /opt/mecon-connector /opt/mecon-connector.* /etc/systemd/system/mecon-connector.service
}
cleanup
trap cleanup EXIT

CANARY="CANARY-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
OUT=$(mktemp)

# 0. not root: refused, nothing installed
if runuser -u nobody -- bash "$INSTALL" >"$OUT" 2>&1; then bad "install as non-root must fail"; else ok "install refuses a non-root caller"; fi
check "nothing was installed by the refused run" test ! -e /opt/mecon-connector

# 1. a fresh install
bash "$INSTALL" >"$OUT" 2>&1 || { cat "$OUT"; bad "fresh install failed"; exit 1; }
ok "fresh install succeeded"

U=$(id -u "$SVC")
check "service user is not root (uid $U)" test "$U" -ne 0
check "service shell is nologin" test "$(getent passwd "$SVC" | cut -d: -f7)" = /usr/sbin/nologin
check "config dir is 750 root:$SVC" test "$(mode_of /etc/mecon-connector)" = "750 root:$SVC"
check "credentials dir is 700 root:root" test "$(mode_of /etc/mecon-connector/credentials)" = "700 root:root"
check "config is 640 root:$SVC" test "$(mode_of /etc/mecon-connector/config.toml)" = "640 root:$SVC"
check "unit is 644 root:root" test "$(mode_of /etc/systemd/system/mecon-connector.service)" = "644 root:root"
check "udev rule installed" test -f /etc/udev/rules.d/99-mecon-connector.rules
check "venv is root-owned and not group or world writable" test -z "$(find /opt/mecon-connector -not -type l \( -not -user root -o -perm /022 \) -print -quit)"
check "unit runs as the service user" grep -qx "User=$SVC" /etc/systemd/system/mecon-connector.service
check "unit does not run as root" test -z "$(grep -E '^User=(root|0)?$' /etc/systemd/system/mecon-connector.service || true)"
check "unit loads the broker password as a credential" grep -q '^LoadCredential=broker-password:/etc/mecon-connector/credentials/broker-password$' /etc/systemd/system/mecon-connector.service
check "no secret-bearing Environment= in the unit" test -z "$(grep -iE '^Environment=.*(PASS|SECRET|TOKEN|KEY|CRED)' /etc/systemd/system/mecon-connector.service || true)"
check "the service user can run the entry point" runuser -u "$SVC" -- /opt/mecon-connector/bin/mecon-connector --version
check "the service user can read and validate the example config" \
  runuser -u "$SVC" -- /opt/mecon-connector/bin/mecon-connector --check-config --config /etc/mecon-connector/config.toml
check "another user cannot read the config" test -z "$(runuser -u nobody -- cat /etc/mecon-connector/config.toml 2>/dev/null || true)"
check "the service user cannot read the credentials dir" test -z "$(runuser -u "$SVC" -- ls /etc/mecon-connector/credentials 2>/dev/null || true)"

# 2. an operator's config, credential and udev edits survive an upgrade (a second run)
printf '# OPERATOR-EDIT-SENTINEL\n' >>/etc/mecon-connector/config.toml
chmod 0600 /etc/mecon-connector/config.toml          # a deliberate operator choice the script must not undo
printf '%s\n' "$CANARY" >/etc/mecon-connector/credentials/broker-password
chmod 0600 /etc/mecon-connector/credentials/broker-password
printf '# OPERATOR-UDEV-SENTINEL\n' >>/etc/udev/rules.d/99-mecon-connector.rules
CONF_SUM=$(sha256sum /etc/mecon-connector/config.toml)
CONF_MODE=$(mode_of /etc/mecon-connector/config.toml)
bash "$INSTALL" >"$OUT" 2>&1 || { cat "$OUT"; bad "second install failed"; }
ok "second install (upgrade) succeeded"
check "existing config is byte-identical after the upgrade" test "$(sha256sum /etc/mecon-connector/config.toml)" = "$CONF_SUM"
check "existing config mode is untouched" test "$(mode_of /etc/mecon-connector/config.toml)" = "$CONF_MODE"
check "operator's udev rule is kept" grep -q OPERATOR-UDEV-SENTINEL /etc/udev/rules.d/99-mecon-connector.rules
check "second run says the config was kept" grep -q 'kept existing /etc/mecon-connector/config.toml' "$OUT"
check "idempotent: still exactly one service user" test "$(getent passwd | grep -c "^$SVC:")" = 1
check "idempotent: same uid" test "$(id -u "$SVC")" = "$U"
check "the venv still runs" /opt/mecon-connector/bin/mecon-connector --version
check "no leftover build directories" test -z "$(ls -d /opt/mecon-connector.* 2>/dev/null || true)"

# 3. the credential never reaches output, the unit or any file but its own
check "credential value is not in the install output" test -z "$(grep -F "$CANARY" "$OUT" || true)"
check "credential value is only in its own file" \
  test "$(grep -rlF "$CANARY" /etc /opt /var/lib 2>/dev/null | tr '\n' ' ')" = "/etc/mecon-connector/credentials/broker-password "

# 4. --enable refuses on placeholders (and on a missing credential), and starts nothing
if bash "$INSTALL" --enable >"$OUT" 2>&1; then
  # without systemd running --enable has nothing to refuse; only fail when systemd is present
  if [ -d /run/systemd/system ]; then bad "--enable must refuse a config with placeholders"; else ok "--enable is a no-op without systemd"; fi
else
  ok "--enable refused"
fi

# 5. uninstall keeps config and user; --purge removes them
bash "$UNINSTALL" >"$OUT" 2>&1 || bad "uninstall failed"
check "uninstall removed the venv" test ! -e /opt/mecon-connector
check "uninstall removed the unit" test ! -e /etc/systemd/system/mecon-connector.service
check "uninstall removed the udev rule" test ! -e /etc/udev/rules.d/99-mecon-connector.rules
check "uninstall kept the config" test -f /etc/mecon-connector/config.toml
check "uninstall kept the user" id -u "$SVC"
bash "$UNINSTALL" >"$OUT" 2>&1 || bad "second uninstall (idempotence) failed"
ok "uninstall twice is fine"
bash "$INSTALL" >"$OUT" 2>&1 || bad "reinstall after uninstall failed"
check "reinstall kept the operator config" grep -q OPERATOR-EDIT-SENTINEL /etc/mecon-connector/config.toml
bash "$UNINSTALL" --purge >"$OUT" 2>&1 || bad "purge failed"
check "purge removed the config directory" test ! -e /etc/mecon-connector
check "purge removed the user" test -z "$(getent passwd | grep "^$SVC:" || true)"
check "purge removed the group" test -z "$(getent group "$SVC" || true)"

rm -f "$OUT"
if [ "$FAILS" -ne 0 ]; then echo "$FAILS check(s) failed" >&2; exit 1; fi
echo "all install checks passed"
