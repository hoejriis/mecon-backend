#!/usr/bin/env bash
# Remove the MECON USB Connector installed by install.sh.
#
#   sudo connector/deploy/uninstall.sh [--prefix DIR] [--purge]
#
# Removes the service, the unit, the udev rule and the venv. Without --purge it keeps
# /etc/mecon-connector (config and credentials), /var/lib/mecon-connector and the
# mecon-connector user, so a reinstall picks up where it was. --purge removes those too.
set -euo pipefail

SVC=mecon-connector
PREFIX=/opt/mecon-connector
PURGE=0

die() { echo "uninstall.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || die "--prefix needs a directory"; PREFIX=$2; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo $0)"
case "$PREFIX" in /*) ;; *) die "--prefix must be an absolute path" ;; esac
[ "$PREFIX" != / ] || die "refusing --prefix /"

if [ -d /run/systemd/system ]; then
  systemctl disable --now "$SVC.service" 2>/dev/null || true
fi
rm -f /etc/systemd/system/mecon-connector.service
rm -rf /etc/systemd/system/mecon-connector.service.d
rm -f /etc/udev/rules.d/99-mecon-connector.rules
rm -rf "$PREFIX"
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl reset-failed "$SVC.service" 2>/dev/null || true
  if command -v udevadm >/dev/null; then udevadm control --reload || true; fi
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf /etc/mecon-connector /var/lib/mecon-connector
  if id -u "$SVC" >/dev/null 2>&1; then userdel "$SVC" 2>/dev/null || true; fi
  if getent group "$SVC" >/dev/null; then groupdel "$SVC" 2>/dev/null || true; fi
  echo "removed $SVC, its configuration, credentials, state and user"
else
  echo "removed $SVC; kept /etc/mecon-connector, /var/lib/mecon-connector and the $SVC user (use --purge to remove them)"
fi
