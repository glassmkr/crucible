// LVM thin pool metadata collection.
//
// LVM thin pools use a separate metadata volume from data. Metadata
// exhaustion is silent and catastrophic; writes fail in unpredictable
// ways once the metadata volume fills. Dashboard's
// lvm_thinpool_metadata_high rule pages on this.
//
// Capability gating: `lvs` binary absent (no LVM on the host) yields
// available: false; we never error on a host that simply doesn't run
// LVM.
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §1.2.

import { run } from "../lib/exec.js";

export interface LvmThinPool {
  lv_name: string;
  vg_name: string;
  data_percent: number;
  metadata_percent: number;
}

export interface LvmSnapshot {
  available: boolean;
  reason?: string;
  thin_pools: LvmThinPool[];
}

export async function collectLvm(): Promise<LvmSnapshot> {
  const out = await run("lvs", [
    "--reportformat=json",
    "--options=lv_name,vg_name,lv_attr,data_percent,metadata_percent",
    "--units=b",
    "--noheadings",
  ]);
  if (!out) {
    return {
      available: false,
      reason: "lvs not available (LVM not installed?)",
      thin_pools: [],
    };
  }

  const parsed = parseLvsJson(out);
  if (parsed === null) {
    return {
      available: false,
      reason: "lvs output did not parse",
      thin_pools: [],
    };
  }

  return { available: true, thin_pools: parsed };
}

/**
 * `lvs --reportformat=json` returns a structure like:
 *   {
 *     "report": [
 *       { "lv": [
 *           { "lv_name": "thinpool", "vg_name": "vg0",
 *             "lv_attr": "twi-aotz--", "data_percent": "45.20",
 *             "metadata_percent": "12.30" },
 *           ...
 *       ] }
 *     ]
 *   }
 *
 * lv_attr position 0 is the volume type: `t` = thin pool, `V` = thin
 * volume, `o` = origin, etc. We only care about thin pools here.
 *
 * Empty pool sets (host has LVM but no thin pools) return an empty
 * array with available: true; that's a useful signal to the
 * dashboard ("LVM here, just nothing to alert on").
 */
export function parseLvsJson(raw: string): LvmThinPool[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const report = (parsed as { report?: Array<{ lv?: unknown[] }> })?.report;
  if (!Array.isArray(report) || report.length === 0) return [];
  const lvs = report[0]?.lv;
  if (!Array.isArray(lvs)) return [];

  const pools: LvmThinPool[] = [];
  for (const entry of lvs as Array<Record<string, unknown>>) {
    const attr = typeof entry.lv_attr === "string" ? entry.lv_attr : "";
    if (attr.charAt(0) !== "t") continue; // not a thin pool
    const lvName = typeof entry.lv_name === "string" ? entry.lv_name : "";
    const vgName = typeof entry.vg_name === "string" ? entry.vg_name : "";
    const dataPct = parsePercent(entry.data_percent);
    const metaPct = parsePercent(entry.metadata_percent);
    if (!lvName || !vgName) continue;
    pools.push({
      lv_name: lvName,
      vg_name: vgName,
      data_percent: dataPct,
      metadata_percent: metaPct,
    });
  }
  return pools;
}

function parsePercent(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export const __test_only = { parseLvsJson, parsePercent };
