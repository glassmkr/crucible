// /proc/net/softnet_stat per-CPU NET_RX softirq counters.
//
// Per-CPU rows (hex values). Columns observed in modern Linux:
//   col 0: packets processed
//   col 1: packets dropped due to NET_RX softirq budget exhaustion
//          (time_squeeze; rarely the signal we want)
//   col 2: packets dropped because the per-CPU input backlog filled
//          (input_queue_dropped; the real "softnet drops" signal)
//   col 3+: varies by kernel version (squeezed_count, received_rps,
//          flow_limit_count, ...)
//
// Column 2 is what we surface as `dropped` per Dashboard's
// softnet_drops rule. Different sources/blogs disagree on column
// indexing; we anchor on the kernel source (net/core/dev.c
// softnet_seq_show) where the order is: total processed, time_squeeze,
// dropped (cpu_collision), then per-version extensions.
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §1.4.

import { readProcFile } from "../lib/parse.js";
import { RateTracker } from "../lib/rate.js";

export interface SoftnetSnapshot {
  available: boolean;
  reason?: string;
  /** Sum of column-2 drops across CPUs, cumulative since boot. */
  total_dropped_cumulative: number;
  /** Per-CPU drops; index is CPU ordinal. Empty when unavailable. */
  per_cpu_dropped: number[];
  /** Per-second drop rate over the most recent interval; null on
   *  first snapshot or after a counter reset. */
  total_dropped_rate_per_sec: number | null;
}

const rates = new RateTracker();

const TIME_SQUEEZE_COL = 1;
const DROPPED_COL = 2;

export function collectSoftnet(): SoftnetSnapshot {
  const raw = readProcFile("/proc/net/softnet_stat");
  if (!raw) {
    return {
      available: false,
      reason: "/proc/net/softnet_stat not readable",
      total_dropped_cumulative: 0,
      per_cpu_dropped: [],
      total_dropped_rate_per_sec: null,
    };
  }

  const perCpu: number[] = [];
  let total = 0;
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/).filter((f) => f.length > 0);
    if (fields.length <= DROPPED_COL) continue;
    const dropped = Number.parseInt(fields[DROPPED_COL], 16);
    if (!Number.isFinite(dropped)) continue;
    perCpu.push(dropped);
    total += dropped;
  }

  if (perCpu.length === 0) {
    return {
      available: false,
      reason: "/proc/net/softnet_stat parsed but no rows",
      total_dropped_cumulative: 0,
      per_cpu_dropped: [],
      total_dropped_rate_per_sec: null,
    };
  }

  // Per-second drop rate; null on first snapshot or after a counter
  // reset (host reboot, etc.). RateTracker owns the baseline + reset
  // bookkeeping.
  const ratePerSec = rates.computeRate("dropped", total, Date.now());

  return {
    available: true,
    total_dropped_cumulative: total,
    per_cpu_dropped: perCpu,
    total_dropped_rate_per_sec: ratePerSec,
  };
}

export const __test_only = {
  TIME_SQUEEZE_COL,
  DROPPED_COL,
  resetForTests: () => {
    rates.reset();
  },
};
