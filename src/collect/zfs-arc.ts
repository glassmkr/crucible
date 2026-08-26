// ZFS ARC cache statistics from /proc/spl/kstat/zfs/arcstats. collectd
// parity close (zfs_arc plugin), 2026-08-24.
//
// arcstats is world-readable whenever the ZFS module is loaded, so this
// needs neither the privileged wrapper nor the zpool CLI (the pool
// HEALTH collector in zfs.ts stays separate and privileged). Kstat rows
// are "name type data"; we take:
//   size     current ARC size in bytes
//   c        ARC target size in bytes
//   hits     cumulative ARC hits
//   misses   cumulative ARC misses
//
// The hit ratio is computed from the hits/misses INTERVAL deltas, not
// the since-boot totals (which converge to a flattering constant). It is
// null on the first cycle (no baseline), after a counter reset, and when
// the interval saw zero lookups (no data is not 0% and not 100%).
//
// Capability-style: no arcstats file (ZFS not loaded) returns null and
// the snapshot field is absent. Absent means not-loaded, never zero.
// Per field, hits_total/misses_total distinguish answered-no from
// did-not-answer: total null = the row was absent/malformed; totals
// present + ratio null = first cycle, reset, or an idle interval.

import { readProcFile } from "../lib/parse.js";
import type { ZfsArcSnapshot } from "../lib/types.js";

const ARCSTATS_PATH = "/proc/spl/kstat/zfs/arcstats";

// Previous cumulative hits/misses for the delta ratio. Only updated when
// both counters were readable, so a one-cycle parse hiccup does not
// poison the next interval's baseline.
let prevCounters: { hits: number; misses: number } | null = null;

// Parse one "name type data" kstat row; null when the row is missing or
// its data column is not a non-negative integer.
function parseKstat(raw: string, key: string): number | null {
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== key) continue;
    const value = parts[2];
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Collect ARC size, target size, and the interval hit ratio. Returns
 * null when arcstats is unreadable (ZFS not loaded) or contains none of
 * the rows we track. `path` is a test hook.
 */
export function collectZfsArc(path: string = ARCSTATS_PATH): ZfsArcSnapshot | null {
  const raw = readProcFile(path);
  if (!raw) return null;

  const size = parseKstat(raw, "size");
  const target = parseKstat(raw, "c");
  const hits = parseKstat(raw, "hits");
  const misses = parseKstat(raw, "misses");

  if (size === null && target === null && hits === null && misses === null) {
    // The file exists but answered nothing we track; omit the field.
    return null;
  }

  let hitRatioPct: number | null = null;
  if (hits !== null && misses !== null) {
    if (prevCounters) {
      const dHits = hits - prevCounters.hits;
      const dMisses = misses - prevCounters.misses;
      // Negative delta = counter reset (module reload): rebaseline, no
      // ratio this cycle. Zero lookups = no ratio either.
      if (dHits >= 0 && dMisses >= 0 && dHits + dMisses > 0) {
        hitRatioPct = Math.round((dHits / (dHits + dMisses)) * 10000) / 100;
      }
    }
    prevCounters = { hits, misses };
  }

  return {
    size_bytes: size,
    target_bytes: target,
    hits_total: hits,
    misses_total: misses,
    hit_ratio_pct: hitRatioPct,
  };
}

export const __test_only = {
  parseKstat,
  resetForTests: () => {
    prevCounters = null;
  },
};
