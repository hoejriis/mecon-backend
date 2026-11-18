#!/usr/bin/env bash
# Install the MECON USB Connector on Debian or Raspberry Pi OS.
#
#   sudo connector/deploy/install.sh [--prefix DIR] [--enable]
#
# What it does (idempotent; running it again is an upgrade):
#   - creates the system user and group mecon-connector (no login, no home);
#   - builds /opt/mecon-connector (a venv) from the hash-pinned lock files in this checkout;
#   - installs the systemd unit and a udev rule template;
#   - creates /etc/mecon-connector (root:mecon-connector 0750) and credentials/ (root 0700);
#   - installs an example config ONLY when none exists. An existing config is never touched.
# It never creates, reads or prints a secret, and does not start the service unless --enable is
# given and the config no longer contains the example placeholders.
set -euo pipefail
umask 022

SVC=mecon-connector
PREFIX=/opt/mecon-connector
ENABLE=0
CONF_DIR=/etc/mecon-connector

die() { echo "install.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a directory"; PREFIX=$2; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo $0)"
case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path" ;; esac
[ "$PREFIX" != / ] || die "refusing --prefix /"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/.." && pwd)   # the connector/ directory of the checkout
for f in pyproject.toml requirements.lock deploy/build-requirements.lock deploy/systemd/mecon-connector.service \
         deploy/udev/99-mecon-connector.rules deploy/config.systemd.example.toml; do
  [ -f "$SRC/$f" ] || die "not a connector checkout: $SRC/$f is missing"
done

command -v python3 >/dev/null || die "python3 is required (apt-get install python3 python3-venv)"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || die "Python 3.11 or newer is required (Raspberry Pi OS Bookworm has it)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 -m venv "$TMP/probe" >/dev/null 2>&1 || die "python3 -m venv failed (apt-get install python3-venv)"

# 1. user and group
if ! getent group "$SVC" >/dev/null; then
  groupadd --system "$SVC"
fi
if ! id -u "$SVC" >/dev/null 2>&1; then
  useradd --system --gid "$SVC" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
    --comment "MECON USB Connector" "$SVC"
fi
[ "$(id -u "$SVC")" -ne 0 ] || die "user $SVC has uid 0; refusing"
getent group dialout >/dev/null || die "group dialout does not exist; the unit needs it for the serial device"

# 2. the venv, from hash-pinned locks, built in a temporary copy of the sources so the checkout
#    stays clean. A venv is not relocatable, so it is built at its final path; the old one is kept
#    aside and put back if the build fails.
cp -R "$SRC/pyproject.toml" "$SRC/src" "$TMP/"
OLD=""
if [ -e "$PREFIX" ]; then OLD="$PREFIX.old.$$"; mv "$PREFIX" "$OLD"; fi
restore() { rm -rf "$PREFIX"; if [ -n "$OLD" ] && [ -e "$OLD" ]; then mv "$OLD" "$PREFIX"; fi; }
if ! (
  set -e
  python3 -m venv "$PREFIX"
  export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1
  "$PREFIX/bin/pip" install --quiet --require-hashes --no-deps -r "$SRC/deploy/build-requirements.lock"
  "$PREFIX/bin/pip" install --quiet --require-hashes --no-deps -r "$SRC/requirements.lock"
  "$PREFIX/bin/pip" install --quiet --no-deps --no-build-isolation "$TMP"
  "$PREFIX/bin/mecon-connector" --version >/dev/null
); then
  restore
  die "building the virtualenv failed; the previous installation (if any) was put back"
fi
chown -R root:root "$PREFIX"
chmod -R go-w "$PREFIX"
[ -z "$OLD" ] || rm -rf "$OLD"

# 3. configuration directories. The config is created once and never overwritten.
install -d -o root -g "$SVC" -m 0750 "$CONF_DIR"
install -d -o root -g root -m 0700 "$CONF_DIR/credentials"
FRESH=0
if [ -e "$CONF_DIR/config.toml" ]; then
  echo "kept existing $CONF_DIR/config.toml"
else
  install -o root -g "$SVC" -m 0640 "$SRC/deploy/config.systemd.example.toml" "$CONF_DIR/config.toml"
  FRESH=1
  echo "created $CONF_DIR/config.toml from the example; edit it before starting the service"
fi

# 4. unit (ours; customise with a drop-in) and udev rule template (the operator's once installed)
install -D -o root -g root -m 0644 "$SRC/deploy/systemd/mecon-connector.service" /etc/systemd/system/mecon-connector.service
if [ "$PREFIX" != /opt/mecon-connector ]; then
  sed -i "s#^ExecStart=/opt/mecon-connector/bin/#ExecStart=$PREFIX/bin/#" /etc/systemd/system/mecon-connector.service
fi
if [ -e /etc/udev/rules.d/99-mecon-connector.rules ]; then
  echo "kept existing /etc/udev/rules.d/99-mecon-connector.rules"
else
  install -D -o root -g root -m 0644 "$SRC/deploy/udev/99-mecon-connector.rules" /etc/udev/rules.d/99-mecon-connector.rules
fi

# 5. systemd, when it is running (a container or chroot has none)
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  command -v udevadm >/dev/null && udevadm control --reload || true
  if [ "$ENABLE" -eq 1 ]; then
    if [ "$FRESH" -eq 1 ] || grep -q 'example\.invalid\|REPLACE' "$CONF_DIR/config.toml"; then
      die "not enabling: $CONF_DIR/config.toml still has example placeholders"
    fi
    [ -f "$CONF_DIR/credentials/broker-password" ] || die "not enabling: $CONF_DIR/credentials/broker-password does not exist"
    "$PREFIX/bin/mecon-connector" --check-config --config "$CONF_DIR/config.toml" >/dev/null \
      || die "not enabling: the config does not validate"
    systemctl enable "$SVC.service"
    systemctl restart "$SVC.service"
    echo "enabled and (re)started $SVC"
  elif systemctl is-active --quiet "$SVC.service"; then
    systemctl restart "$SVC.service"
    echo "restarted $SVC onto the new version"
  fi
else
  echo "systemd is not running here: unit installed, nothing enabled or started"
fi

echo "installed $("$PREFIX/bin/mecon-connector" --version) into $PREFIX"
echo "next: edit $CONF_DIR/config.toml, create $CONF_DIR/credentials/broker-password (root, 0600),"
echo "      edit /etc/udev/rules.d/99-mecon-connector.rules, then: systemctl enable --now $SVC"
