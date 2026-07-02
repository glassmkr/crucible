// Reboot-evidence collection: pstore + kdump + wtmp.
//
// Per CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION_2026-05-19.md (C4).
//
// Three independent signals corroborate a reboot:
//
//   - /sys/fs/pstore/    — persistent storage records the kernel
//     wrote during the previous shutdown / panic. Presence of
//     dmesg-* records indicates the prior kernel left a forensic
//     trail before halting.
//
//   - /var/crash/        — kdump's vmcore dump from the prior
//     kernel panic. Path varies by distro; check the standard
//     location plus the systemd default.
//
//   - wtmp                — accounting log. `last reboot -F` shows
//     `reboot system boot ...` events plus optional `shutdown`
//     events that preceded them. A clean shutdown (poweroff/halt)
//     produces a `shutdown` record; a hard reset or power loss
//     leaves only the boot record with no prior shutdown.
//
// The dashboard's unexpected_reboot rule consumes this to enrich
// the alert's evidence; the kernel_panic_detected rule (C4
// follow-up) consumes pstore_present + vmcore_present to fire its
// own P0 alert.

import { existsSync, readdirSync, statSync } from "node:fs";
import { runPrivileged } from "../lib/privileged.js";
import { readDirSafe } from "../lib/parse.js";
import type { RebootEvidence } from "../lib/types.js";

const PSTORE_PATH = "/sys/fs/pstore";
const VAR_CRASH_PATH = "/var/crash";

function pstoreRecords(): string[] {
  return readDirSafe(PSTORE_PATH).filter(
    (n) => n.startsWith("dmesg-") || n.startsWith("console-") || n.startsWith("ftrace-"),
  );
}

function vmcorePresent(): boolean {
  try {
    if (!existsSync(VAR_CRASH_PATH)) return false;
    // /var/crash typically contains dated subdirectories per crash
    // (e.g. /var/crash/2026-05-13-04:22:54/vmcore). Recursive check
    // would be expensive; we just check if any subdirectory contains
    // a file named `vmcore` or `vmcore.flat`.
    const top = readdirSync(VAR_CRASH_PATH);
    for (const sub of top) {
      try {
        const subPath = `${VAR_CRASH_PATH}/${sub}`;
        const st = statSync(subPath);
        if (!st.isDirectory()) continue;
        const children = readdirSync(subPath);
        if (children.some((c) => c === "vmcore" || c === "vmcore.flat" || c.startsWith("vmcore."))) {
          return true;
        }
      } catch {
        // Skip unreadable subdirs.
      }
    }
    return false;
  } catch {
    return false;
  }
}

interface WtmpRebootRecord {
  /** Last `reboot` line, e.g. "reboot system boot 5.15.0 Wed May 13 05:21:17 2026 still running". */
  last_reboot_raw: string | null;
  /** True if the wtmp log shows a `shutdown` record immediately before
   *  the most recent reboot; false if only the reboot is present
   *  (suggests power loss or hard reset). */
  prior_shutdown_clean: boolean;
}

/**
 * Parse `last -x -F` output into the reboot record. Pure; exported for tests.
 *
 * The `-x` flag is essential: it surfaces the `shutdown` and `runlevel` system
 * pseudo-records. Plain `last reboot` / `last shutdown` do NOT show the
 * shutdown record on modern systemd + util-linux (verified on Ubuntu, 6.17
 * kernels): `last shutdown` returns nothing even after a clean `sudo reboot`,
 * which made prior_shutdown_clean false on EVERY clean reboot and escalated
 * deliberate reboots to a critical "unclean-shutdown" alert (false positive).
 *
 * Output is most-recent-first. We keep only the `reboot`/`shutdown` system
 * lines so interleaved `runlevel` and user-login records do not break
 * adjacency. The most recent boot was clean iff a `shutdown` record sits
 * immediately before it (the next system record). No shutdown before the boot
 * means a hard reset / power loss / panic.
 */
export function parseWtmp(output: string): WtmpRebootRecord {
  const sysLines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("reboot") || l.startsWith("shutdown"));
  const lastReboot = sysLines[0]?.startsWith("reboot") ? sysLines[0] : null;
  const prior_shutdown_clean =
    sysLines[0]?.startsWith("reboot") === true &&
    sysLines[1]?.startsWith("shutdown") === true;
  return { last_reboot_raw: lastReboot, prior_shutdown_clean };
}

async function readWtmp(): Promise<WtmpRebootRecord> {
  const output = await runPrivileged("last", [], 5000);
  if (!output) {
    return { last_reboot_raw: null, prior_shutdown_clean: false };
  }
  return parseWtmp(output);
}

export async function collectRebootEvidence(): Promise<RebootEvidence> {
  const records = pstoreRecords();
  const vmcore = vmcorePresent();
  const wtmp = await readWtmp();
  return {
    pstore_present: records.length > 0,
    pstore_record_count: records.length,
    vmcore_present: vmcore,
    wtmp_reboot_record: wtmp.last_reboot_raw,
    prior_shutdown_clean: wtmp.prior_shutdown_clean,
  };
}
