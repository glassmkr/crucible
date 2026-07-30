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
// collector emits zero counters; that's the correct baseline.

import { join } from "node:path";
import { readDirSafe, readFileInt, readFileTrim } from "../lib/parse.js";
import type { EdacSnapshot, EdacDimm } from "../lib/types.js";

const EDAC_ROOT = "/sys/devices/system/edac/mc";

function listMcDirs(): string[] {
  return readDirSafe(EDAC_ROOT)
    .filter((n) => /^mc\d+$/.test(n))
    .map((n) => join(EDAC_ROOT, n));
}

function listDimmDirs(mcPath: string): string[] {
  return readDirSafe(mcPath)
    .filter((n) => /^dimm\d+$/.test(n) || /^rank\d+$/.test(n))
    .map((n) => join(mcPath, n));
}

function collectDimm(dimmPath: string): EdacDimm | null {
  const ce = readFileInt(join(dimmPath, "dimm_ce_count"));
  const ue = readFileInt(join(dimmPath, "dimm_ue_count"));
  if (ce === null && ue === null) return null;
  const label = readFileTrim(join(dimmPath, "dimm_label"));
  const location = readFileTrim(join(dimmPath, "dimm_location"));
  const sizeStr = readFileTrim(join(dimmPath, "size"));
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
    const ce = readFileInt(join(mc, "ce_count")) ?? 0;
    const ue = readFileInt(join(mc, "ue_count")) ?? 0;
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
