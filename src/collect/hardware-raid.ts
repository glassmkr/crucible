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
// a normalized HardwareRaidController. The dashboard's raid_degraded
// evaluator pages on any controller state != "Optimal"; that's the
// trigger contract.
//
// MegaRAID (storcli / perccli) parsing is fleet-tested: verified against
// a LSI 9364-8i (SATA RAID10) and a tri-mode 9560-16i (NVMe RAID1) on the
// validation fleet, 2026-09-02, including a live degraded array. Both CLIs
// emit the same JSON schema (`/... show all J`), so one parser serves both.
// The wrapper already fetches `show all` (VD LIST + PD LIST + TOPOLOGY), so
// beyond the controller state we now also extract:
//   - virtual_drives:  every array with its RAID level + state,
//   - degraded_drives: physical members in a non-healthy state, each named
//     by enclosure:slot + model, so the alert can say "slot 4:3, WDC ..."
//     instead of only "controller Needs Attention".
// The MegaRAID PD LIST carries no serial number; naming a member by serial
// needs a per-drive query and is a documented follow-up.
//
// ssacli (HPE) and arcconf (Adaptec) remain state-only best-effort: no
// validation hardware for those vendors yet, so they omit virtual_drives /
// degraded_drives rather than guess.
//
// Framework guarantees preserved:
//   - empty controllers[] on hosts without any vendor CLI (capability
//     gate; dashboard rule no-ops),
//   - empty controllers[] on hosts with the CLI but no controllers present.
//
// The dashboard's mdadm path is unaffected by this module.

import { which } from "../lib/exec.js";
import { runPrivileged } from "../lib/privileged.js";
import type {
  HardwareRaidSnapshot,
  HardwareRaidController,
  HardwareRaidVirtualDrive,
  HardwareRaidPhysicalDrive,
} from "../lib/types.js";

// PD state tokens that mean the member is healthy (online, a spare, or an
// unconfigured-but-good drive). Anything else - Offln, Failed, Rbld, Msng,
// UBad, Pdgd, SmrtFail, ... - is surfaced in degraded_drives so the alert
// can name it. Kept as an allowlist so an unfamiliar token defaults to
// "surface it" rather than silently swallowing a real fault.
const HEALTHY_PD_STATES = new Set([
  "Onln", "GHS", "DHS", "UGood", "JBOD", "Optl", "Hotspare",
]);

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function parseMegaraidVdList(vds: unknown): HardwareRaidVirtualDrive[] {
  if (!Array.isArray(vds)) return [];
  return vds.map((vd: any) => {
    const state = String(vd?.State ?? "Unknown");
    return {
      id: String(vd?.["DG/VD"] ?? "?"),
      raid_level: String(vd?.TYPE ?? "?"),
      state,
      degraded: state !== "Optl",
    };
  });
}

function parseMegaraidDegradedPds(pds: unknown): HardwareRaidPhysicalDrive[] {
  if (!Array.isArray(pds)) return [];
  const out: HardwareRaidPhysicalDrive[] = [];
  for (const pd of pds as any[]) {
    const state = String(pd?.State ?? "Unknown");
    if (HEALTHY_PD_STATES.has(state)) continue;
    const modelRaw = pd?.Model;
    out.push({
      enclosure_slot: String(pd?.["EID:Slt"] ?? "?"),
      device_id: toNumberOrNull(pd?.DID),
      state,
      drive_group: toNumberOrNull(pd?.DG),
      model: typeof modelRaw === "string" ? modelRaw.replace(/\s+/g, " ").trim() || null : null,
      size: pd?.Size != null ? String(pd.Size) : null,
      media: pd?.Med != null ? String(pd.Med) : null,
      interface: pd?.Intf != null ? String(pd.Intf) : null,
    });
  }
  return out;
}

function summarizeMegaraid(
  state: string,
  degraded: HardwareRaidPhysicalDrive[],
  vds: HardwareRaidVirtualDrive[],
): string | null {
  // Only populate raw_summary when something is wrong; a healthy controller
  // leaves it null so the snapshot stays lean.
  const degradedVds = vds.filter((v) => v.degraded);
  if (degraded.length === 0 && degradedVds.length === 0) return null;
  const parts: string[] = [`controller ${state}`];
  for (const v of degradedVds) parts.push(`VD ${v.id} ${v.raid_level} ${v.state}`);
  for (const d of degraded) {
    parts.push(`drive ${d.enclosure_slot}${d.model ? ` (${d.model})` : ""} ${d.state}`);
  }
  return parts.join("; ");
}

/**
 * Parse the JSON emitted by `storcli/perccli ... show all J`. Both CLIs share
 * this schema. Exported for unit testing against captured fleet fixtures.
 */
export function parseMegaraidJson(
  raw: string,
  vendor: "lsi" | "dell",
): HardwareRaidController[] {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Output wasn't JSON (older CLI, or controller missing).
    return [];
  }
  const ctrlList = obj?.Controllers ?? [];
  const out: HardwareRaidController[] = [];
  for (const c of ctrlList) {
    const rd = c?.["Response Data"] ?? {};
    const state = String(rd?.["Status"]?.["Controller Status"] ?? "Unknown");
    const virtual_drives = parseMegaraidVdList(rd?.["VD LIST"]);
    const degraded_drives = parseMegaraidDegradedPds(rd?.["PD LIST"]);
    const pdListPresent = Array.isArray(rd?.["PD LIST"]);
    out.push({
      vendor,
      controller_id: String(c?.["Command Status"]?.Controller ?? "0"),
      state,
      // Honest count: how many members we found in a bad state. Null only
      // when the CLI produced no PD LIST at all (nothing to count).
      degraded_disks: pdListPresent ? degraded_drives.length : null,
      raw_summary: summarizeMegaraid(state, degraded_drives, virtual_drives),
      virtual_drives,
      degraded_drives,
    });
  }
  return out;
}

async function scrapePerccli(): Promise<HardwareRaidController[]> {
  const raw = await runPrivileged("raid-perccli", [], 10000);
  if (!raw) return [];
  return parseMegaraidJson(raw, "dell");
}

async function scrapeStorcli(): Promise<HardwareRaidController[]> {
  const raw = await runPrivileged("raid-storcli", [], 10000);
  if (!raw) return [];
  return parseMegaraidJson(raw, "lsi");
}

async function scrapeSsacli(): Promise<HardwareRaidController[]> {
  // ssacli ctrl all show: text format. Conservative: extract one
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
        raw_summary: "arcconf parsing pending; surface a customer with Adaptec hardware",
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
