#!/usr/bin/env bash
# Per-snapshot resource sampling of the glassmkr-crucible agent.
#
# Samples once every $INTERVAL_S (default 5s) until $DURATION_S elapses
# (default 1800s = 30 min). Writes a CSV to stdout; one row per sample
# plus a CSV header on the first line.
#
# Columns (matching the spec §2.1):
#   ts_iso              ISO 8601 timestamp of the sample
#   pid                 agent PID (or empty if not running this tick)
#   rss_kb              resident set size from ps
#   vsz_kb              virtual size from ps
#   cpu_pct             instantaneous CPU% from ps (since process start)
#   cpu_user_jiffies    from /proc/<pid>/stat field 14 (utime)
#   cpu_sys_jiffies     from /proc/<pid>/stat field 15 (stime)
#   fd_count            entries in /proc/<pid>/fd
#   thread_count        entries in /proc/<pid>/task
#   io_read_bytes       /proc/<pid>/io read_bytes
#   io_write_bytes      /proc/<pid>/io write_bytes
#
# Designed to run on Debian / Ubuntu / RHEL family with no extra deps.
# Service name: glassmkr-crucible.service.

set -u

DURATION_S="${DURATION_S:-1800}"
INTERVAL_S="${INTERVAL_S:-5}"
SERVICE="${SERVICE:-glassmkr-crucible.service}"

resolve_pid() {
  local p=""
  # Prefer systemd's view; fall back to pgrep.
  if command -v systemctl >/dev/null 2>&1; then
    p="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)"
  fi
  if [ -z "$p" ] || [ "$p" = "0" ]; then
    p="$(pgrep -f glassmkr-crucible | head -1 || true)"
  fi
  echo "$p"
}

read_proc_field() {
  # $1: path, $2: regex (matching `^key`), $3: field index after the key.
  # Used for /proc/<pid>/io which is key:value pairs, one per line.
  local file="$1"
  local key="$2"
  awk -v k="$key" '$1==k":" { print $2; exit }' "$file" 2>/dev/null
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# CSV header.
echo "ts_iso,pid,rss_kb,vsz_kb,cpu_pct,cpu_user_jiffies,cpu_sys_jiffies,fd_count,thread_count,io_read_bytes,io_write_bytes"

start_s="$(date +%s)"
end_s=$(( start_s + DURATION_S ))

while [ "$(date +%s)" -lt "$end_s" ]; do
  ts="$(iso_now)"
  pid="$(resolve_pid)"
  if [ -z "$pid" ] || [ "$pid" = "0" ] || [ ! -d "/proc/$pid" ]; then
    # Agent not running this tick; emit a row with empty values so the
    # consumer can see gaps. This is itself useful signal (agent crash
    # mid-measurement).
    echo "${ts},,,,,,,,,,"
    sleep "$INTERVAL_S"
    continue
  fi

  read -r rss vsz cpu < <(ps -o rss=,vsz=,%cpu= -p "$pid" 2>/dev/null | awk '{print $1, $2, $3}')
  rss="${rss:-}"; vsz="${vsz:-}"; cpu="${cpu:-}"

  # CPU jiffies from /proc/<pid>/stat (fields 14 = utime, 15 = stime).
  # Process name in field 2 may contain spaces wrapped in parens; we
  # use awk to skip the (comm) section reliably.
  read -r utime stime < <(awk '{
    # everything after the first '(' through the matching ')' is comm;
    # the next field after that close-paren is field 3 (state).
    line=$0
    close = index(line, ")")
    rest = substr(line, close + 2)
    n = split(rest, f, " ")
    # In `rest`, f[1] = state, f[2] = ppid, ..., f[12] = utime, f[13] = stime.
    print f[12], f[13]
  }' /proc/"$pid"/stat 2>/dev/null)
  utime="${utime:-}"; stime="${stime:-}"

  fd_count="$(ls /proc/"$pid"/fd 2>/dev/null | wc -l | awk '{print $1}')"
  thread_count="$(ls /proc/"$pid"/task 2>/dev/null | wc -l | awk '{print $1}')"

  io_read="$(read_proc_field /proc/"$pid"/io read_bytes)"
  io_write="$(read_proc_field /proc/"$pid"/io write_bytes)"

  echo "${ts},${pid},${rss},${vsz},${cpu},${utime},${stime},${fd_count},${thread_count},${io_read:-},${io_write:-}"
  sleep "$INTERVAL_S"
done
