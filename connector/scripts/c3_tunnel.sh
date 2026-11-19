#!/bin/sh
# C3 harness, laptop side: a reverse SSH tunnel so a Connector on the bench host reaches the local broker
# as 127.0.0.1:<remote port> on that host. The broker stays bound to this machine's loopback; the tunnel
# listens on the bench host's loopback only. Foreground, bounded, closes when the time is up.
#
#   C3_BENCH_HOST=<ssh destination>  sh connector/scripts/c3_tunnel.sh
#
# Environment:
#   C3_BENCH_HOST   required. An ssh destination or ssh_config alias for the bench host (a placeholder here).
#   C3_LOCAL_PORT   the local broker's port       (default 18830)
#   C3_REMOTE_PORT  the port opened on the host   (default 18830)
#   C3_MAX_SECONDS  the tunnel closes after this  (default 3600)
set -eu
: "${C3_BENCH_HOST:?set C3_BENCH_HOST to the bench host (ssh destination)}"
LOCAL=${C3_LOCAL_PORT:-18830}
REMOTE=${C3_REMOTE_PORT:-18830}
MAX=${C3_MAX_SECONDS:-3600}
echo "tunnel: ${C3_BENCH_HOST} 127.0.0.1:${REMOTE} -> this machine 127.0.0.1:${LOCAL}, for at most ${MAX} s (Ctrl-C to close)" >&2
exec perl -e 'alarm shift; exec @ARGV' "$MAX" \
  ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -R "127.0.0.1:${REMOTE}:127.0.0.1:${LOCAL}" "$C3_BENCH_HOST"
