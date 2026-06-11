import { run } from "../lib/exec.js";
import { readdirSync, readFileSync } from "fs";
import type { OsAlerts } from "../lib/types.js";

export async function collectOsAlerts(): Promise<OsAlerts> {
  // OOM kills
  let oomKills = 0;
  const dmesg = await run("dmesg", ["--level=err,crit", "--since", "5 min ago"]);
  if (dmesg) {
    oomKills = (dmesg.match(/Out of memory/gi) || []).length;
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
