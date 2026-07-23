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
# CSV to a private root-owned output directory. Override the default with
# an absolute OUTPUT_DIR whose complete directory chain is root-owned and
# not group- or world-writable.
#
# Per-host invocation:
#   bash scripts/run_stress.sh a > stress/a-cpu-$(hostname).csv
#   bash scripts/run_stress.sh b > stress/b-io-$(hostname).csv
#   bash scripts/run_stress.sh c > stress/c-mem-$(hostname).csv

set -u
set -o noclobber
umask 077
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export LC_ALL=C

PROFILE="${1:-}"
STRESS_SECONDS="${STRESS_SECONDS:-600}"
INTERVAL_S="${INTERVAL_S:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
OUTPUT_DIR="${OUTPUT_DIR:-/var/lib/glassmkr/measurements/stress}"
HOST="$(hostname)"
# Private root-owned lock dir (NOT world-writable /run/lock, where a local user could
# preplant the lock path as a symlink and have our open truncate the target as root).
PROFILE_B_LOCK_DIR="/run/glassmkr-crucible"
PROFILE_B_LOCK_FILE="${PROFILE_B_LOCK_DIR}/stress.lock"

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
  OUTPUT_DIR      default /var/lib/glassmkr/measurements/stress
                  Must be absolute with a root-owned, non-writable path chain.
EOF
  exit 1
}

SERVICE_NEEDS_RESTORE=0
sample_pid=""
fio_pid=""
stress_pid=""
PROFILE_B_LOCK_FD=""
FIO_FILE=""
FIO_FILE_CLEANUP=0

cleanup() {
  local status=$?
  trap '' INT TERM
  trap - EXIT
  local pid
  for pid in "$sample_pid" "$fio_pid" "$stress_pid"; do
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [ "$SERVICE_NEEDS_RESTORE" -eq 1 ]; then
    if ! systemctl start glassmkr-crucible; then
      echo "[run_stress] CRITICAL: failed to restore glassmkr-crucible" >&2
      [ "$status" -ne 0 ] || status=5
    fi
  fi
  if [ "$FIO_FILE_CLEANUP" -eq 1 ] && [ -n "$FIO_FILE" ]; then
    rm -f -- "$FIO_FILE"
  fi
  if [[ "$PROFILE_B_LOCK_FD" =~ ^[0-9]+$ ]]; then
    flock -u "$PROFILE_B_LOCK_FD" 2>/dev/null || true
    exec {PROFILE_B_LOCK_FD}>&-
    PROFILE_B_LOCK_FD=""
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

validate_output_dir_syntax() {
  if [[ "$OUTPUT_DIR" =~ [[:cntrl:]] ]]; then
    echo "[run_stress] OUTPUT_DIR must not contain control characters" >&2
    return 1
  fi
  if [ "$OUTPUT_DIR" = "/" ] || [[ "$OUTPUT_DIR" != /* ]] || [[ "$OUTPUT_DIR" == *"//"* ]] || [[ "$OUTPUT_DIR" == */ ]] || [[ "/$OUTPUT_DIR/" == *"/../"* ]] || [[ "/$OUTPUT_DIR/" == *"/./"* ]]; then
    echo "[run_stress] OUTPUT_DIR must be a normalized absolute path" >&2
    return 1
  fi
}

reject_symlink_components() {
  local path="$1"
  local current=""
  local component
  local -a components=()
  IFS='/' read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [ -n "$component" ] || continue
    current="${current}/${component}"
    if [ -L "$current" ]; then
      echo "[run_stress] refusing symlink in output path: $current" >&2
      return 1
    fi
  done
}

require_root_owned_safe_path() {
  local path="$1"
  local expected_kind="$2"
  local metadata owner group mode kind
  if [ -L "$path" ]; then
    echo "[run_stress] refusing symlinked trusted path: $path" >&2
    return 1
  fi
  metadata="$(stat -c '%u %g %a %F' -- "$path")" || return 1
  read -r owner group mode kind <<< "$metadata"
  if [ "$kind" != "$expected_kind" ] || [ "$owner" -ne 0 ] || [ "$group" -ne 0 ] || (( (8#$mode & 022) != 0 )); then
    echo "[run_stress] trusted path must be root-owned and not group/world-writable: $path" >&2
    return 1
  fi
}

assert_trusted_scripts() {
  require_root_owned_safe_path "$SCRIPT_DIR" "directory" || return 1
  require_root_owned_safe_path "$SCRIPT_DIR/run_stress.sh" "regular file" || return 1
  require_root_owned_safe_path "$SCRIPT_DIR/collect_metrics.sh" "regular file" || return 1
}

require_supported_platform() {
  if [ "$(uname -s)" != "Linux" ] || ! stat --version 2>/dev/null | head -n 1 | grep -q "GNU coreutils"; then
    echo "[run_stress] Linux with GNU coreutils is required" >&2
    return 1
  fi
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --version 2>/dev/null | head -n 1 | grep -q '^systemd '; then
    echo "[run_stress] systemd is required" >&2
    return 1
  fi
}

acquire_profile_b_lock() {
  local lock_path="${1:-$PROFILE_B_LOCK_FILE}"
  # /run is root-owned (not world-writable), so a non-root user cannot create this dir;
  # install resets an existing one to root:root 0700 so only root can place the lock.
  install -d -o root -g root -m 0700 -- "$(dirname -- "$lock_path")" || return 1
  if [ -L "$lock_path" ]; then
    echo "[run_stress] refusing symlinked lock path $lock_path" >&2
    return 1
  fi
  # Append (no truncation) so opening never zeroes a file; flock only needs the fd.
  exec {PROFILE_B_LOCK_FD}>>"$lock_path" || return 1
  if ! flock -n "$PROFILE_B_LOCK_FD"; then
    echo "[run_stress] another Profile B run holds $lock_path" >&2
    return 1
  fi
}

prepare_private_output_dir() {
  validate_output_dir_syntax || return 1
  reject_symlink_components "$OUTPUT_DIR" || return 1

  local current=""
  local component
  local -a components=()
  IFS='/' read -r -a components <<< "${OUTPUT_DIR#/}"
  for component in "${components[@]}"; do
    [ -n "$component" ] || continue
    current="${current}/${component}"
    if [ -L "$current" ]; then
      echo "[run_stress] refusing symlink in output path: $current" >&2
      return 1
    fi
    if [ -e "$current" ]; then
      local existing_metadata existing_owner existing_group existing_mode existing_kind
      existing_metadata="$(stat -c '%u %g %a %F' -- "$current")" || return 1
      read -r existing_owner existing_group existing_mode existing_kind <<< "$existing_metadata"
      if [ "$existing_kind" != "directory" ] || [ "$existing_owner" -ne 0 ] || [ "$existing_group" -ne 0 ] || (( (8#$existing_mode & 022) != 0 )); then
        echo "[run_stress] refusing unsafe existing output path component: $current" >&2
        return 1
      fi
    fi
  done

  install -d -o root -g root -m 0700 -- "$OUTPUT_DIR" || return 1
  current=""
  for component in "${components[@]}"; do
    [ -n "$component" ] || continue
    current="${current}/${component}"
    if [ -L "$current" ]; then
      echo "[run_stress] refusing symlink in output path: $current" >&2
      return 1
    fi
    local metadata owner group mode kind
    metadata="$(stat -c '%u %g %a %F' -- "$current")" || return 1
    read -r owner group mode kind <<< "$metadata"
    if [ "$kind" != "directory" ] || [ "$owner" -ne 0 ] || [ "$group" -ne 0 ] || (( (8#$mode & 022) != 0 )); then
      echo "[run_stress] output path component is not a protected root-owned directory: $current" >&2
      return 1
    fi
  done
  metadata="$(stat -c '%u %g %a %F' -- "$OUTPUT_DIR")" || return 1
  read -r owner group mode kind <<< "$metadata"
  if (( (8#$mode & 077) != 0 )); then
    echo "[run_stress] output directory must be private (0700): $OUTPUT_DIR" >&2
    return 1
  fi
}

require_new_output() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "[run_stress] refusing to overwrite existing output: $path" >&2
    return 1
  fi
}

if [ "${RUN_STRESS_SOURCE_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

case "$PROFILE" in
  a|b|c) ;;
  *) usage ;;
esac

validate_output_dir_syntax || exit 3
require_supported_platform || exit 2
assert_trusted_scripts || exit 2

# Profile B controls the service, and every profile reads root-owned proc data.
# Re-exec with a minimal environment so root never inherits caller-controlled
# command lookup or unrelated variables.
if [ "$(id -u)" -ne 0 ]; then
  exec /usr/bin/sudo -n /usr/bin/env -i \
    PATH="/usr/sbin:/usr/bin:/sbin:/bin" LC_ALL=C \
    STRESS_SECONDS="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
    OUTPUT_DIR="$OUTPUT_DIR" \
    /bin/bash "$SCRIPT_DIR/run_stress.sh" "$PROFILE"
fi

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
    stress_pid=""
    ;;

  b)
    command -v fio >/dev/null 2>&1 || {
      echo "[run_stress] fio not installed; apt install fio" >&2
      exit 2
    }

    # Step 1: control run with the agent stopped. collect_metrics records the
    # host window while agent process fields remain absent. fio writes its
    # throughput summary into a sibling file.
    >&2 echo "[run_stress] profile B (I/O) on ${HOST}"
    >&2 echo "[run_stress] step 1/2: control run (agent STOPPED) for ${STRESS_SECONDS}s"
    command -v systemctl >/dev/null 2>&1 || {
      echo "[run_stress] systemctl is required for profile B" >&2
      exit 3
    }
    command -v flock >/dev/null 2>&1 || {
      echo "[run_stress] flock is required for profile B" >&2
      exit 3
    }
    acquire_profile_b_lock || exit 3
    systemctl is-active --quiet glassmkr-crucible || {
      echo "[run_stress] glassmkr-crucible must be active before profile B" >&2
      exit 3
    }
    prepare_private_output_dir || exit 3
    [[ "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || {
      echo "[run_stress] refusing unsafe hostname in output filename" >&2
      exit 3
    }
    FIO_FILE="$(mktemp -- "${OUTPUT_DIR}/measurement-${HOST}.XXXXXXXX.fio")" || exit 3
    FIO_FILE_CLEANUP=1
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
    CONTROL_CSV="${OUTPUT_DIR}/b-io-${HOST}-control.csv"
    CONTROL_FIO_OUT="${OUTPUT_DIR}/b-io-${HOST}-control.fio.txt"
    AGENT_FIO_OUT="${OUTPUT_DIR}/b-io-${HOST}.fio.txt"
    require_new_output "$CONTROL_CSV" || exit 3
    require_new_output "$CONTROL_FIO_OUT" || exit 3
    require_new_output "$AGENT_FIO_OUT" || exit 3
    SERVICE_NEEDS_RESTORE=1
    systemctl stop glassmkr-crucible || {
      echo "[run_stress] could not stop glassmkr-crucible; aborting" >&2
      exit 3
    }

    # Sampling during control (agent stopped; rows will be empty but
    # this proves the agent was down for the window).
    DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
      bash "$SCRIPT_DIR/collect_metrics.sh" > "$CONTROL_CSV" &
    sample_pid=$!
    if ! fio "${FIO_ARGS[@]}" > "$CONTROL_FIO_OUT" 2>&1; then
      echo "[run_stress] control fio run failed" >&2
      exit 3
    fi
    wait "$sample_pid" 2>/dev/null || true
    sample_pid=""
    >&2 echo "[run_stress] control fio summary written to $CONTROL_FIO_OUT"

    # Step 2: restart agent and run fio again with concurrent sampling.
    systemctl start glassmkr-crucible || {
      echo "[run_stress] could not restart glassmkr-crucible; cleanup will retry" >&2
      exit 4
    }
    SERVICE_NEEDS_RESTORE=0
    # Give the agent ~10s to settle before measuring.
    sleep 10

    >&2 echo "[run_stress] step 2/2: with-agent run for ${STRESS_SECONDS}s"
    fio "${FIO_ARGS[@]}" > "$AGENT_FIO_OUT" 2>&1 &
    fio_pid=$!
    DURATION_S="$STRESS_SECONDS" INTERVAL_S="$INTERVAL_S" \
      bash "$SCRIPT_DIR/collect_metrics.sh"
    if ! wait "$fio_pid"; then
      fio_pid=""
      echo "[run_stress] with-agent fio run failed" >&2
      exit 3
    fi
    fio_pid=""
    >&2 echo "[run_stress] with-agent fio summary written to $AGENT_FIO_OUT"
    >&2 echo "[run_stress] compare IOPS / bandwidth between the two .fio.txt files"

    # Cleanup also runs from the EXIT/signal trap.
    rm -f -- "$FIO_FILE"
    FIO_FILE_CLEANUP=0
    FIO_FILE=""
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
    stress_pid=""
    ;;

  *)
    usage
    ;;
esac

>&2 echo "[run_stress] done"
