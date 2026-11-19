#!/usr/bin/env bash
# End-to-end check of the systemd packaging on a real systemd host (a CI VM or a Raspberry Pi), with
# no radio and no real broker: install, start under the sandbox with a synthetic credential and a
# throwaway local mosquitto, check, stop, uninstall.
#
#   sudo connector/deploy/smoke-systemd.sh
#
# Needs: root, systemd as PID 1, mosquitto and mosquitto-clients installed. It refuses to run if
# /etc/mecon-connector/config.toml already exists (it would purge a real installation) and it
# leaves the host as it found it. It prints no secret: the credential is a synthetic constant.
set -euo pipefail

die() { echo "smoke-systemd.sh: $*" >&2; exit 1; }
FAILS=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*" >&2; FAILS=$((FAILS + 1)); }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -d /run/systemd/system ] || die "systemd is not PID 1 here"
command -v mosquitto >/dev/null || die "mosquitto is not installed (apt-get install mosquitto mosquitto-clients)"
command -v mosquitto_sub >/dev/null || die "mosquitto_sub is not installed (apt-get install mosquitto-clients)"
[ ! -e /etc/mecon-connector/config.toml ] || die "/etc/mecon-connector/config.toml exists: not touching a real installation"
[ ! -e /opt/mecon-connector ] || die "/opt/mecon-connector exists: not touching a real installation"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PORT=18830
SECRET=ci-synthetic-password
TMP=$(mktemp -d)
BROKER_PID=""
cleanup() {
  systemctl stop mecon-connector 2>/dev/null || true
  [ -z "$BROKER_PID" ] || kill "$BROKER_PID" 2>/dev/null || true
  bash "$HERE/uninstall.sh" --purge >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# a throwaway broker that is not the system mosquitto (and not confined by its AppArmor profile)
printf 'listener %s 127.0.0.1\nallow_anonymous true\npersistence false\n' "$PORT" >"$TMP/m.conf"
mosquitto -c "$TMP/m.conf" &
BROKER_PID=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 0.1; done

bash "$HERE/install.sh" >/dev/null
cat >/etc/mecon-connector/config.toml <<EOC
[device]
mode = "companion"
select = { by_id = "usb-NOT_PRESENT-*" }
[mqtt]
client_id = "smoke"
topic_root = "smoke/systemd"
[[mqtt.brokers]]
name = "local"
host = "127.0.0.1"
port = $PORT
tls = false
insecure_allow_plain = true
username = "smoke"
password_file = "/run/credentials/mecon-connector.service/broker-password"
[health]
enabled = true
EOC
chown root:mecon-connector /etc/mecon-connector/config.toml
chmod 0640 /etc/mecon-connector/config.toml
( umask 077; printf '%s' "$SECRET" >/etc/mecon-connector/credentials/broker-password )

systemctl enable --now mecon-connector
HC=""
for _ in $(seq 1 30); do
  HC=$(python3 -c 'import urllib.request,urllib.error
try: print(urllib.request.urlopen("http://127.0.0.1:9464/metrics", timeout=1).status)
except Exception as e: print(getattr(e, "code", "down"))' 2>/dev/null || true)
  [ "$HC" = 200 ] && break
  sleep 1
done
check "the service answers /metrics under systemd" test "$HC" = 200
check "the service is active" systemctl is-active --quiet mecon-connector

PID=$(systemctl show -p MainPID --value mecon-connector)
check "has a main pid" test "${PID:-0}" -gt 0
check "runs as mecon-connector, not root" test "$(ps -o user:32= -p "$PID" | tr -d ' ')" = mecon-connector
check "CapEff is empty" test "$(awk '/^CapEff/ {print $2}' "/proc/$PID/status")" = 0000000000000000
check "NoNewPrivs is set" test "$(awk '/^NoNewPrivs/ {print $2}' "/proc/$PID/status")" = 1
check "memory limit is applied" test "$(systemctl show -p MemoryMax --value mecon-connector)" -gt 0
HEALTH=$(python3 -c 'import urllib.request,urllib.error,json
try: r = urllib.request.urlopen("http://127.0.0.1:9464/healthz", timeout=2); print(r.read().decode())
except urllib.error.HTTPError as e: print(e.read().decode())
except Exception: print("unreachable")')
echo "healthz: $HEALTH"
# no device is attached: serial is down, so the service is not ready, but it reached the broker with the credential
check "reached the broker with the credential from /run/credentials" \
  python3 -c 'import urllib.request,sys; sys.exit(0 if "mecon_connector_broker_connected 1" in urllib.request.urlopen("http://127.0.0.1:9464/metrics", timeout=2).read().decode() else 1)'
check "the credential is not in the unit" test -z "$(grep -aF "$SECRET" /etc/systemd/system/mecon-connector.service || true)"
check "the credential is not in systemctl show" test -z "$(systemctl show mecon-connector | grep -F "$SECRET" || true)"
check "the credential is not in the process environment" test -z "$(tr '\0' '\n' <"/proc/$PID/environ" | grep -F "$SECRET" || true)"
systemd-analyze security mecon-connector --no-pager 2>/dev/null | tail -1 || true

START=$(date +%s.%N)
systemctl stop mecon-connector
END=$(date +%s.%N)
awk -v a="$START" -v b="$END" 'BEGIN { printf "stop took %.2f s\n", b - a }'
check "stop was clean (result success, exit 0)" test "$(systemctl show -p Result --value mecon-connector)" = success -a "$(systemctl show -p ExecMainStatus --value mecon-connector)" = 0
check "stop took under 5 s (TimeoutStopSec is 15)" awk -v a="$START" -v b="$END" 'BEGIN { exit !((b - a) < 5) }'
check "the retained status says offline" \
  bash -c "mosquitto_sub -h 127.0.0.1 -p $PORT -t smoke/systemd/status -C 1 -W 5 | grep -qxF '{\"online\":false}'"

if [ "$FAILS" -ne 0 ]; then journalctl -u mecon-connector --no-pager | tail -30 || true; echo "$FAILS check(s) failed" >&2; exit 1; fi
echo "all systemd checks passed"
