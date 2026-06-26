import { readProcFile, parseKb } from "../lib/parse.js";
import type { MemoryInfo } from "../lib/types.js";

export async function collectMemory(): Promise<MemoryInfo> {
  const raw = readProcFile("/proc/meminfo") || "";
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

  return {
    total_mb: totalMb,
    used_mb: usedMb,
    available_mb: availableMb,
    free_mb: freeMb,
    swap_total_mb: swapTotalMb,
    swap_used_mb: swapUsedMb,
  };
}
