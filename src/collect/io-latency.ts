import { readProcFile } from "../lib/parse.js";

export interface IoLatencyInfo {
  device: string;
  avg_read_latency_ms: number | null;
  avg_write_latency_ms: number | null;
  /** Completed read operations over the collection INTERVAL: a count, not a
   *  per-second rate, despite the historical "iops" name. The dashboard
   *  disk_latency_high saturation gate compares this against a per-interval
   *  threshold, so both sides scale with the interval and the "busy vs sick"
   *  classification is interval-robust. (A true per-second variant was tried in
   *  0.14.2 and reverted in 0.14.3: dividing here while the dashboard bar stayed
   *  a fixed rate reopened the Docker-on-loopback saturation false positive.)
   *  0 on the first cycle. */
  read_iops: number;
  /** Completed write operations over the collection interval (see read_iops). */
  write_iops: number;
}

interface DiskstatsCounters {
  reads_completed: number;
  read_time_ms: number;
  writes_completed: number;
  write_time_ms: number;
}

// Previous cumulative counters for delta computation
const previousCounters = new Map<string, DiskstatsCounters>();

// Match physical block devices, not partitions or virtual devices
function isPhysicalDevice(name: string): boolean {
  // sd*, vd*, xvd* without trailing partition number
  if (/^(sd|vd|xvd)[a-z]+$/.test(name)) return true;
  // nvme*n* without partition suffix (nvme0n1 yes, nvme0n1p1 no)
  if (/^nvme\d+n\d+$/.test(name)) return true;
  // md* (RAID arrays)
  if (/^md\d+$/.test(name)) return true;
  return false;
}

function parseDiskstats(): Record<string, DiskstatsCounters> {
  const raw = readProcFile("/proc/diskstats") || "";
  const result: Record<string, DiskstatsCounters> = {};

  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    const name = parts[2];
    if (!isPhysicalDevice(name)) continue;

    result[name] = {
      reads_completed: Number(parts[3]) || 0,
      read_time_ms: Number(parts[6]) || 0,
      writes_completed: Number(parts[7]) || 0,
      write_time_ms: Number(parts[10]) || 0,
    };
  }

  return result;
}

function delta(current: number, previous: number): number {
  if (current >= previous) return current - previous;
  return current; // counter wrapped or reset
}

export function collectIoLatency(): IoLatencyInfo[] {
  const current = parseDiskstats();
  const results: IoLatencyInfo[] = [];
  const currentDevices = new Set<string>();

  for (const [name, counters] of Object.entries(current)) {
    currentDevices.add(name);
    const prev = previousCounters.get(name);

    // Store current for next cycle
    previousCounters.set(name, { ...counters });

    if (!prev) {
      // First cycle: no delta, report null latency.
      results.push({
        device: name,
        avg_read_latency_ms: null,
        avg_write_latency_ms: null,
        read_iops: 0,
        write_iops: 0,
      });
      continue;
    }

    const deltaReads = delta(counters.reads_completed, prev.reads_completed);
    const deltaReadTime = delta(counters.read_time_ms, prev.read_time_ms);
    const deltaWrites = delta(counters.writes_completed, prev.writes_completed);
    const deltaWriteTime = delta(counters.write_time_ms, prev.write_time_ms);

    results.push({
      device: name,
      // Average latency is per-operation (time delta / op delta).
      avg_read_latency_ms: deltaReads > 0 ? Math.round((deltaReadTime / deltaReads) * 100) / 100 : null,
      avg_write_latency_ms: deltaWrites > 0 ? Math.round((deltaWriteTime / deltaWrites) * 100) / 100 : null,
      // Operation COUNT over the interval (see IoLatencyInfo.read_iops), paired
      // with the dashboard's per-interval saturation threshold.
      read_iops: deltaReads,
      write_iops: deltaWrites,
    });
  }

  // Remove stale devices
  for (const name of previousCounters.keys()) {
    if (!currentDevices.has(name)) previousCounters.delete(name);
  }

  return results;
}
