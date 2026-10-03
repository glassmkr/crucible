import { readProcFile } from "../lib/parse.js";
import type { RaidInfo, RaidSyncAction } from "../lib/types.js";

// An array line: "md0 : active raid1 ...", "md0 : active (auto-read-only)
// raid1 ...", "md9 : broken raid0 ..." (a raid0/linear member is gone), or
// "md2 : inactive sdb1[1](S) ..." (no personality printed). Named arrays
// read "md_<name>".
const ARRAY_LINE_RE = /^(md[A-Za-z0-9_]+)\s*:\s*(active|inactive|broken)\b(.*)$/;
const NEXT_ARRAY_RE = /^md[A-Za-z0-9_]+\s*:/;
// A member: name (sdb1, nvme0n1p3, dm-0), descriptor number, then any
// flags in kernel order, e.g. "nvme1n1p3[1](W)(F)" or "sdi1[2](S)".
const MEMBER_RE = /(?:^|\s)([A-Za-z0-9][A-Za-z0-9._-]*)\[(\d+)\]((?:\([A-Z]\))*)(?=\s|$)/g;

export async function collectRaid(path: string = "/proc/mdstat"): Promise<RaidInfo[]> {
  const raw = readProcFile(path);
  if (!raw) return [];

  const results: RaidInfo[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ARRAY_LINE_RE);
    if (!match) continue;

    const device = match[1];
    const status = match[2]; // "active", "inactive" or "broken"
    // "(read-only)" / "(auto-read-only)" sits between the state and the
    // personality; an inactive array prints no personality at all.
    const rest = match[3].replace(/^\s*\((?:auto-)?read-only\)/, "");
    const levelToken = rest.trim().split(/\s+/)[0] ?? "";
    let level = levelToken && !levelToken.includes("[") ? levelToken : "unknown";
    // An Intel IMSM / DDF metadata container is always inactive; its volumes
    // are the real arrays ("super external:/md127/0").
    if (status === "inactive" && /\bsuper\s+external:(?:imsm|ddf)\b/.test(lines[i + 1] || "")) {
      level = "container";
    }

    // Members with their flags, e.g. "sdb2[1](F) sda2[0]". The [N] is the
    // member's DESCRIPTOR number, not its slot in the [U_] map: a disk added
    // as a replacement keeps a new number (sdc1[2] in a 2-disk raid1), and an
    // unflagged member sitting in a '_' slot is the rebuild target, a healthy
    // disk. Mapping '_' positions through [N] named that disk as failed (and
    // after a replacement could name any member), so a member is failed only
    // when the kernel flags it (F), which it prints for every faulty member
    // still attached, after (W)/(J) when present. A member that has already
    // left the array is not listed and stays unnamed; the array is still
    // reported degraded from its '_' slot. (Supersedes the 2026-08-30
    // role-index mapping, which assumed [N] was the slot.)
    const members = [...rest.matchAll(MEMBER_RE)].map((m) => ({
      name: m[1],
      faulty: m[3].includes("(F)"),
    }));
    const disks = members.map((c) => c.name); // listing order, for display
    const failedDisks = members.filter((c) => c.faulty).map((c) => c.name);

    // Check next line for degraded status (e.g., "[UU_]" means one drive
    // missing). "broken" is how the kernel marks a raid0/linear array whose
    // member is gone; those personalities print no [U_] map at all.
    const statusLine = lines[i + 1] || "";
    const bracketMatch = statusLine.match(/\[([U_]+)\]/);
    const degraded =
      (bracketMatch ? bracketMatch[1].includes("_") : false) ||
      failedDisks.length > 0 ||
      status === "broken";

    const entry: RaidInfo = { device, level, status, degraded, disks, failed_disks: failedDisks };

    // In-progress sync operation (collectd mdevents parity close,
    // 2026-08-24). The progress line belongs to this array's block, so
    // scan its continuation lines until a blank line or the next mdN
    // device line. Only the bracketed in-progress form is captured
    // ("[==>....]  resync = 12.6% (...) finish=76.2min speed=186496K/sec");
    // "resync=DELAYED"/"resync=PENDING" queue markers are not a running
    // operation. Field absent when no operation is running; a malformed
    // piece of a matched line yields null for that piece only.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || NEXT_ARRAY_RE.test(line)) break;
      const opMatch = line.match(/\[[=>.]*\]\s+(resync|recovery|check|reshape)\s*=/);
      if (!opMatch) continue;
      const percentMatch = line.match(/=\s*([\d.]+)%/);
      const finishMatch = line.match(/finish=([\d.]+)min/);
      const speedMatch = line.match(/speed=(\d+)K\/sec/);
      const percent = percentMatch ? parseFloat(percentMatch[1]) : NaN;
      const finish = finishMatch ? parseFloat(finishMatch[1]) : NaN;
      entry.sync_action = {
        operation: opMatch[1] as RaidSyncAction["operation"],
        percent: Number.isFinite(percent) ? percent : null,
        finish_min: Number.isFinite(finish) ? finish : null,
        speed_kb_s: speedMatch ? parseInt(speedMatch[1], 10) : null,
      };
      break;
    }

    results.push(entry);
  }

  return results;
}
