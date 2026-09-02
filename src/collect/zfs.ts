import { which } from "../lib/exec.js";
import { runPrivileged } from "../lib/privileged.js";
import type { ZfsData, ZfsPool, ZfsVdev } from "../lib/types.js";

export async function collectZfs(): Promise<ZfsData | null> {
  // Check if zpool is installed
  if (!(await which("zpool", 3000))) return null;

  const zpoolStatus = await runPrivileged("zpool", [], 10000);
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

// Refine a bare "mirror" into mirror_2way / mirror_3way / mirror_4way+ from
// the counted child devices (H-D4g). The dashboard severity matrix keys on
// these: a degraded 2-way mirror has zero remaining fault tolerance
// (critical), while a 3-way+ still has budget (warning). Called after the
// children are counted. Leaves the class bare "mirror" only when the child
// count is unknown (0/1, i.e. a malformed or truncated status block), so the
// dashboard can still fall back to treating "mirror" as 2-way.
function refineMirrorRedundancyClass(vdev: ZfsVdev): void {
  if (vdev.redundancy_class !== "mirror") return;
  if (vdev.child_count === 2) vdev.redundancy_class = "mirror_2way";
  else if (vdev.child_count === 3) vdev.redundancy_class = "mirror_3way";
  else if (vdev.child_count >= 4) vdev.redundancy_class = "mirror_4way+";
}

export function parseZpoolStatus(zpoolStatus: string): ZfsPool[] {
  const pools: ZfsPool[] = [];
  let current: ZfsPool | null = null;
  let section: ZfsSection = "none";
  // Per-pool bookkeeping: did we see a genuine SCRUB signal for the
  // current pool (a `scrub ...` scan line, or the explicit "none
  // requested")? A `resilvered` scan line is deliberately NOT counted:
  // a resilver (disk replace, or an offline+online recovery) is not a
  // scrub, so it must not clear the never-scrubbed signal (H-D4h). Kept
  // out of the serialized ZfsPool object so it doesn't leak into the
  // snapshot.
  let sawScrubSignal = false;

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
      sawScrubSignal = false;
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
      // Fresh-pool case: ZFS 2.2+ omits the `scan:` line entirely until
      // the first scrub is initiated. Reaching `errors:` without ever
      // seeing a real scrub signal means this pool has never been
      // scrubbed. This also (correctly) holds after a resilver-only
      // scan line, which does not count as a scrub (H-D4h). The
      // `errors:` line is the canonical end-of-pool marker, so this is a
      // stable place to assert.
      if (!sawScrubSignal && current.scrub_never_run === undefined) {
        current.scrub_never_run = true;
      }
      continue;
    }

    // Parse scrub info. A `scan:` line may say "none requested" (the
    // explicit never-run signal), report a scrub, report a RESILVER, or
    // be absent entirely on a freshly-created pool (ZFS 2.2+ omits the
    // line until a scan is initiated). Only a genuine SCRUB (or the
    // explicit "none requested") establishes scrub history: a
    // `resilvered ...` line is a rebuild after a disk replace / an
    // offline+online recovery, NOT a scrub, so it must not set
    // last_scrub_date and must not clear the never-scrubbed signal
    // (H-D4h - an offline+online cycle was silently "healing" the
    // never-scrubbed warning on a pool that had still never been
    // scrubbed). The fresh-pool case is handled at the `errors:` marker.
    if (line.includes("scan:")) {
      if (line.includes("none requested")) {
        sawScrubSignal = true;
        current.scrub_never_run = true;
      } else if (/\bscrub\b/.test(line) && !line.includes("canceled")) {
        // A completed / in-progress / paused scrub establishes scrub history. A
        // CANCELED scrub does NOT (Codex round 1 #1): it never finished verifying
        // the pool, so it must not set last_scrub_date and must not suppress the
        // never-scrubbed signal - a pool whose only scrub was canceled has still
        // never been fully scrubbed, so it falls through to scrub_never_run at
        // the `errors:` marker below.
        sawScrubSignal = true;
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
      // A resilver (or any other non-scrub scan line) is intentionally
      // ignored here for scrub-history purposes.
    }

    // Section switching. `config:` opens the vdev tree. Section
    // markers `logs`, `cache`, `spares` appear inside the config
    // block. The exact whitespace varies by ZFS version: pre-2.0
    // emitted them unindented; ZFS 2.2 emits a leading TAB and a
    // trailing TAB (verified live on val-mz62hd 2026-05-21:
    // "\tlogs\t\n"). The older parser only matched the unindented
    // form, which routed every SLOG vdev into the wrong field on
    // modern hosts. Match either form.
    if (line.startsWith("config:")) {
      section = "config";
      continue;
    }
    if (/^\s*logs\s*$/.test(line)) {
      section = "logs";
      continue;
    }
    if (/^\s*cache\s*$/.test(line)) {
      section = "cache";
      continue;
    }
    if (/^\s*spares\s*$/.test(line)) {
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
          child_count: 0,
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
        if (lastVdev) {
          lastVdev.child_count += 1;
          if (childState !== "ONLINE") lastVdev.degraded_disks_count += 1;
        }
      }
    }
  }

  // Now that every vdev's children are counted, promote bare "mirror"
  // vdevs to their N-way class. Only config vdevs are ever classified as
  // "mirror" (slog/cache default to "stripe"), so this is a no-op elsewhere.
  for (const pool of pools) {
    for (const vdev of pool.vdevs) refineMirrorRedundancyClass(vdev);
  }

  return pools;
}
