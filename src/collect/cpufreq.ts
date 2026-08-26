// sysfs cpufreq collection: per-CPU scaling frequency + governor.
// collectd parity close (cpufreq plugin), 2026-08-24.
//
// Files read, per /sys/devices/system/cpu/cpuN/cpufreq/:
//   scaling_cur_freq   current frequency in kHz (world-readable; we
//                      NEVER read cpuinfo_cur_freq, which is root-only
//                      and would silently fail under the unprivileged
//                      service user)
//   scaling_min_freq / scaling_max_freq   governor bounds in kHz
//   scaling_governor   active governor name
//
// Capability-style: hosts without cpufreq (most VMs, kernels without
// the subsystem) have no cpufreq dirs, so the collector returns null
// and the snapshot field is absent. Absent means not-supported, never
// zero. A CPU without its own cpufreq dir is skipped (it answered
// nothing); an individual unreadable file yields null for that field
// only.

import { join } from "node:path";
import { readDirSafe, readFileInt, readFileTrim } from "../lib/parse.js";
import type { CpufreqCpu, CpufreqSnapshot } from "../lib/types.js";

const CPU_ROOT = "/sys/devices/system/cpu";

/**
 * Collect per-CPU scaling frequencies plus a min/max/mean summary of
 * the current frequency across CPUs. Returns null when no CPU exposes
 * a cpufreq directory. `root` is a test hook (fixture dir).
 */
export function collectCpufreq(root: string = CPU_ROOT): CpufreqSnapshot | null {
  const cpuDirs = readDirSafe(root)
    .map((name) => {
      const m = name.match(/^cpu(\d+)$/);
      return m ? { name, ordinal: parseInt(m[1], 10) } : null;
    })
    .filter((e): e is { name: string; ordinal: number } => e !== null)
    .sort((a, b) => a.ordinal - b.ordinal);

  const cpus: CpufreqCpu[] = [];
  for (const { name, ordinal } of cpuDirs) {
    const freqDir = join(root, name, "cpufreq");
    // A CPU without a cpufreq dir answered nothing: skip the row rather
    // than emit all-nulls (readDirSafe returns [] on a missing dir).
    if (readDirSafe(freqDir).length === 0) continue;
    cpus.push({
      cpu: ordinal,
      cur_khz: readFileInt(join(freqDir, "scaling_cur_freq")),
      min_khz: readFileInt(join(freqDir, "scaling_min_freq")),
      max_khz: readFileInt(join(freqDir, "scaling_max_freq")),
      governor: readFileTrim(join(freqDir, "scaling_governor")) || null,
    });
  }

  if (cpus.length === 0) return null;

  const curValues = cpus
    .map((c) => c.cur_khz)
    .filter((v): v is number => v !== null);

  return {
    cpus,
    cur_khz_min: curValues.length > 0 ? Math.min(...curValues) : null,
    cur_khz_max: curValues.length > 0 ? Math.max(...curValues) : null,
    cur_khz_mean:
      curValues.length > 0
        ? Math.round(curValues.reduce((a, b) => a + b, 0) / curValues.length)
        : null,
  };
}
