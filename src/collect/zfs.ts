import { run } from "../lib/exec.js";
import type { ZfsData, ZfsPool, ZfsVdev } from "../lib/types.js";

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

// Section markers in `zpool status` config output. Top-level vdevs
// appear under `config:`; logs under `logs`; cache under `cache`; spares
// under `spares`. The parser tracks the current section to route each
// vdev line into the right bucket on the pool object.
type ZfsSection = "config" | "logs" | "cache" | "spares" | "none";

function classifyVdevType(vdevName: string): ZfsVdev["redundancy_class"] {
  if (vdevName.startsWith("mirror")) return "mirror";
  if (vdevName.startsWith("raidz3")) return "raidz3";
  if (vdevName.startsWith("raidz2")) return "raidz2";
  if (vdevName.startsWith("raidz1")) return "raidz1";
  if (vdevName.startsWith("raidz")) return "raidz1"; // bare "raidz" alias
  if (vdevName.startsWith("dRAID")) return "draid";
  // Anything else at the top level is a single-device "stripe" vdev:
  // no redundancy. The pattern library treats stripe failure as P0
  // because there's nothing left to recover from.
  return "stripe";
}

export function parseZpoolStatus(zpoolStatus: string): ZfsPool[] {
  const pools: ZfsPool[] = [];
  let current: ZfsPool | null = null;
  let section: ZfsSection = "none";

  for (const line of zpoolStatus.split("\n")) {
    const poolMatch = line.match(/^\s*pool:\s*(.+)/);
    if (poolMatch) {
      current = {
        name: poolMatch[1].trim(),
        state: "UNKNOWN",
        errors_text: "",
        vdevs: [],
        slog_vdevs: [],
        l2arc_vdevs: [],
      };
      pools.push(current);
      section = "none";
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

    // Section switching. `config:` opens the vdev tree; `logs`,
    // `cache`, `spares` appear as bare lines (no colon, no leading
    // tab) within the config block as section markers per zpool(8).
    if (line.startsWith("config:")) {
      section = "config";
      continue;
    }
    // Section headers in the config block ('logs', 'cache', 'spares')
    // appear unindented (no tab prefix) per the `zpool status` format.
    if (/^logs\s*$/.test(line)) {
      section = "logs";
      continue;
    }
    if (/^cache\s*$/.test(line)) {
      section = "cache";
      continue;
    }
    if (/^spares\s*$/.test(line)) {
      section = "spares";
      continue;
    }

    // Top-level vdev lines start with a tab + 2 spaces of indentation
    // (per zpool's format). Child disks within a vdev have deeper
    // indentation. We only care about top-level vdevs here; child
    // device counts feed degraded_disks_count.
    if (section === "config" || section === "logs" || section === "cache") {
      const topVdevMatch = line.match(/^\t {2}(\S+)\s+(\S+)/);
      if (topVdevMatch) {
        const name = topVdevMatch[1];
        const state = topVdevMatch[2];
        // Skip the pool-name line itself (matches the same indent
        // pattern as a vdev line). The pool name was already captured
        // from the `pool:` line above; ignore the duplicate row here.
        if (name === current.name) continue;
        const vdev: ZfsVdev = {
          name,
          state,
          redundancy_class: section === "config" ? classifyVdevType(name) : "stripe",
          degraded_disks_count: 0,
        };
        if (section === "config") current.vdevs.push(vdev);
        else if (section === "logs") current.slog_vdevs.push(vdev);
        else if (section === "cache") current.l2arc_vdevs.push(vdev);
        continue;
      }
      // Child device under the previously-pushed vdev. Increment its
      // degraded counter if the child's state isn't ONLINE.
      const childMatch = line.match(/^\t {4,}(\S+)\s+(\S+)/);
      if (childMatch) {
        const childState = childMatch[2];
        const lastVdev = (() => {
          if (section === "config" && current.vdevs.length > 0) {
            return current.vdevs[current.vdevs.length - 1];
          }
          if (section === "logs" && current.slog_vdevs.length > 0) {
            return current.slog_vdevs[current.slog_vdevs.length - 1];
          }
          if (section === "cache" && current.l2arc_vdevs.length > 0) {
            return current.l2arc_vdevs[current.l2arc_vdevs.length - 1];
          }
          return null;
        })();
        if (lastVdev && childState !== "ONLINE") {
          lastVdev.degraded_disks_count += 1;
        }
      }
    }
  }

  return pools;
}
