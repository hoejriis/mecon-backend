#!/bin/sh
# C3 harness: the whole chain locally, with the FAKE serial device (no hardware, no remote host). Starts the
# Dockerized Mosquitto with the device-login ACL, then runs the real Connector against the fake device in the
# Connector's test image, driven by the observer and the Backend stand-in scripts, and prints PASS/FAIL.
# From the repository root:   sh connector/scripts/c3_fake_e2e.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DIR=${C3_DIR:-/tmp/mecon-c3-broker}
DEVICE_ID=${C3_DEVICE_ID:-00112233445566778899aabbccddeeff}
USER_NAME="dev-${C3_GATEWAY:-gw0}-g${C3_GENERATION:-1}"
export C3_DIR="$DIR" C3_DEVICE_ID="$DEVICE_ID"
sh "$HERE/c3_broker.sh" up
docker build -q -f "$REPO/connector/Dockerfile" --target test -t mecon-connector-test "$REPO" >/dev/null
OUT=$(mktemp -d)
trap 'sh "$HERE/c3_broker.sh" down >/dev/null; rm -rf "$OUT"' EXIT
chmod 777 "$OUT"
# root in the container so it can read the mode-600 secrets of the host user; everything is read-only except OUT
docker run --rm --user root --network "${C3_NETWORK:-mecon-c3}" -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$REPO/connector/src:/src/src:ro" -v "$REPO/connector/tests:/src/tests:ro" -v "$REPO/connector/scripts:/src/scripts:ro" \
  -v "$DIR/secrets:/c3/secrets:ro" -v "$OUT:/out" -w /src mecon-connector-test \
  python scripts/c3_fake_e2e.py --root "mecon/$DEVICE_ID" --user "$USER_NAME" --secrets /c3/secrets --out-dir /out
