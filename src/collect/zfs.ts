import { run } from "../lib/exec.js";
import type { ZfsData, ZfsPool } from "../lib/types.js";

export async function collectZfs(): Promise<ZfsData | null> {
  // Check if zpool is installed
  const zpoolPath = await run("which", ["zpool"], 3000);
  if (!zpoolPath || !zpoolPath.trim()) return null;

  const zpoolStatus = await run("zpool", ["status"], 10000);
  if (!zpoolStatus || !zpoolStatus.trim()) return null;

  const pools = parseZpoolStatus(zpoolStatus);
  if (pools.length === 0) return null;
  return { pools };
}

export function parseZpoolStatus(zpoolStatus: string): ZfsPool[] {
  const pools: ZfsPool[] = [];
  let current: ZfsPool | null = null;

  for (const line of zpoolStatus.split("\n")) {
    const poolMatch = line.match(/^\s*pool:\s*(.+)/);
    if (poolMatch) {
      current = {
        name: poolMatch[1].trim(),
        state: "UNKNOWN",
        errors_text: "",
      };
      pools.push(current);
      continue;
    }

    if (!current) continue;

    const stateMatch = line.match(/^\s*state:\s*(.+)/);
    if (stateMatch) {
      current.state = stateMatch[1].trim();
      continue;
    }

    const errorsMatch = line.match(/^\s*errors:\s*(.+)/);
    if (errorsMatch) {
      current.errors_text = errorsMatch[1].trim();
      continue;
    }

    // Parse scrub info
    if (line.includes("scan:")) {
      if (line.includes("none requested")) {
        current.scrub_never_run = true;
      } else {
        const repairMatch = line.match(/scrub repaired (\S+) in .* with (\d+) errors/);
        if (repairMatch) {
          current.scrub_repaired = repairMatch[1];
          current.scrub_errors = parseInt(repairMatch[2]) || 0;
        }
        const dateMatch = line.match(/on (.+)$/);
        if (dateMatch) {
          current.last_scrub_date = dateMatch[1].trim();
        }
      }
    }
  }

  return pools;
}
