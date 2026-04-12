import { readProcFile } from "../lib/parse.js";

export interface ConntrackData {
  available: boolean;
  count: number;
  max: number;
  percent: number;
}

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
  return { available: true, count, max, percent };
}
