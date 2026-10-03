import { run } from "../lib/exec.js";
import { readProcFile } from "../lib/parse.js";
import { runPrivileged } from "../lib/privileged.js";
import { readdirSync, readFileSync } from "fs";
import type { OsAlerts } from "../lib/types.js";

// The dmesg-errcrit action's window: `dmesg --since "5 min ago"`.
const OOM_WINDOW_SECONDS = 300;

export async function collectOsAlerts(): Promise<OsAlerts> {
  // OOM kills
  let oomKills = 0;
  const dmesg = await runPrivileged("dmesg-errcrit");
  if (dmesg) {
    const uptime = parseFloat((readProcFile("/proc/uptime") ?? "").split(/\s+/)[0]);
    oomKills = countRecentOomKills(dmesg, Number.isFinite(uptime) ? uptime : null);
  }

  // Zombie processes
  let zombies = 0;
  try {
    const pids = readdirSync("/proc").filter((f) => /^\d+$/.test(f));
    for (const pid of pids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        // Field 3 is the state character
        const state = stat.split(" ")[2];
        if (state === "Z") zombies++;
      } catch { /* process disappeared */ }
    }
  } catch { /* /proc not readable */ }

  // Time drift (simple: check if chrony/ntp reports drift)
  let timeDriftMs = 0;
  const chrony = await run("chronyc", ["tracking"]);
  if (chrony) {
    const match = chrony.match(/System time\s*:\s*([\d.]+)\s*seconds\s*(slow|fast)/);
    if (match) {
      timeDriftMs = parseFloat(match[1]) * 1000;
    }
  }

  return {
    oom_kills_recent: oomKills,
    zombie_processes: zombies,
    time_drift_ms: Math.round(timeDriftMs * 100) / 100,
  };
}

/**
 * Count "Out of memory" reports in the dmesg-errcrit action's output. Every
 * counted line must carry a stamp that places it in the window:
 *   - a -T wall-clock stamp: the util-linux >= 2.35 read, already limited to
 *     err,crit and the last 5 minutes by dmesg; counted as before;
 *   - a raw "[seconds since boot]" stamp: a fallback read spanning the whole
 *     boot; counted only when stamped within OOM_WINDOW_SECONDS of
 *     `uptimeSeconds`;
 *   - a "<N>" priority (busybox `dmesg -r`): kept only for level err or crit
 *     (N & 7 is 3 or 2, any facility, as --level=err,crit matches), then
 *     windowed by its raw stamp as above.
 * A line with no stamp (printk.time=0) cannot be placed in time and is not
 * counted, nor is any fallback line when uptime is unknown: counting the whole
 * boot would raise an old OOM kill on every snapshot. The field is a required
 * number in the snapshot and the dashboard's oom_kills rule fires on > 0, so
 * those cases report 0, which is what these hosts reported before the
 * fallback existed.
 */
export function countRecentOomKills(output: string, uptimeSeconds: number | null): number {
  let count = 0;
  for (let line of output.split("\n")) {
    const prio = line.match(/^<(\d+)>/);
    if (prio) {
      const level = Number(prio[1]) & 7;
      if (level !== 2 && level !== 3) continue;
      line = line.slice(prio[0].length);
    }
    const raw = line.match(/^\[\s*(\d+(?:\.\d+)?)\]/);
    if (raw) {
      if (uptimeSeconds === null || parseFloat(raw[1]) < uptimeSeconds - OOM_WINDOW_SECONDS) continue;
    } else if (prio || !line.startsWith("[")) {
      continue;
    }
    count += (line.match(/Out of memory/gi) || []).length;
  }
  return count;
}
