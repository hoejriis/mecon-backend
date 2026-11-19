#!/bin/sh
# C3 harness, bench-host side: runs the Connector in the FOREGROUND from a throwaway venv under /tmp,
# bounded by timeout, on one explicitly named serial port. It installs nothing system-wide, writes no
# service, and leaves nothing behind except /tmp/mecon-c3 (delete it afterwards).
#
# Run it on the bench host, from a copy of the connector/ directory (see c3_bench.md):
#
#   C3_PORT=/dev/bench/<name> C3_DEVICE_ID=<32 hex> C3_USER=<login> sh scripts/c3_remote_run.sh
#
# Needs on the host: python3 (3.11 or newer), network access to PyPI for the first run, and the broker
# password in /tmp/mecon-c3/broker.pw (mode 600, copied there by you; never passed on a command line).
#
# Environment:
#   C3_PORT         required. The serial port path, normally a udev symlink. Passed as --port.
#   C3_DEVICE_ID    required. The device's own id, 32 lowercase hex digits; the topic root is mecon/<it>.
#   C3_USER         required. The device login's name (dev-<gateway>-g<generation>); also the MQTT client id.
#   C3_MODE         companion (default) or console
#   C3_BROKER_PORT  the tunnel's port on this host   (default 18830)
#   C3_MAX_SECONDS  the Connector is stopped after this (default 600)
#   C3_DIR          working directory                 (default /tmp/mecon-c3)
set -eu
: "${C3_PORT:?set C3_PORT to the serial port path (for example a udev symlink)}"
: "${C3_DEVICE_ID:?set C3_DEVICE_ID to the device id (32 lowercase hex digits)}"
: "${C3_USER:?set C3_USER to the device login name}"
MODE=${C3_MODE:-companion}
BPORT=${C3_BROKER_PORT:-18830}
MAX=${C3_MAX_SECONDS:-600}
DIR=${C3_DIR:-/tmp/mecon-c3}
HERE=$(cd "$(dirname "$0")/.." && pwd)   # the connector/ directory this script belongs to

case $C3_DEVICE_ID in *[!0-9a-f]* | "") echo "C3_DEVICE_ID must be 32 lowercase hex digits" >&2; exit 2 ;; esac
[ "${#C3_DEVICE_ID}" -eq 32 ] || { echo "C3_DEVICE_ID must be 32 lowercase hex digits" >&2; exit 2; }
case $C3_PORT in /dev/*) ;; *) echo "C3_PORT must be an absolute /dev/... path" >&2; exit 2 ;; esac
[ -e "$C3_PORT" ] || echo "note: $C3_PORT does not exist yet; the Connector will poll for it" >&2
[ -s "$DIR/broker.pw" ] || { echo "missing $DIR/broker.pw (mode 600): copy the connector login's password file there" >&2; exit 2; }
[ "$(stat -c %a "$DIR/broker.pw" 2>/dev/null || echo 600)" = 600 ] || { echo "$DIR/broker.pw must be mode 600" >&2; exit 2; }

umask 077
if [ ! -x "$DIR/venv/bin/python" ]; then
  python3 -m venv "$DIR/venv"
  "$DIR/venv/bin/pip" install -q --disable-pip-version-check --require-hashes --no-deps -r "$HERE/requirements.lock"
  "$DIR/venv/bin/pip" install -q --disable-pip-version-check --no-deps "$HERE"
fi

cat > "$DIR/config.toml" <<CONF
[device]
mode = "${MODE}"
select = { path = "${C3_PORT}" }

[mqtt]
client_id = "${C3_USER}"
topic_root = "mecon/${C3_DEVICE_ID}"

[[mqtt.brokers]]
name = "tunnel"
host = "127.0.0.1"
port = ${BPORT}
tls = false
insecure_allow_plain = true   # the broker is reached only through the reverse tunnel on this host's loopback
username = "${C3_USER}"
password_file = "${DIR}/broker.pw"

[health]
enabled = true
bind = "127.0.0.1"
port = 9464
CONF

"$DIR/venv/bin/python" -m mecon_connector --check-config --config "$DIR/config.toml"
echo "running in the foreground for at most ${MAX} s on ${C3_PORT}; Ctrl-C stops it" >&2
# timeout sends SIGTERM first: the Connector then publishes {"online":false} and closes its session.
exec timeout -s TERM -k 15 "$MAX" "$DIR/venv/bin/python" -m mecon_connector --config "$DIR/config.toml" --port "$C3_PORT"
