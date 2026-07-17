import { readProcFile } from "../lib/parse.js";

export interface IoLatencyInfo {
  device: string;
  avg_read_latency_ms: number | null;
  avg_write_latency_ms: number | null;
  /** Completed read operations per SECOND over the interval (a rate, not the
   *  raw interval count). 0 on the first cycle. See collectIoLatency. */
  read_iops: number;
  /** Completed write operations per SECOND over the interval. 0 on first cycle. */
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

// Wall-clock (ms) of the previous capture, to convert counter deltas into a
// per-second rate. All devices are read in one synchronous pass, so a single
// timestamp is correct for the whole cycle. null until the first cycle done.
let lastCaptureMs: number | null = null;

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
  const nowMs = Date.now();
  // Seconds since the previous capture. IOPS are a per-second RATE, so the raw
  // counter delta must be divided by elapsed time: reporting the bare delta
  // overstated IOPS by roughly the interval length (~300x at the 300s default)
  // and made the value interval-dependent. null on the first cycle or a bad
  // clock delta. (Codex review 2026-07-17.)
  const elapsedSec = lastCaptureMs != null ? (nowMs - lastCaptureMs) / 1000 : null;
  const haveRate = elapsedSec != null && elapsedSec > 0;
  const results: IoLatencyInfo[] = [];
  const currentDevices = new Set<string>();

  for (const [name, counters] of Object.entries(current)) {
    currentDevices.add(name);
    const prev = previousCounters.get(name);

    // Store current for next cycle
    previousCounters.set(name, { ...counters });

    if (!prev || !haveRate) {
      // First cycle for this device (or no usable elapsed time): no delta yet.
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
      // Average latency is per-operation (time delta / op delta), so it is
      // already interval-independent and needs no elapsed-time division.
      avg_read_latency_ms: deltaReads > 0 ? Math.round((deltaReadTime / deltaReads) * 100) / 100 : null,
      avg_write_latency_ms: deltaWrites > 0 ? Math.round((deltaWriteTime / deltaWrites) * 100) / 100 : null,
      read_iops: Math.round((deltaReads / elapsedSec!) * 10) / 10,
      write_iops: Math.round((deltaWrites / elapsedSec!) * 10) / 10,
    });
  }

  // Remove stale devices
  for (const name of previousCounters.keys()) {
    if (!currentDevices.has(name)) previousCounters.delete(name);
  }

  lastCaptureMs = nowMs;
  return results;
}
