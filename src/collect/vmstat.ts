// /proc/vmstat collection for swap-in/swap-out rates plus page-fault
// and page-scan/steal rates (collectd vmem parity close, 2026-08-24).
//
// Per CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION_2026-05-19.md (C3).
//
// Output: per-second rates derived from cumulative counter deltas
// across snapshot intervals. The first snapshot returns null rates
// because there's no prior counter to delta against.
//
// Delta pattern matches src/collect/io-latency.ts: a module-level
// previous-counters record holds the prior cumulative values. On each
// call we compute (current - previous) / elapsed_seconds. Stale entries
// (host that rebooted, counter went backwards) are detected and
// discarded.
//
// Field-presence contract for the fault/scan/steal rates: the field is
// OMITTED when the counter key is absent from /proc/vmstat
// (did-not-answer) and null on the first snapshot, after a counter
// reset, or over a non-positive interval (answered, no rate yet). The
// legacy pswp* fields keep their original always-present shape.

import { readProcFile } from "../lib/parse.js";
import type { VmstatSnapshot } from "../lib/types.js";

interface VmstatCounters {
  pswpin: number;
  pswpout: number;
  // Optional counters: undefined when the key is absent from the file.
  pgfault?: number;
  pgmajfault?: number;
  pgscan?: number;
  pgsteal?: number;
  capturedAtMs: number;
}

const PROC_VMSTAT = "/proc/vmstat";

// pgscan_anon/pgscan_file (and the pgsteal twins) classify the SAME
// scanned/reclaimed pages by type that pgscan_kswapd/pgscan_direct/
// pgscan_khugepaged classify by reclaim source; summing both breakdowns
// would double-count. pgscan_direct_throttle counts throttle EVENTS,
// not pages. All are excluded from the sums.
const SCAN_EXCLUDE = new Set([
  "pgscan_anon",
  "pgscan_file",
  "pgscan_direct_throttle",
  "pgsteal_anon",
  "pgsteal_file",
]);

let previous: VmstatCounters | null = null;

function parseVmstat(path: string, nowMs: number): VmstatCounters | null {
  const raw = readProcFile(path);
  if (!raw) return null;
  let pswpin: number | undefined;
  let pswpout: number | undefined;
  let pgfault: number | undefined;
  let pgmajfault: number | undefined;
  let pgscan: number | undefined;
  let pgsteal: number | undefined;
  for (const line of raw.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k === undefined || v === undefined) continue;
    if (k === "pswpin") pswpin = Number(v);
    else if (k === "pswpout") pswpout = Number(v);
    else if (SCAN_EXCLUDE.has(k)) continue;
    else {
      const n = Number(v);
      if (!Number.isFinite(n)) continue; // malformed value = did not answer
      if (k === "pgfault") pgfault = n;
      else if (k === "pgmajfault") pgmajfault = n;
      // Covers the modern reclaim-source keys (pgscan_kswapd,
      // pgscan_direct, pgscan_khugepaged) and the old per-zone variants
      // (pgscan_kswapd_dma, pgscan_direct_normal, ...).
      else if (k.startsWith("pgscan_")) pgscan = (pgscan ?? 0) + n;
      else if (k.startsWith("pgsteal_")) pgsteal = (pgsteal ?? 0) + n;
    }
  }
  if (pswpin === undefined || pswpout === undefined) return null;
  return { pswpin, pswpout, pgfault, pgmajfault, pgscan, pgsteal, capturedAtMs: nowMs };
}

// Rate for one optional counter. undefined = key absent this cycle
// (field omitted); null = answered but no rate (no baseline for the
// key, reset in progress, or caller said rating is off this cycle).
function optionalRate(
  cur: number | undefined,
  prev: number | undefined,
  elapsedSeconds: number,
  canRate: boolean,
): number | null | undefined {
  if (cur === undefined) return undefined;
  if (!canRate || prev === undefined) return null;
  const delta = cur - prev;
  if (delta < 0) return null;
  return delta / elapsedSeconds;
}

function buildSnapshot(
  current: VmstatCounters,
  prev: VmstatCounters | null,
  elapsedSeconds: number,
  canRate: boolean,
): VmstatSnapshot {
  const out: VmstatSnapshot = {
    pswpin_total: current.pswpin,
    pswpout_total: current.pswpout,
    pswpin_rate: canRate ? (current.pswpin - prev!.pswpin) / elapsedSeconds : null,
    pswpout_rate: canRate ? (current.pswpout - prev!.pswpout) / elapsedSeconds : null,
  };
  const pgfault = optionalRate(current.pgfault, prev?.pgfault, elapsedSeconds, canRate);
  if (pgfault !== undefined) out.pgfault_rate = pgfault;
  const pgmajfault = optionalRate(current.pgmajfault, prev?.pgmajfault, elapsedSeconds, canRate);
  if (pgmajfault !== undefined) out.pgmajfault_rate = pgmajfault;
  const pgscan = optionalRate(current.pgscan, prev?.pgscan, elapsedSeconds, canRate);
  if (pgscan !== undefined) out.pgscan_rate = pgscan;
  const pgsteal = optionalRate(current.pgsteal, prev?.pgsteal, elapsedSeconds, canRate);
  if (pgsteal !== undefined) out.pgsteal_rate = pgsteal;
  return out;
}

/**
 * Collect swap-in/swap-out, page-fault, and page-scan/steal rates.
 * First-snapshot returns null rates (no prior counter to delta
 * against); subsequent calls compute deltas per second across the
 * elapsed snapshot interval.
 *
 * Counter resets (host reboot, counter rollover) are detected when a
 * swap counter goes backwards; that call is treated as a fresh baseline
 * and returns null rates. A non-positive elapsed interval returns null
 * rates WITHOUT consuming the baseline (unchanged from the original
 * swap-only implementation).
 *
 * `path` and `nowMs` are test hooks.
 */
export function collectVmstat(
  path: string = PROC_VMSTAT,
  nowMs: number = Date.now(),
): VmstatSnapshot | null {
  const current = parseVmstat(path, nowMs);
  if (!current) return null;

  const prev = previous;
  if (!prev) {
    previous = current;
    return buildSnapshot(current, null, 0, false);
  }

  const elapsedSeconds = (current.capturedAtMs - prev.capturedAtMs) / 1000;
  if (elapsedSeconds <= 0) {
    // Baseline intentionally NOT advanced (original behavior).
    return buildSnapshot(current, null, 0, false);
  }

  // A swap counter going backward = host rebooted (or the counter
  // rolled), which resets every /proc/vmstat counter. Treat this
  // snapshot as a new baseline and return null rates.
  const reset = current.pswpin - prev.pswpin < 0 || current.pswpout - prev.pswpout < 0;
  previous = current;
  if (reset) {
    return buildSnapshot(current, null, 0, false);
  }

  return buildSnapshot(current, prev, elapsedSeconds, true);
}

export const __test_only = {
  parseVmstat,
  resetForTests: () => {
    previous = null;
  },
};
