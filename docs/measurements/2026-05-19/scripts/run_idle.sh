#!/usr/bin/env bash
# Idle baseline runner. Wraps collect_metrics.sh with the 30-min
# default the spec calls for. Per-host invocation:
#
#   bash scripts/run_idle.sh > idle/$(hostname).csv
#
# Override with IDLE_SECONDS env var (default 1800 = 30 min).
# Override sample interval with INTERVAL_S (default 5).

set -u

IDLE_SECONDS="${IDLE_SECONDS:-1800}"
INTERVAL_S="${INTERVAL_S:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

>&2 echo "[run_idle] starting ${IDLE_SECONDS}s idle baseline on $(hostname)"
>&2 echo "[run_idle] sample interval ${INTERVAL_S}s"
>&2 echo "[run_idle] writing CSV to stdout"

# glassmkr-crucible runs as root; /proc/<pid>/io and /proc/<pid>/fd require
# matching UID to read. Self-elevate if we are not already root so the
# collector sees full data instead of empty io/fd columns.
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n -E env DURATION_S="$IDLE_SECONDS" INTERVAL_S="$INTERVAL_S" \
    bash "$SCRIPT_DIR/collect_metrics.sh"
fi

DURATION_S="$IDLE_SECONDS" INTERVAL_S="$INTERVAL_S" \
  bash "$SCRIPT_DIR/collect_metrics.sh"

>&2 echo "[run_idle] done"
