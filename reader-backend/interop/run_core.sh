#!/usr/bin/env bash
# One-off interop run of the reader-core v1 contract: a real core against this repository's HTTP adapter.
#   CORE_IMAGE=registry/core:tag CORE_ENV_FILE=core.env CORE_OPS=/path/to/ops_module.py CORE_LAUNCHER=/path/to/launcher.py ./run_core.sh
#   (the ops module and the launcher sit in one directory outside this repository; the runner builds the core's image)
# Everything it creates is torn down on exit; its service token is generated here and never printed.
# DOCKER_CMD names the docker command (default `docker`; a host where the user needs sudo sets `sudo -n docker`).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_TIMEOUT="${INTEROP_TIMEOUT:-900}"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[ -n "$TIMEOUT_BIN" ] || { echo "run_core.sh: needs timeout(1) (coreutils)" >&2; exit 2; }
: "${CORE_OPS:?set CORE_OPS to the ops module of the core under test, a .py file path}"
[ -f "${CORE_ENV_FILE:-}" ] || { echo "run_core.sh: set CORE_ENV_FILE to the core's settings file for this run (made-up values)" >&2; exit 2; }
[ -f "${CORE_LAUNCHER:-}" ] || { echo "run_core.sh: set CORE_LAUNCHER to the launcher file that starts the core with the ops agent in its process" >&2; exit 2; }
[ -f "$CORE_OPS" ] || { echo "run_core.sh: CORE_OPS is not a file: $CORE_OPS" >&2; exit 2; }

# The whole run is bounded: re-run this script under timeout (its TERM runs the teardown below).
if [ -z "${INTEROP_INNER:-}" ]; then
  exec "$TIMEOUT_BIN" -k 60 "$TOTAL_TIMEOUT" env INTEROP_INNER=1 "$0" "$@"
fi

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reader-core-interop.XXXXXX")"
TOKEN_FILE="$WORK/service_token"
export INTEROP_PROJECT="reader-core-interop-$$"
export INTEROP_TOKEN_FILE="$TOKEN_FILE"
export CORE_ENV_FILE="$(cd "$(dirname "$CORE_ENV_FILE")" && pwd)/$(basename "$CORE_ENV_FILE")"
export INTEROP_UID="$(id -u)" INTEROP_GID="$(id -g)"
export CORE_OPS_DIR="$(cd "$(dirname "$CORE_OPS")" && pwd)" CORE_OPS_FILE="$(basename "$CORE_OPS")" CORE_LAUNCHER_FILE="$(basename "$CORE_LAUNCHER")"
[ "$(cd "$(dirname "$CORE_LAUNCHER")" && pwd)" = "$CORE_OPS_DIR" ] || { echo "run_core.sh: the launcher and the ops module live in one directory" >&2; exit 2; }
if [ -z "${CORE_IMAGE:-}" ]; then echo "run_core.sh: set CORE_IMAGE (the core's image, built by the runner from its checkout)" >&2; exit 2; fi
export CORE_IMAGE
# The compose variables go in a file (no secrets in it), so a `sudo docker` sees them too.
ENVF="$WORK/compose.env"
for v in INTEROP_PROJECT INTEROP_TOKEN_FILE CORE_ENV_FILE INTEROP_UID INTEROP_GID CORE_OPS_DIR CORE_OPS_FILE CORE_LAUNCHER_FILE CORE_IMAGE; do
  printf '%s=%s\n' "$v" "${!v}" >> "$ENVF"
done
read -r -a DOCKER <<< "${DOCKER_CMD:-docker}"
COMPOSE=("${DOCKER[@]}" compose --env-file "$ENVF" -f "$HERE/compose.core.yaml")

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  "$TIMEOUT_BIN" -k 10 180 "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  if [ -f "$TOKEN_FILE" ]; then shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"; fi
  rm -f "$WORK/compose.env"
  rmdir "$WORK" 2>/dev/null
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A fresh made-up service token, in a 0600 file; the value is never printed.
python3 -c 'import secrets, sys; sys.stdout.write(secrets.token_urlsafe(32) + "\n")' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

echo "== building and starting (core with its ops agent, driver)"
"$TIMEOUT_BIN" -k 10 600 "${COMPOSE[@]}" up -d --build --wait --wait-timeout 420

echo "== replaying the cases"
rc=0
"$TIMEOUT_BIN" -k 10 300 "${COMPOSE[@]}" exec -T driver python /app/reader-backend/interop/core_driver.py || rc=$?

if [ "$rc" -ne 0 ]; then
  echo "== a case failed or the run broke (exit $rc); tail of each container's log follows"
  for s in core; do
    echo "---- $s"; "${COMPOSE[@]}" logs --no-color --tail 30 "$s" 2>&1 | sed 's/^/    /' || true
  done
fi
exit "$rc"
