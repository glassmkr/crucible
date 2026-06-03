// Conntrack collection.
//
// Pre-C9: count + max + percent from /proc/sys/net/netfilter/nf_conntrack_*.
// C9 (2026-05-19): adds insert_failed_total + drop_total cumulative counters
// from /proc/net/stat/nf_conntrack plus agent-computed per-second rates,
// following the vmstat (C3) rate-calculation pattern.
//
// Per CC_SPEC_CRUCIBLE_C7_C10_NETWORK_PROCESS_COLLECTION_2026-05-19.md §3.

import { readProcFile } from "../lib/parse.js";
import { RateTracker } from "../lib/rate.js";

export interface ConntrackData {
  available: boolean;
  count: number;
  max: number;
  percent: number;
  // C9 additions. Optional so older agents (and tests that don't care)
  // stay compatible. All cumulative-since-boot unless noted.
  insert_failed_total?: number;
  drop_total?: number;
  // Per-second rates over the most recent interval. Null on first
  // snapshot (no baseline) and after counter reset / wraparound.
  insert_failed_rate_per_sec?: number | null;
  drop_rate_per_sec?: number | null;
}

const rates = new RateTracker();

export function collectConntrack(): ConntrackData {
  const countRaw = readProcFile("/proc/sys/net/netfilter/nf_conntrack_count");
  const maxRaw = readProcFile("/proc/sys/net/netfilter/nf_conntrack_max");

  if (!countRaw || !maxRaw) {
    return { available: false, count: 0, max: 0, percent: 0 };
  }

  const count = parseInt(countRaw.trim(), 10);
  const max = parseInt(maxRaw.trim(), 10);

  if (isNaN(count) || isNaN(max) || max === 0) {
    return { available: false, count: 0, max: 0, percent: 0 };
  }

  const percent = Math.round(((count / max) * 100) * 10) / 10;

  // Try the C9 enrichment. If /proc/net/stat/nf_conntrack isn't readable
  // we still return the original ConntrackData shape (older kernels
  // expose count/max without per-CPU stats).
  const stat = parseConntrackStat();
  if (!stat) {
    return { available: true, count, max, percent };
  }

  // Per-second rates over the most recent interval; null on first
  // snapshot or after a counter reset (host reboot, container restart,
  // rollover). One capture instant for both counters so their baselines
  // advance together (matches the prior single-`previous`-snapshot
  // bookkeeping). RateTracker owns the reset/first-snapshot handling.
  const nowMs = Date.now();
  const insertRate = rates.computeRate("insert_failed", stat.insert_failed, nowMs);
  const dropRate = rates.computeRate("drop", stat.drop, nowMs);

  return {
    available: true,
    count,
    max,
    percent,
    insert_failed_total: stat.insert_failed,
    drop_total: stat.drop,
    insert_failed_rate_per_sec: insertRate,
    drop_rate_per_sec: dropRate,
  };
}

/**
 * Parse /proc/net/stat/nf_conntrack. Format: tab/space-separated header
 * + one row per CPU with hex values. Returns sums across all CPUs for
 * insert_failed and drop columns. Null on read failure or unexpected
 * format.
 */
function parseConntrackStat(): { insert_failed: number; drop: number } | null {
  const raw = readProcFile("/proc/net/stat/nf_conntrack");
  if (!raw) return null;
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const header = lines[0].trim().split(/\s+/);
  const insertFailedIdx = header.indexOf("insert_failed");
  const dropIdx = header.indexOf("drop");
  if (insertFailedIdx === -1 || dropIdx === -1) return null;

  let insertFailedTotal = 0;
  let dropTotal = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length <= Math.max(insertFailedIdx, dropIdx)) continue;
    const insertFailed = parseInt(parts[insertFailedIdx], 16);
    const drop = parseInt(parts[dropIdx], 16);
    if (Number.isFinite(insertFailed)) insertFailedTotal += insertFailed;
    if (Number.isFinite(drop)) dropTotal += drop;
  }
  return { insert_failed: insertFailedTotal, drop: dropTotal };
}

export const __test_only = {
  parseConntrackStat,
  resetForTests: () => {
    rates.reset();
  },
};
