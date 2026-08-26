import { readProcFile, parseKb } from "../lib/parse.js";
import type { MemoryInfo } from "../lib/types.js";

// Parse a plain non-negative integer /proc/meminfo value (the HugePages_*
// count shape, no kB suffix). Null when the line is absent or malformed,
// so answered-no stays distinguishable from did-not-answer per field.
function parseCount(val: string | undefined): number | null {
  if (val === undefined) return null;
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

// Parse a "<n> kB" /proc/meminfo value strictly: null (not 0) when the
// line is absent or malformed. parseKb's 0-on-garbage default is fine
// for the legacy MB fields but would fabricate a 0 kB hugepage size.
function parseKbStrict(val: string | undefined): number | null {
  if (val === undefined) return null;
  const m = val.trim().match(/^(\d+)\s*kB$/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Pure /proc/meminfo parser; collectMemory feeds it the real file.
 *  Exported for tests. */
export function parseMeminfo(raw: string): MemoryInfo {
  const kv: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s+(.+)/);
    if (match) kv[match[1]] = match[2];
  }

  const totalKb = parseKb(kv["MemTotal"]);
  const availableKb = parseKb(kv["MemAvailable"]);
  const freeKb = parseKb(kv["MemFree"]);
  const swapTotalKb = parseKb(kv["SwapTotal"]);
  const swapFreeKb = parseKb(kv["SwapFree"]);

  const totalMb = Math.round(totalKb / 1024);
  const availableMb = Math.round(availableKb / 1024);
  const freeMb = Math.round(freeKb / 1024);
  const usedMb = totalMb - availableMb;
  const swapTotalMb = Math.round(swapTotalKb / 1024);
  const swapUsedMb = Math.round((swapTotalKb - swapFreeKb) / 1024);

  const info: MemoryInfo = {
    total_mb: totalMb,
    used_mb: usedMb,
    available_mb: availableMb,
    free_mb: freeMb,
    swap_total_mb: swapTotalMb,
    swap_used_mb: swapUsedMb,
  };

  // Hugepage pool (collectd hugepages parity close, 2026-08-24).
  // Emitted only when a pool is configured (HugePages_Total > 0) to keep
  // snapshots lean; an absent field means no pool, never zero. The
  // HugePages_* lines are plain page counts; Hugepagesize carries a kB
  // suffix (null when the line is absent or malformed).
  const hugepagesTotal = parseCount(kv["HugePages_Total"]);
  if (hugepagesTotal !== null && hugepagesTotal > 0) {
    info.hugepages = {
      total: hugepagesTotal,
      free: parseCount(kv["HugePages_Free"]),
      reserved: parseCount(kv["HugePages_Rsvd"]),
      page_size_kb: parseKbStrict(kv["Hugepagesize"]),
    };
  }

  return info;
}

export async function collectMemory(): Promise<MemoryInfo> {
  return parseMeminfo(readProcFile("/proc/meminfo") || "");
}
