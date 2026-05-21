#!/usr/bin/env bash
# Stress profile runner. Profiles per spec §3.1:
#
#   a  CPU saturation:    stress-ng --cpu 0 --cpu-method all
#   b  I/O saturation:    fio random-read against /var/tmp/measurement.fio
#                          + a separate 10-min control without the agent
#                          running so the throughput-with-vs-without
#                          delta is the agent's I/O footprint
#   c  Memory pressure:   stress-ng --vm 4 --vm-bytes 75% --vm-method all
#
# Per spec §3 each profile runs 10 min by default (override via
# STRESS_SECONDS). Concurrent with collect_metrics.sh sampling at 5s.
#
# Output: CSV to stdout. Profile B additionally writes the control
# CSV to a sibling path (stress/b-io-<hostname>-control.csv) — Simon
# specifies the output dir via OUTPUT_DIR env var, default "stress/".
#
# Per-host invocation:
#   bash scripts/run_stress.sh a > stress/a-cpu-$(hostname).csv
#   bash scripts/run_stress.sh b > stress/b-io-$(hostname).csv
#   bash scripts/run_stress.sh c > stress/c-mem-$(hostname).csv

set -u

PROFILE="${1:-}"
STRESS_SECONDS="${STRESS_SECONDS:-600}"
INTERVAL_S="${INTERVAL_S:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-stress}"
HOST="$(hostname)"

# glassmkr-crucible runs as root + Profile B needs systemctl stop/start;
# self-elevate so /proc/<pid>/io reads succeed and systemctl works without
# a per-call sudo prompt.
if [ "$(id -u)" -ne 0 ] && [ -n "${PROFILE:-}" ]; then
  exec sudo -n -E env PROFILE="$PROFILE" STRESS_SECONDS="$STRESS_SECONDS" \
    INTERVAL_S="$INTERVAL_S" OUTPUT_DIR="$OUTPUT_DIR" \
    bash "$0" "$PROFILE"
fi

usage() {
  cat >&2 <<'EOF'
usage: bash run_stress.sh {a|b|c} > <output-csv>

Profiles:
  a  CPU saturation     stress-ng --cpu 0 --cpu-method all
  b  I/O saturation     fio random-read + control run without agent
  c  Memory pressure    stress-ng --vm 4 --vm-bytes 75%

Env overrides:
  STRESS_SECONDS  default 600 (10 minutes)
  INTERVAL_S      default 5 (sample interval for collect_metrics.sh)
  OUTPUT_DIR      default "stress" (for Profile B's control CSV)
EOF
  exit 1
}

run_collector_background() {
  # Spawns collect_metrics.sh writing to the FD passed as $1
  # (>&3 in callers). The collector terminates when the foreground
  # stress process exits and we trap SIGTERM.
  local fd="$1"
  DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
    bash "$SCRIPT_DIR/collect_metrics.sh" >&"$fd" &
  echo $!
}

case "$PROFILE" in
  a)
    command -v stress-ng >/dev/null 2>&1 || {
      echo "[run_stress] stress-ng not installed; apt install stress-ng" >&2
      exit 2
    }
    >&2 echo "[run_stress] profile A (CPU) on ${HOST} for ${STRESS_SECONDS}s"
    # Run collector on stdout, stress in background.
    stress-ng --cpu 0 --cpu-method all --timeout "${STRESS_SECONDS}s" \
      >/dev/null 2>&1 &
    stress_pid=$!
    DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
      bash "$SCRIPT_DIR/collect_metrics.sh"
    wait "$stress_pid" 2>/dev/null || true
    ;;

  b)
    command -v fio >/dev/null 2>&1 || {
      echo "[run_stress] fio not installed; apt install fio" >&2
      exit 2
    }

    FIO_FILE="/var/tmp/measurement.fio"
    FIO_ARGS=(
      --name=measurement-io
      --filename="$FIO_FILE"
      --size=2G
      --bs=4k
      --rw=randread
      --ioengine=libaio
      --iodepth=64
      --runtime="$STRESS_SECONDS"
      --time_based
      --group_reporting
      --output-format=normal
    )

    # Step 1: control run (agent stopped). Writes control CSV via a
    # background tail of /dev/null (no agent so collect_metrics emits
    # empty rows — useful to confirm the gap). Also captures fio
    # throughput summary into a sibling .fio-throughput file.
    >&2 echo "[run_stress] profile B (I/O) on ${HOST}"
    >&2 echo "[run_stress] step 1/2: control run (agent STOPPED) for ${STRESS_SECONDS}s"
    if command -v systemctl >/dev/null 2>&1; then
      sudo systemctl stop glassmkr-crucible || {
        echo "[run_stress] could not stop glassmkr-crucible; aborting" >&2
        exit 3
      }
    fi

    CONTROL_CSV="${OUTPUT_DIR}/b-io-${HOST}-control.csv"
    CONTROL_FIO_OUT="${OUTPUT_DIR}/b-io-${HOST}-control.fio.txt"
    mkdir -p "$OUTPUT_DIR"
    # Sampling during control (agent stopped; rows will be empty but
    # this proves the agent was down for the window).
    DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
      bash "$SCRIPT_DIR/collect_metrics.sh" > "$CONTROL_CSV" &
    sample_pid=$!
    fio "${FIO_ARGS[@]}" > "$CONTROL_FIO_OUT" 2>&1
    wait "$sample_pid" 2>/dev/null || true
    >&2 echo "[run_stress] control fio summary written to $CONTROL_FIO_OUT"

    # Step 2: restart agent and run fio again with concurrent sampling.
    if command -v systemctl >/dev/null 2>&1; then
      sudo systemctl start glassmkr-crucible || {
        echo "[run_stress] could not restart glassmkr-crucible; manual recovery needed" >&2
        exit 4
      }
    fi
    # Give the agent ~10s to settle before measuring.
    sleep 10

    >&2 echo "[run_stress] step 2/2: with-agent run for ${STRESS_SECONDS}s"
    AGENT_FIO_OUT="${OUTPUT_DIR}/b-io-${HOST}.fio.txt"
    fio "${FIO_ARGS[@]}" > "$AGENT_FIO_OUT" 2>&1 &
    fio_pid=$!
    DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
      bash "$SCRIPT_DIR/collect_metrics.sh"
    wait "$fio_pid" 2>/dev/null || true
    >&2 echo "[run_stress] with-agent fio summary written to $AGENT_FIO_OUT"
    >&2 echo "[run_stress] compare IOPS / bandwidth between the two .fio.txt files"

    # Cleanup the test file (2GB).
    rm -f "$FIO_FILE"
    ;;

  c)
    command -v stress-ng >/dev/null 2>&1 || {
      echo "[run_stress] stress-ng not installed; apt install stress-ng" >&2
      exit 2
    }
    >&2 echo "[run_stress] profile C (memory) on ${HOST} for ${STRESS_SECONDS}s"
    # --vm-bytes 75% is "75% of available memory"; on memory-tight
    # hosts this may swap (which is part of the signal we want).
    stress-ng --vm 4 --vm-bytes 75% --vm-method all \
      --timeout "${STRESS_SECONDS}s" >/dev/null 2>&1 &
    stress_pid=$!
    DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
      bash "$SCRIPT_DIR/collect_metrics.sh"
    wait "$stress_pid" 2>/dev/null || true
    ;;

  *)
    usage
    ;;
esac

>&2 echo "[run_stress] done"
