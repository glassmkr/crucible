// Hardware RAID controller scraping.
//
// Per CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION_2026-05-19.md (C5).
//
// Detects four vendor CLIs:
//   - perccli  (Dell PERC)
//   - ssacli   (HPE Smart Array)
//   - storcli  (LSI / Broadcom MegaRAID)
//   - arcconf  (Adaptec)
//
// For each installed CLI, queries the controller state and returns
// a normalized HardwareRaidController. The vendor-specific output
// formats vary considerably; this module's parsers are intentionally
// conservative — they extract a state string ("Optimal", "Degraded",
// etc.) plus an optional degraded_disks counter when the vendor output
// makes it easy to find. The dashboard's raid_degraded evaluator pages
// on any state != "Optimal"; that's the contract.
//
// Implementation scope (2026-05-19): perccli + storcli parsers are
// best-effort because the validation fleet has no hardware RAID
// controllers to verify against. Real parsing precision lands in
// follow-up PRs as customers with each vendor surface. The framework
// here ensures:
//   - empty controllers[] on hosts without any vendor CLI (capability
//     gate; dashboard rule no-ops),
//   - empty controllers[] on hosts with the CLI but no controllers
//     present (rare configurations).
//
// The dashboard's mdadm path is unaffected by this module.

import { which } from "../lib/exec.js";
import { runPrivileged } from "../lib/privileged.js";
import type { HardwareRaidSnapshot, HardwareRaidController } from "../lib/types.js";

async function scrapePerccli(): Promise<HardwareRaidController[]> {
  // perccli /c0 show all J — JSON output for controller 0.
  // Multi-controller hosts are rare; query c0 only and let follow-ups
  // expand if a customer surfaces multi-controller hardware.
  const raw = await runPrivileged("raid-perccli", [], 10000);
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    const ctrlList = obj?.Controllers ?? [];
    return ctrlList.map((c: any) => ({
      vendor: "dell" as const,
      controller_id: String(c?.["Command Status"]?.Controller ?? "0"),
      state: String(c?.["Response Data"]?.["Status"]?.["Controller Status"] ?? "Unknown"),
      degraded_disks: null,
      raw_summary: null,
    }));
  } catch {
    // Output wasn't JSON (older perccli, or controller missing).
    return [];
  }
}

async function scrapeStorcli(): Promise<HardwareRaidController[]> {
  const raw = await runPrivileged("raid-storcli", [], 10000);
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    const ctrlList = obj?.Controllers ?? [];
    return ctrlList.map((c: any) => ({
      vendor: "lsi" as const,
      controller_id: String(c?.["Command Status"]?.Controller ?? "?"),
      state: String(c?.["Response Data"]?.["Status"]?.["Controller Status"] ?? "Unknown"),
      degraded_disks: null,
      raw_summary: null,
    }));
  } catch {
    return [];
  }
}

async function scrapeSsacli(): Promise<HardwareRaidController[]> {
  // ssacli ctrl all show — text format. Conservative: extract one
  // line per "in slot X" entry; status reported on a "Controller Status"
  // line. Real parsing lands when an HPE customer surfaces.
  const raw = await runPrivileged("raid-ssacli", [], 10000);
  if (!raw) return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const controllers: HardwareRaidController[] = [];
  let pending: { slot: string; status: string } | null = null;
  for (const line of lines) {
    const slotMatch = line.match(/in Slot (\S+)/);
    if (slotMatch) {
      if (pending) controllers.push(pendingToController(pending));
      pending = { slot: slotMatch[1], status: "Unknown" };
      continue;
    }
    const statusMatch = line.match(/Controller Status:\s*(.+)/);
    if (statusMatch && pending) pending.status = statusMatch[1].trim();
  }
  if (pending) controllers.push(pendingToController(pending));
  return controllers;
}

function pendingToController(p: { slot: string; status: string }): HardwareRaidController {
  return {
    vendor: "hpe",
    controller_id: p.slot,
    state: p.status,
    degraded_disks: null,
    raw_summary: null,
  };
}

async function scrapeArcconf(): Promise<HardwareRaidController[]> {
  // arcconf has no JSON mode. Best-effort: detect controllers via
  // `arcconf list` and surface a placeholder state. Real parser
  // for Adaptec lands when a customer surfaces.
  const raw = await runPrivileged("raid-arcconf", [], 10000);
  if (!raw) return [];
  const controllers: HardwareRaidController[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/Controller (\d+):/i);
    if (m) {
      controllers.push({
        vendor: "adaptec",
        controller_id: m[1],
        state: "Unknown",
        degraded_disks: null,
        raw_summary: "arcconf parsing pending — surface a customer with Adaptec hardware",
      });
    }
  }
  return controllers;
}

export async function collectHardwareRaid(): Promise<HardwareRaidSnapshot | null> {
  const hasPerccli = await which("perccli");
  const hasStorcli = await which("storcli");
  const hasSsacli = await which("ssacli");
  const hasArcconf = await which("arcconf");

  if (!hasPerccli && !hasStorcli && !hasSsacli && !hasArcconf) return null;

  const controllers: HardwareRaidController[] = [];
  if (hasPerccli) controllers.push(...(await scrapePerccli()));
  if (hasStorcli) controllers.push(...(await scrapeStorcli()));
  if (hasSsacli) controllers.push(...(await scrapeSsacli()));
  if (hasArcconf) controllers.push(...(await scrapeArcconf()));

  return { controllers };
}
