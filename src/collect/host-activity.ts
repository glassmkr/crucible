// /proc/stat host-activity collection: context-switch and fork rates
// plus the running/blocked process counts. collectd parity close
// (contextswitch + processes plugins, partial), 2026-08-24.
//
// Lines read (all unprivileged, present since ancient kernels):
//   ctxt N           cumulative context switches since boot
//   processes N      cumulative forks since boot
//   procs_running N  currently runnable processes (point in time)
//   procs_blocked N  processes blocked on I/O (point in time; a
//                    disk-trouble signal)
//
// ctxt/processes are cumulative counters turned into per-second rates
// via RateTracker (first cycle and counter resets yield null, never 0).
// procs_running/procs_blocked are instantaneous values passed through.
//
// Degrade-safe: an unreadable /proc/stat returns null (field omitted
// from the snapshot); an individual missing or malformed line yields
// null for that field only, so answered-no and did-not-answer stay
// distinguishable per field.

import { readProcFile } from "../lib/parse.js";
import { RateTracker } from "../lib/rate.js";
import type { HostActivitySnapshot } from "../lib/types.js";

const PROC_STAT = "/proc/stat";

const rates = new RateTracker();

// Parse "key N" from a /proc/stat line; null when the value is missing,
// non-numeric, or negative (all bogus for these fields).
function parseCount(line: string): number | null {
  const value = line.trim().split(/\s+/)[1];
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Collect context-switch/fork rates and running/blocked process counts
 * from /proc/stat. Returns null when the file is unreadable or contains
 * none of the four lines. `path` and `nowMs` are test hooks.
 */
export function collectHostActivity(
  path: string = PROC_STAT,
  nowMs: number = Date.now(),
): HostActivitySnapshot | null {
  const raw = readProcFile(path);
  if (!raw) return null;

  let ctxt: number | null = null;
  let processes: number | null = null;
  let procsRunning: number | null = null;
  let procsBlocked: number | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("ctxt ")) ctxt = parseCount(line);
    else if (line.startsWith("processes ")) processes = parseCount(line);
    else if (line.startsWith("procs_running ")) procsRunning = parseCount(line);
    else if (line.startsWith("procs_blocked ")) procsBlocked = parseCount(line);
  }

  if (ctxt === null && processes === null && procsRunning === null && procsBlocked === null) {
    // The file exists but answered nothing we track; omit the field.
    return null;
  }

  return {
    context_switches_total: ctxt,
    context_switches_rate: ctxt !== null ? rates.computeRate("ctxt", ctxt, nowMs) : null,
    forks_total: processes,
    forks_rate: processes !== null ? rates.computeRate("processes", processes, nowMs) : null,
    procs_running: procsRunning,
    procs_blocked: procsBlocked,
  };
}

export const __test_only = {
  parseCount,
  resetForTests: () => {
    rates.reset();
  },
};
