// /proc/vmstat collection for swap-in/swap-out rates.
//
// Per CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION_2026-05-19.md (C3).
//
// Output: per-second rates derived from cumulative counter deltas
// across snapshot intervals. The first snapshot returns null rates
// because there's no prior counter to delta against.
//
// Delta pattern matches src/collect/io-latency.ts: a module-level Map
// holds the previous cumulative counter. On each call we compute
// (current - previous) / elapsed_seconds. Stale entries (host that
// rebooted, counter went backwards) are detected and discarded.

import { readProcFile } from "../lib/parse.js";
import type { VmstatSnapshot } from "../lib/types.js";

interface VmstatCounters {
  pswpin: number;
  pswpout: number;
  capturedAtMs: number;
}

let previous: VmstatCounters | null = null;

function parseVmstat(): VmstatCounters | null {
  const raw = readProcFile("/proc/vmstat");
  if (!raw) return null;
  let pswpin: number | undefined;
  let pswpout: number | undefined;
  for (const line of raw.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k === "pswpin") pswpin = Number(v);
    else if (k === "pswpout") pswpout = Number(v);
    if (pswpin !== undefined && pswpout !== undefined) break;
  }
  if (pswpin === undefined || pswpout === undefined) return null;
  return { pswpin, pswpout, capturedAtMs: Date.now() };
}

/**
 * Collect swap-in/swap-out rates. First-snapshot returns null rates
 * (no prior counter to delta against); subsequent calls compute
 * deltas per second across the elapsed snapshot interval.
 *
 * Counter resets (host reboot, /proc/vmstat counter rollover) are
 * detected when current < previous; in that case we treat the
 * current call as a fresh baseline and return null rates.
 */
export function collectVmstat(): VmstatSnapshot | null {
  const current = parseVmstat();
  if (!current) return null;

  if (!previous) {
    previous = current;
    return {
      pswpin_total: current.pswpin,
      pswpout_total: current.pswpout,
      pswpin_rate: null,
      pswpout_rate: null,
    };
  }

  const elapsedSeconds = (current.capturedAtMs - previous.capturedAtMs) / 1000;
  if (elapsedSeconds <= 0) {
    return {
      pswpin_total: current.pswpin,
      pswpout_total: current.pswpout,
      pswpin_rate: null,
      pswpout_rate: null,
    };
  }

  const inDelta = current.pswpin - previous.pswpin;
  const outDelta = current.pswpout - previous.pswpout;
  // Counter went backward = host rebooted (or the counter rolled). Treat
  // this snapshot as a new baseline and return null rates.
  if (inDelta < 0 || outDelta < 0) {
    previous = current;
    return {
      pswpin_total: current.pswpin,
      pswpout_total: current.pswpout,
      pswpin_rate: null,
      pswpout_rate: null,
    };
  }

  const inRate = inDelta / elapsedSeconds;
  const outRate = outDelta / elapsedSeconds;
  previous = current;

  return {
    pswpin_total: current.pswpin,
    pswpout_total: current.pswpout,
    pswpin_rate: inRate,
    pswpout_rate: outRate,
  };
}

export const __test_only = {
  parseVmstat,
  resetForTests: () => {
    previous = null;
  },
};
