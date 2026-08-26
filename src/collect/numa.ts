// sysfs NUMA collection: per-node memory occupancy + allocation-locality
// counter rates. collectd parity close (numa plugin), 2026-08-24.
//
// Files read, per /sys/devices/system/node/nodeN/:
//   meminfo    "Node N MemTotal: X kB" style lines; we take MemTotal and
//              MemFree (kB)
//   numastat   "numa_hit N" style cumulative counters; we take numa_hit,
//              numa_miss, numa_foreign and turn them into per-second
//              rates via RateTracker (first cycle and counter resets
//              report null, never 0)
//
// Capability-style: hosts whose kernel exposes no nodeN dirs (no NUMA
// sysfs surface) return null and the snapshot field is absent. A
// single-node host still emits: one node is an answer, not an absence.
// Per field, the cumulative *_total distinguishes answered-no from
// did-not-answer: total null = the counter line was absent/malformed;
// total present + rate null = first cycle or counter reset.

import { join } from "node:path";
import { readDirSafe, readProcFile } from "../lib/parse.js";
import { RateTracker } from "../lib/rate.js";
import type { NumaNode, NumaSnapshot } from "../lib/types.js";

const NODE_ROOT = "/sys/devices/system/node";

const rates = new RateTracker();

// Parse one "key value" cumulative counter out of a numastat blob; null
// when the line is missing or the value is not a non-negative integer.
function parseNumastatCounter(raw: string, key: string): number | null {
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== key) continue;
    const value = parts[1];
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// Parse "Node N MemTotal:  X kB" style lines; null when the requested
// key's line is missing or malformed.
function parseNodeMeminfo(raw: string, key: string): number | null {
  const m = raw.match(new RegExp(`^Node\\s+\\d+\\s+${key}:\\s+(\\d+)\\s*kB\\s*$`, "m"));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Collect per-NUMA-node memory + locality counters plus a node count and
 * the max memory-use imbalance (percentage points) across nodes. Returns
 * null when no nodeN dir exists. `root` and `nowMs` are test hooks.
 */
export function collectNuma(
  root: string = NODE_ROOT,
  nowMs: number = Date.now(),
): NumaSnapshot | null {
  const nodeDirs = readDirSafe(root)
    .map((name) => {
      const m = name.match(/^node(\d+)$/);
      return m ? { name, ordinal: parseInt(m[1], 10) } : null;
    })
    .filter((e): e is { name: string; ordinal: number } => e !== null)
    .sort((a, b) => a.ordinal - b.ordinal);

  if (nodeDirs.length === 0) return null;

  const nodes: NumaNode[] = [];
  for (const { name, ordinal } of nodeDirs) {
    const meminfoRaw = readProcFile(join(root, name, "meminfo"));
    const numastatRaw = readProcFile(join(root, name, "numastat"));

    const hit = numastatRaw ? parseNumastatCounter(numastatRaw, "numa_hit") : null;
    const miss = numastatRaw ? parseNumastatCounter(numastatRaw, "numa_miss") : null;
    const foreign = numastatRaw ? parseNumastatCounter(numastatRaw, "numa_foreign") : null;

    nodes.push({
      node: ordinal,
      mem_total_kb: meminfoRaw ? parseNodeMeminfo(meminfoRaw, "MemTotal") : null,
      mem_free_kb: meminfoRaw ? parseNodeMeminfo(meminfoRaw, "MemFree") : null,
      numa_hit_total: hit,
      numa_hit_rate: hit !== null ? rates.computeRate(`node${ordinal}:numa_hit`, hit, nowMs) : null,
      numa_miss_total: miss,
      numa_miss_rate: miss !== null ? rates.computeRate(`node${ordinal}:numa_miss`, miss, nowMs) : null,
      numa_foreign_total: foreign,
      numa_foreign_rate: foreign !== null ? rates.computeRate(`node${ordinal}:numa_foreign`, foreign, nowMs) : null,
    });
  }

  // Memory-use imbalance: spread between the most- and least-used node,
  // in percentage points of each node's own capacity. 0 on a single
  // (readable) node; null when no node's meminfo was readable.
  const usedPcts = nodes
    .map((n) =>
      n.mem_total_kb !== null && n.mem_total_kb > 0 && n.mem_free_kb !== null
        ? ((n.mem_total_kb - n.mem_free_kb) / n.mem_total_kb) * 100
        : null,
    )
    .filter((v): v is number => v !== null);

  return {
    nodes,
    node_count: nodes.length,
    max_mem_used_imbalance_pct:
      usedPcts.length > 0
        ? Math.round((Math.max(...usedPcts) - Math.min(...usedPcts)) * 10) / 10
        : null,
  };
}

export const __test_only = {
  parseNumastatCounter,
  parseNodeMeminfo,
  resetForTests: () => {
    rates.reset();
  },
};
