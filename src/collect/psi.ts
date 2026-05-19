// PSI (Pressure Stall Information) collection.
//
// Reads /proc/pressure/{cpu,memory,io}. The kernel exposes this on
// 4.20+ when PSI is compiled in (most modern distros). Older kernels
// or those built without `CONFIG_PSI=y` return an empty result; the
// snapshot then omits the `psi` field entirely, and the dashboard
// alert evaluator's capability gates treat that as `available: false`.
//
// Per CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION_2026-05-19.md (C2).
//
// File format (all three resources share the same shape):
//
//   some avg10=0.06 avg60=0.04 avg300=0.05 total=12345
//   full avg10=0.00 avg60=0.00 avg300=0.00 total=678
//
// "some" = % of time at least one task was stalled on the resource.
// "full" = % of time ALL non-idle tasks were stalled (only present
//          for memory and io; cpu has only "some" per kernel docs).
// "total" = cumulative microseconds since boot.

import { readProcFile } from "../lib/parse.js";
import type { PsiResource, PsiSnapshot } from "../lib/types.js";

function parsePsiLine(line: string): PsiResource | null {
  // Expect: "some avg10=N avg60=N avg300=N total=N"
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const out: Partial<PsiResource> = {};
  for (const part of parts.slice(1)) {
    const [k, v] = part.split("=");
    if (k === "avg10") out.avg10 = parseFloat(v);
    else if (k === "avg60") out.avg60 = parseFloat(v);
    else if (k === "avg300") out.avg300 = parseFloat(v);
    else if (k === "total") out.total = parseInt(v, 10);
  }
  if (
    out.avg10 === undefined ||
    out.avg60 === undefined ||
    out.avg300 === undefined ||
    out.total === undefined
  ) {
    return null;
  }
  return out as PsiResource;
}

interface PsiFile {
  some: PsiResource;
  /** Only present for memory + io; cpu has no "full" line in current kernels. */
  full?: PsiResource;
}

function parsePsiFile(contents: string): PsiFile | null {
  let some: PsiResource | null = null;
  let full: PsiResource | null = null;
  for (const line of contents.split("\n")) {
    if (line.startsWith("some ")) some = parsePsiLine(line);
    else if (line.startsWith("full ")) full = parsePsiLine(line);
  }
  if (!some) return null;
  return full ? { some, full } : { some };
}

/**
 * Collect PSI for all three resources. Returns null if /proc/pressure/
 * is unavailable (older kernel or PSI disabled). Per resource: returns
 * undefined if that specific file is unreadable (rare; usually all
 * three present or none).
 */
export function collectPsi(): PsiSnapshot | null {
  const cpu = readProcFile("/proc/pressure/cpu");
  const memory = readProcFile("/proc/pressure/memory");
  const io = readProcFile("/proc/pressure/io");
  if (!cpu && !memory && !io) return null;

  const out: PsiSnapshot = {};
  if (cpu) {
    const parsed = parsePsiFile(cpu);
    if (parsed) out.cpu = parsed;
  }
  if (memory) {
    const parsed = parsePsiFile(memory);
    if (parsed) out.memory = parsed;
  }
  if (io) {
    const parsed = parsePsiFile(io);
    if (parsed) out.io = parsed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const __test_only = { parsePsiLine, parsePsiFile };
