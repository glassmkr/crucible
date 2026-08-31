import { readProcFile } from "../lib/parse.js";
import type { RaidInfo, RaidSyncAction } from "../lib/types.js";

export async function collectRaid(path: string = "/proc/mdstat"): Promise<RaidInfo[]> {
  const raw = readProcFile(path);
  if (!raw) return [];

  const results: RaidInfo[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(md\d+)\s*:\s*(\w+)\s+(\w+)\s+(.*)/);
    if (!match) continue;

    const device = match[1];
    const status = match[2]; // "active" or "inactive"
    const level = match[3]; // "raid1", "raid5", etc.
    const disksPart = match[4];

    // Parse components WITH their RAID role index and faulty flag, e.g.
    // "sdb2[1](F) sda2[0]". CRITICAL: mdstat lists members in an arbitrary
    // order, but the [U_] bitmap on the next line is ordered by ROLE index
    // (the [N] after each device), NOT by listing order. Mapping the bitmap by
    // listing order misidentifies the failed member and can name the SURVIVING
    // disk, which is data-loss-grade (a user pulls the good drive). So resolve
    // each bitmap position through the role index. (Grok red-team, 2026-08-30.)
    const components = (disksPart.match(/(\w+)\[(\d+)\](\(F\))?/g) || []).map((tok) => {
      const m = tok.match(/(\w+)\[(\d+)\](\(F\))?/)!;
      return { name: m[1], role: Number(m[2]), faulty: Boolean(m[3]) };
    });
    const disks = components.map((c) => c.name); // listing order, for display
    const roleToName = new Map(components.map((c) => [c.role, c.name]));

    // Check next line for degraded status (e.g., "[UU_]" means one drive missing)
    const statusLine = lines[i + 1] || "";
    const bracketMatch = statusLine.match(/\[([U_]+)\]/);
    const degraded =
      (bracketMatch ? bracketMatch[1].includes("_") : false) ||
      components.some((c) => c.faulty);

    const failedDisks: string[] = [];
    if (bracketMatch) {
      // Bitmap position idx == RAID role idx. Name the member at that role; a
      // removed member has no listing entry, so it cannot be named (but the
      // array is still correctly reported degraded).
      bracketMatch[1].split("").forEach((c, idx) => {
        if (c === "_") {
          const name = roleToName.get(idx);
          if (name && !failedDisks.includes(name)) failedDisks.push(name);
        }
      });
    }
    // A member explicitly flagged faulty (F) is failed even if the bitmap has
    // not yet flipped its slot; union it in.
    for (const comp of components) {
      if (comp.faulty && !failedDisks.includes(comp.name)) failedDisks.push(comp.name);
    }

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
      if (line.trim() === "" || /^md\d+\s*:/.test(line)) break;
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
