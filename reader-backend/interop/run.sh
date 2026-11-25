#!/usr/bin/env bash
# One-off interop run of the session-lookup v1 contract: a real core against this facade.
#   CORE_DIR=/path/to/core CORE_ENV_FILE=core.env CORE_OPS=/path/to/ops_module.py ./run.sh   (build from a checkout)
#   CORE_IMAGE=registry/core:tag CORE_ENV_FILE=core.env CORE_OPS=/path/to/ops_module.py ./run.sh
# Everything it creates is torn down on exit; its service token is generated here and never printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_TIMEOUT="${INTEROP_TIMEOUT:-900}"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[ -n "$TIMEOUT_BIN" ] || { echo "run.sh: needs timeout(1) (coreutils)" >&2; exit 2; }
: "${CORE_OPS:?set CORE_OPS to the ops module of the core under test, a .py file path}"
[ -f "${CORE_ENV_FILE:-}" ] || { echo "run.sh: set CORE_ENV_FILE to the core's settings file for this run (made-up values)" >&2; exit 2; }
[ -f "$CORE_OPS" ] || { echo "run.sh: CORE_OPS is not a file: $CORE_OPS" >&2; exit 2; }
if [ -z "${CORE_IMAGE:-}" ] && [ -z "${CORE_DIR:-}" ]; then
  echo "run.sh: set CORE_DIR (a checkout to build) or CORE_IMAGE" >&2; exit 2
fi

# The whole run is bounded: re-run this script under timeout (its TERM runs the teardown below).
if [ -z "${INTEROP_INNER:-}" ]; then
  exec "$TIMEOUT_BIN" -k 60 "$TOTAL_TIMEOUT" env INTEROP_INNER=1 "$0" "$@"
fi

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lookup-interop.XXXXXX")"
TOKEN_FILE="$WORK/service_token"
export INTEROP_PROJECT="lookup-interop-$$"
export INTEROP_TOKEN_FILE="$TOKEN_FILE"
export CORE_ENV_FILE="$(cd "$(dirname "$CORE_ENV_FILE")" && pwd)/$(basename "$CORE_ENV_FILE")"
export INTEROP_UID="$(id -u)" INTEROP_GID="$(id -g)"
export CORE_OPS_DIR="$(cd "$(dirname "$CORE_OPS")" && pwd)" CORE_OPS_FILE="$(basename "$CORE_OPS")"
COMPOSE=(docker compose -f "$HERE/compose.yaml")
if [ -n "${CORE_DIR:-}" ]; then
  export CORE_DIR CORE_IMAGE="${CORE_IMAGE:-lookup-interop-core:local}"
  COMPOSE+=(-f "$HERE/compose.core-build.yaml")
fi

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  set +e
  "$TIMEOUT_BIN" -k 10 180 "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  if [ -f "$TOKEN_FILE" ]; then shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"; fi
  rmdir "$WORK" 2>/dev/null
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A fresh made-up service token, in a 0600 file; the value is never printed.
python3 -c 'import secrets, sys; sys.stdout.write(secrets.token_urlsafe(32) + "\n")' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

echo "== building and starting (core, ops agent, facade, driver)"
"$TIMEOUT_BIN" -k 10 600 "${COMPOSE[@]}" up -d --build --wait --wait-timeout 420

echo "== replaying the cases"
rc=0
"$TIMEOUT_BIN" -k 10 300 "${COMPOSE[@]}" exec -T driver python /app/reader-backend/interop/driver.py || rc=$?

if [ "$rc" -ne 0 ]; then
  echo "== a case failed or the run broke (exit $rc); tail of each container's log follows"
  for s in core core-ops facade; do
    echo "---- $s"; "${COMPOSE[@]}" logs --no-color --tail 30 "$s" 2>&1 | sed 's/^/    /' || true
  done
fi
exit "$rc"
