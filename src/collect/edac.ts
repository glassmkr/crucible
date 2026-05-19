// EDAC (Error Detection and Correction) counter collection.
//
// Per CC_SPEC_FORGE_FOLLOWUP_C1_C6_ACTIVATION_2026-05-19.md (C1).
//
// Kernel surface: /sys/devices/system/edac/mc/mcN/{ce_count,ue_count}
//   ce_count  = correctable errors (memory controller saw and fixed)
//   ue_count  = uncorrectable errors (memory error couldn't be fixed;
//               kernel may have killed the process or panicked)
//
// Per-DIMM granularity: /sys/devices/system/edac/mc/mcN/dimmM/
//   dimm_ce_count, dimm_ue_count, dimm_label, dimm_location, size
//
// Capability gate: if no `mcN` directories exist under
// /sys/devices/system/edac/mc/, EDAC is not loaded (no memory
// controller driver compiled in or no DIMMs reporting) and this
// collector returns null. The dashboard ecc_errors evaluator falls
// back to its IPMI-SEL path.
//
// On hosts where EDAC is loaded but counters stay at zero, this
// collector emits zero counters — that's the correct baseline.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EdacSnapshot, EdacDimm } from "../lib/types.js";

const EDAC_ROOT = "/sys/devices/system/edac/mc";

function readUint(path: string): number | null {
  try {
    const s = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(s)) return null;
    return parseInt(s, 10);
  } catch {
    return null;
  }
}

function readString(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function listMcDirs(): string[] {
  try {
    return readdirSync(EDAC_ROOT)
      .filter((n) => /^mc\d+$/.test(n))
      .map((n) => join(EDAC_ROOT, n));
  } catch {
    return [];
  }
}

function listDimmDirs(mcPath: string): string[] {
  try {
    return readdirSync(mcPath)
      .filter((n) => /^dimm\d+$/.test(n) || /^rank\d+$/.test(n))
      .map((n) => join(mcPath, n));
  } catch {
    return [];
  }
}

function collectDimm(dimmPath: string): EdacDimm | null {
  const ce = readUint(join(dimmPath, "dimm_ce_count"));
  const ue = readUint(join(dimmPath, "dimm_ue_count"));
  if (ce === null && ue === null) return null;
  const label = readString(join(dimmPath, "dimm_label"));
  const location = readString(join(dimmPath, "dimm_location"));
  const sizeStr = readString(join(dimmPath, "size"));
  const sizeMb = sizeStr && /^\d+$/.test(sizeStr) ? parseInt(sizeStr, 10) : null;
  return {
    label: label ?? "",
    location: location ?? "",
    size_mb: sizeMb,
    ce_count: ce ?? 0,
    ue_count: ue ?? 0,
  };
}

export function collectEdac(): EdacSnapshot | null {
  const mcDirs = listMcDirs();
  if (mcDirs.length === 0) return null;

  let totalCe = 0;
  let totalUe = 0;
  const dimms: EdacDimm[] = [];

  for (const mc of mcDirs) {
    const ce = readUint(join(mc, "ce_count")) ?? 0;
    const ue = readUint(join(mc, "ue_count")) ?? 0;
    totalCe += ce;
    totalUe += ue;
    for (const dimm of listDimmDirs(mc)) {
      const d = collectDimm(dimm);
      if (d) dimms.push(d);
    }
  }

  return {
    edac_corrected_total: totalCe,
    edac_uncorrected_total: totalUe,
    dimms,
  };
}
