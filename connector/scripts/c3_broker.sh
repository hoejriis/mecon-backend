#!/bin/sh
# C3 harness, laptop side: a throwaway local Mosquitto in Docker with a password file and an ACL file in
# exactly the shape the Backend gives a device login. Everything is made up: a synthetic device id and
# login names, random passwords written to mode-600 files. Nothing leaves this machine.
#
#   sh connector/scripts/c3_broker.sh up        start (idempotent); prints the paths and the topic root
#   sh connector/scripts/c3_broker.sh down      stop and remove the container (files stay)
#   sh connector/scripts/c3_broker.sh status    is it running
#   sh connector/scripts/c3_broker.sh clean     down, and delete the directory with its secrets
#
# Environment (all optional):
#   C3_DIR         working directory                (default /tmp/mecon-c3-broker)
#   C3_DEVICE_ID   32 lowercase hex digits          (default a made-up id; set the device's own for a hardware run)
#   C3_GATEWAY     gateway id in the login name     (default gw0)
#   C3_GENERATION  generation in the login name     (default 1)
#   C3_LOCAL_PORT  loopback port on this machine    (default 18830)
#   C3_IMAGE       Mosquitto image                  (default eclipse-mosquitto:2)
#   C3_NETWORK     docker network (for the fake-device run) (default mecon-c3)
set -eu

DIR=${C3_DIR:-/tmp/mecon-c3-broker}
DEVICE_ID=${C3_DEVICE_ID:-00112233445566778899aabbccddeeff}
GATEWAY=${C3_GATEWAY:-gw0}
GENERATION=${C3_GENERATION:-1}
PORT=${C3_LOCAL_PORT:-18830}
IMAGE=${C3_IMAGE:-eclipse-mosquitto:2}
NETWORK=${C3_NETWORK:-mecon-c3}
NAME=mecon-c3-broker
CONNECTOR_USER="dev-${GATEWAY}-g${GENERATION}"
OBSERVER_USER=c3-observer
STANDIN_USER=c3-standin
ROOT="mecon/${DEVICE_ID}"

case $DEVICE_ID in
  *[!0-9a-f]* | "") echo "C3_DEVICE_ID must be 32 lowercase hex digits" >&2; exit 2 ;;
esac
[ "${#DEVICE_ID}" -eq 32 ] || { echo "C3_DEVICE_ID must be 32 lowercase hex digits" >&2; exit 2; }
case $GATEWAY in *[!A-Za-z0-9]* | "") echo "C3_GATEWAY must be alphanumeric" >&2; exit 2 ;; esac
case $GENERATION in *[!0-9]* | "") echo "C3_GENERATION must be a number" >&2; exit 2 ;; esac

write_files() {
  umask 077
  mkdir -p "$DIR/config" "$DIR/secrets"
  chmod 700 "$DIR" "$DIR/secrets"
  for u in connector observer standin; do
    f="$DIR/secrets/$u.pw"
    [ -s "$f" ] || python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_hex(16))' > "$f"
    chmod 600 "$f"
  done
  # The device login's ACL, exactly: publish resp, status and ev/+, subscribe req, nothing else.
  cat > "$DIR/config/acl" <<ACL
# The device login (made up). Publish only its own answers, status and events; read only requests.
user ${CONNECTOR_USER}
topic write ${ROOT}/resp
topic write ${ROOT}/status
topic write ${ROOT}/ev/+
topic read ${ROOT}/req

# Harness observer: read-only view of this device's topics.
user ${OBSERVER_USER}
topic read ${ROOT}/#

# Harness Backend stand-in: may publish requests, nothing else.
user ${STANDIN_USER}
topic write ${ROOT}/req
ACL
  cat > "$DIR/config/mosquitto.conf" <<CONF
listener 1883
allow_anonymous false
password_file /mosquitto/config/passwd
acl_file /mosquitto/config/acl
persistence false
log_dest stdout
connection_messages true
CONF
  # Mosquitto's PBKDF2-SHA512 ($7$) password file, built here so no password appears in a command line.
  C3_DIR=$DIR C3_USERS="${CONNECTOR_USER}:connector ${OBSERVER_USER}:observer ${STANDIN_USER}:standin" python3 - <<'PY'
import base64, hashlib, os, pathlib
d = pathlib.Path(os.environ["C3_DIR"])
lines = []
for pair in os.environ["C3_USERS"].split():
    user, key = pair.split(":")
    pw = (d / "secrets" / f"{key}.pw").read_bytes()
    salt = os.urandom(12)
    h = hashlib.pbkdf2_hmac("sha512", pw, salt, 101, dklen=64)
    lines.append(f"{user}:$7$101${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}")
(d / "config" / "passwd").write_text("\n".join(lines) + "\n")
PY
  # The container's mosquitto user must be able to read the files; the directory itself stays private.
  chmod 644 "$DIR/config/acl" "$DIR/config/passwd" "$DIR/config/mosquitto.conf"
  chmod 755 "$DIR/config"
}

case ${1:-} in
  up)
    command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "already running"; else
      write_files
      docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" --network "$NETWORK" --network-alias "$NAME" \
        -p "127.0.0.1:${PORT}:1883" -v "$DIR/config:/mosquitto/config:ro" "$IMAGE" >/dev/null
    fi
    i=0
    until python3 -c "import socket,sys; socket.create_connection(('127.0.0.1',$PORT),1).close()" 2>/dev/null; do
      i=$((i + 1)); [ "$i" -lt 50 ] || { echo "broker did not come up; docker logs $NAME" >&2; exit 1; }
      sleep 0.2
    done
    echo "broker      127.0.0.1:${PORT} (loopback only), container ${NAME} on network ${NETWORK}"
    echo "topic root  ${ROOT}"
    echo "logins      ${CONNECTOR_USER} (device), ${OBSERVER_USER}, ${STANDIN_USER}"
    echo "password files (mode 600, never printed): ${DIR}/secrets/{connector,observer,standin}.pw"
    echo "acl         ${DIR}/config/acl"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  status)
    docker ps --filter "name=^${NAME}\$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
    ;;
  clean)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    rm -rf "$DIR"
    echo "removed $DIR"
    ;;
  *)
    echo "usage: $0 up|down|status|clean" >&2
    exit 2
    ;;
esac
