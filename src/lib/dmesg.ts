// Shared dmesg read + kernel-log timestamp parsing.
//
// Both the dmesg-events collector (C18) and the gpu collector's XID
// scan read the kernel ring buffer the same way: try `--time-format=iso`
// (kernel 5.10+) first, fall back to plain `--no-pager` when that call
// produces nothing (older kernels ignore the flag; missing privileges
// is the more common cause). They also parse the leading timestamp the
// same way. This module hosts the shared read + parse so the two
// collectors don't drift.

import { run } from "./exec.js";

export interface ReadDmesgOptions {
  /** Per-call timeout passed to `run`. dmesg-events uses run's default
   *  (10s); the gpu collector uses its 5s nvidia-smi budget. */
  timeoutMs?: number;
  /** Extra args appended to the FIRST (iso) attempt only. dmesg-events
   *  passes `--ctime`; the gpu collector passes nothing. Kept verbatim
   *  so each call site's argv is preserved exactly. */
  extraIsoArgs?: string[];
}

/**
 * Read the kernel ring buffer. Returns the raw dmesg text, or null when
 * dmesg is missing / not readable (CAP_SYSLOG absent or
 * kernel.dmesg_restrict=1).
 *
 * Two-step, preserving the historical behavior of both callers:
 *   1. `dmesg --time-format=iso --no-pager [extraIsoArgs...]`
 *   2. on a null/empty result, `dmesg --no-pager`
 */
export async function readDmesg(opts: ReadDmesgOptions = {}): Promise<string | null> {
  const { timeoutMs, extraIsoArgs = [] } = opts;
  const isoArgs = ["--time-format=iso", "--no-pager", ...extraIsoArgs];
  const first =
    timeoutMs === undefined
      ? await run("dmesg", isoArgs)
      : await run("dmesg", isoArgs, timeoutMs);
  if (first) return first;
  return timeoutMs === undefined
    ? await run("dmesg", ["--no-pager"])
    : await run("dmesg", ["--no-pager"], timeoutMs);
}

/**
 * Extract a unix-ms timestamp from a dmesg line. Two absolute shapes:
 *   ISO:   "2026-05-19T12:34:56,789012+00:00 ..."  (--time-format=iso)
 *   ctime: "[Mon May 19 12:34:56 2026] ..."        (--ctime)
 *
 * Relative-time format ("[12345.678]") returns null (no absolute anchor
 * available without uptime). The comma fractional separator that iso
 * format emits is normalised to a dot before Date.parse.
 */
export function parseKernelLogTimestamp(line: string): number | null {
  const isoMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[,.]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)/,
  );
  if (isoMatch) {
    // Normalise the comma fractional separator to dot.
    const iso = isoMatch[1].replace(",", ".");
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }
  const ctimeMatch = line.match(
    /^\[([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\]/,
  );
  if (ctimeMatch) {
    const t = Date.parse(ctimeMatch[1]);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
