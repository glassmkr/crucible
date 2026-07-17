// /proc/net/softnet_stat per-CPU NET_RX softirq counters.
//
// Per-CPU rows (hex values). The kernel prints them in softnet_seq_show()
// (net/core/net-procfs.c) as sd->processed, sd->dropped, sd->time_squeeze,
// then per-version extensions. So the column order is:
//   col 0: packets processed
//   col 1: packets dropped (backlog full / no receiving CPU): the real
//          "softnet drops" signal, and what Dashboard's softnet_drops
//          rule fires on
//   col 2: time_squeeze (the NET_RX softirq exhausted its budget/time
//          before draining the queue): a softirq-pressure signal, NOT a
//          packet drop
//   col 3+: varies by kernel version (received_rps, flow_limit_count, ...)
//
// A prior version of this file had cols 1 and 2 swapped (surfacing
// time_squeeze as `dropped`), which both missed real drops and reported
// softirq budget exhaustion as packet loss. Corrected 2026-07-17 per Codex
// review, anchored on the kernel source above.
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §1.4.

import { readProcFile } from "../lib/parse.js";
import { RateTracker } from "../lib/rate.js";

export interface SoftnetSnapshot {
  available: boolean;
  reason?: string;
  /** Sum of column-1 (sd->dropped) across CPUs, cumulative since boot. */
  total_dropped_cumulative: number;
  /** Per-CPU drops; index is CPU ordinal. Empty when unavailable. */
  per_cpu_dropped: number[];
  /** Per-second drop rate over the most recent interval; null on
   *  first snapshot or after a counter reset. */
  total_dropped_rate_per_sec: number | null;
}

const rates = new RateTracker();

const DROPPED_COL = 1; // sd->dropped
const TIME_SQUEEZE_COL = 2; // sd->time_squeeze

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
