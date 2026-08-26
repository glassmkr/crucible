// Host-wide PCIe AER (Advanced Error Reporting) counters from sysfs.
// collectd parity close (pcie_errors plugin, host-wide slice), 2026-08-24.
//
// Files read, per /sys/bus/pci/devices/<addr>/:
//   aer_dev_correctable   correctable error counts (link retrains etc.)
//   aer_dev_nonfatal      uncorrectable-nonfatal error counts
//   aer_dev_fatal         uncorrectable-fatal error counts
//
// The files are world-readable and exist only on devices whose port has
// AER enabled. Two on-disk formats exist and both are handled:
//   - labeled per-class lines ending in a TOTAL_ERR_COUNT row (the
//     documented sysfs-bus-pci-devices-aer_stats ABI, kernel 5.1+):
//       RxErr 0
//       BadTLP 2
//       ...
//       TOTAL_ERR_COUNT 2
//   - a bare number (older/backport shapes)
// We take TOTAL_ERR_COUNT when present, a bare integer otherwise, and
// fall back to summing labeled lines if a total row is missing.
//
// Capability-style: when NO device exposes any aer_dev_* file the
// collector returns null and the snapshot field is absent. Absent means
// AER-not-enabled, never zero errors. Per device, a missing or
// unparsable file yields null for that class only.

import { join } from "node:path";
import { readDirSafe, readFileTrim } from "../lib/parse.js";
import type { PcieAerDevice, PcieAerSnapshot } from "../lib/types.js";

const PCI_ROOT = "/sys/bus/pci/devices";

// Parse one aer_dev_* file's contents into a total error count; null
// when the contents fit neither known format.
function parseAerTotal(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Bare-number format.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : null;
  }

  // Labeled-lines format: prefer the kernel's own TOTAL_ERR_COUNT row.
  let labeledSum: number | null = null;
  for (const line of trimmed.split("\n")) {
    const m = line.trim().match(/^(\S+)\s+(\d+)$/);
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isSafeInteger(value)) continue;
    if (m[1] === "TOTAL_ERR_COUNT") return value;
    labeledSum = (labeledSum ?? 0) + value;
  }
  // No total row (defensive): sum of the per-class lines we could read.
  return labeledSum;
}

/**
 * Collect host-wide PCIe AER error totals: per-device entries for
 * devices with any nonzero count, plus fleet-friendly summary totals
 * across every reporting device. Returns null when no device exposes
 * the aer_dev_* files. `root` is a test hook.
 */
export function collectPcieAer(root: string = PCI_ROOT): PcieAerSnapshot | null {
  const addresses = readDirSafe(root).sort();
  if (addresses.length === 0) return null;

  const nonzeroDevices: PcieAerDevice[] = [];
  let devicesReporting = 0;
  let correctableTotal = 0;
  let nonfatalTotal = 0;
  let fatalTotal = 0;

  for (const addr of addresses) {
    const devDir = join(root, addr);
    const rawCorrectable = readFileTrim(join(devDir, "aer_dev_correctable"));
    const rawNonfatal = readFileTrim(join(devDir, "aer_dev_nonfatal"));
    const rawFatal = readFileTrim(join(devDir, "aer_dev_fatal"));

    // A device with none of the three files does not report AER: skip it
    // entirely (it answered nothing).
    if (rawCorrectable === null && rawNonfatal === null && rawFatal === null) continue;
    devicesReporting++;

    const correctable = rawCorrectable !== null ? parseAerTotal(rawCorrectable) : null;
    const nonfatal = rawNonfatal !== null ? parseAerTotal(rawNonfatal) : null;
    const fatal = rawFatal !== null ? parseAerTotal(rawFatal) : null;

    correctableTotal += correctable ?? 0;
    nonfatalTotal += nonfatal ?? 0;
    fatalTotal += fatal ?? 0;

    if ((correctable ?? 0) > 0 || (nonfatal ?? 0) > 0 || (fatal ?? 0) > 0) {
      nonzeroDevices.push({ device: addr, correctable, nonfatal, fatal });
    }
  }

  if (devicesReporting === 0) return null;

  return {
    devices: nonzeroDevices,
    devices_reporting: devicesReporting,
    correctable_total: correctableTotal,
    nonfatal_total: nonfatalTotal,
    fatal_total: fatalTotal,
  };
}

export const __test_only = { parseAerTotal };
