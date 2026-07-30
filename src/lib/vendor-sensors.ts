// Vendor-aware classifiers for IPMI sensor names.
//
// The substring filters in alert rules historically assumed Supermicro /
// ASRockRack naming conventions (`PSU1 Status`, `CPU1 Temp`, etc.). Dell
// iDRAC names sensors very differently: `PS1 Status`, `PS Redundancy`,
// bare `Temp` per processor entity. HPE iLO is closer to Supermicro's
// shape but has its own quirks. Adding a new vendor means adding a case
// here, not editing every rule.

import type { Vendor } from "./types.js";

/**
 * True if `name` looks like an individual PSU sensor (status / wattage / etc.)
 * for the given vendor.
 *
 * Generic patterns cover Supermicro / HPE / ASRockRack / Gigabyte / Dell
 * across the validation fleet:
 *   "PSU1 Status"      (ASRockRack X570D4U)
 *   "Power Supply 1"   (HPE iLO)
 *   "PSU2 Power Out"   (Supermicro extended)
 *   "PS1 Status"       (Supermicro H12SST, space separator)
 *   "PS1_Status"       (Gigabyte MC12-LE0, MZ62-HD0, R292-4S1, underscore separator)
 *   "PS1 Status"       (Dell iDRAC PowerEdge family)
 *
 * Previously this filter only matched the "psu" or "power supply"
 * substrings plus a Dell-gated `/^ps\d+\b/` pattern. That left every
 * Supermicro/Gigabyte BMC that uses the `PS<N>` shape outside the
 * filter, so the per-PSU rule path never even reached them.
 * glassmkr#29 component.
 *
 * `PS Redundancy` (aggregate sensor) is excluded; see
 * `isPsuRedundancySensor`.
 */
export function isPsuSensor(name: string, _vendor: Vendor): boolean {
  const lower = name.toLowerCase();
  if (lower.includes("psu") || lower.includes("power supply")) return true;
  // Generic `PS<digit>` with optional space/underscore separator and
  // suffix. Anchored to start so we don't accidentally swallow names
  // like "PS Redundancy" (no digit) or "SOMETHING-PS1" (mid-string).
  if (/^ps\d+[\s_]?/i.test(name)) return true;
  return false;
}

/**
 * True if `name` is the aggregate PSU redundancy state sensor.
 * Currently only Dell exposes this as a discrete sensor reading;
 * HPE/Supermicro report it via SEL events instead.
 */
export function isPsuRedundancySensor(name: string, vendor: Vendor): boolean {
  if (vendor === "dell") {
    return /^ps\s+redundancy$/i.test(name);
  }
  return false;
}

/**
 * Map the value/status text of a Dell `PS Redundancy` sensor to a canonical
 * state. Dell reports strings like "Fully Redundant", "Redundancy Lost",
 * "Redundancy Degraded", or "0x01"-style raw codes depending on iDRAC firmware.
 */
export function classifyPsuRedundancyState(valueOrStatus: string): "fully_redundant" | "redundancy_lost" | "redundancy_degraded" | "unknown" {
  const lower = valueOrStatus.toLowerCase();
  if (lower.includes("fully redundant") || lower.includes("fully-redundant")) return "fully_redundant";
  if (lower.includes("lost")) return "redundancy_lost";
  if (lower.includes("degraded")) return "redundancy_degraded";
  // Some iDRAC firmwares report "ok" + numeric value 1 = fully redundant
  if (lower === "ok") return "fully_redundant";
  return "unknown";
}

/**
 * Per-PSU sensor classification from the discrete-state bitmask reported
 * by `ipmitool sensor` for sensor type 0x08 (Power Supply). The Reading
 * column carries a hex value whose bits are defined by IPMI 2.0 spec
 * table 42-3:
 *
 *   bit 0 (0x01): Presence detected
 *   bit 1 (0x02): Power Supply Failure detected
 *   bit 2 (0x04): Predictive Failure
 *   bit 3 (0x08): Power Supply input lost (AC/DC)
 *   bit 4 (0x10): Power Supply input lost or out-of-range
 *   bit 5 (0x20): Power Supply input out-of-range, but present
 *   bit 6 (0x40): Configuration error
 *   bit 7 (0x80): Power Supply Inactive (standby; not delivering power)
 *
 * `mask` is the discrete-state assertion mask Crucible reads from the 4th
 * column of `ipmitool sensor` for discrete sensors: which bits this BMC's
 * firmware can assert. When the mask doesn't include the Presence bit, a
 * Reading of 0x0 is ambiguous (PSU healthy with no events, OR PSU absent).
 * In that case we under-report (return `ok`) rather than over-report.
 * glassmkr#29.
 *
 * `vendor` is currently advisory: bit meanings are IPMI-standard across
 * the bare-metal vendors we've observed on the validation fleet
 * (Supermicro, Gigabyte, ASRockRack); the BMC-to-BMC variation is in the
 * mask, not the bit semantics. Kept as a parameter for future per-vendor
 * escape hatches.
 */
export type PsuSensorState =
  | "ok"            // no failure bits asserted; presence bit set when reported
  | "failed"        // bit 1 asserted: Power Supply Failure detected
  | "ac_lost"       // bit 3/4/5 asserted: input lost or out-of-range
  | "predictive"    // bit 2 asserted: predictive failure
  | "absent"        // BMC's mask includes bit 0 but Reading lacks it
  | "inactive"      // bit 7 asserted: PSU in standby
  | "unknown";      // value/mask unparseable

export function classifyPsuSensorBitmask(
  valueHex: string,
  mask: string | undefined,
  _vendor: Vendor,
): PsuSensorState {
  const v = valueHex.trim().toLowerCase().replace(/^0x/, "");
  if (!v || v === "na") return "unknown";
  const value = parseInt(v, 16);
  if (Number.isNaN(value)) return "unknown";

  const m = mask?.trim().toLowerCase().replace(/^0x/, "");
  const maskNum = m && m !== "na" ? parseInt(m, 16) : NaN;

  // Failure bits take precedence: a BMC that asserts both Presence (bit 0)
  // AND Failure (bit 1) still has a failed PSU.
  if (value & 0x02) return "failed";
  if (value & 0x08) return "ac_lost";
  if (value & 0x10) return "ac_lost";
  if (value & 0x20) return "ac_lost";
  if (value & 0x04) return "predictive";

  // Standby/inactive: in a redundant pair the inactive PSU may be the
  // backup. Report as `inactive` and let the caller decide. Only
  // meaningful if the BMC says it can report bit 7.
  if (!Number.isNaN(maskNum) && (maskNum & 0x80) && (value & 0x80)) return "inactive";

  // Presence: only meaningful when the BMC reports it can assert bit 0.
  // If the mask doesn't include bit 0, Reading=0x0 is ambiguous, and
  // returning `ok` is the under-report safe default.
  if (!Number.isNaN(maskNum) && (maskNum & 0x01)) {
    if (!(value & 0x01)) return "absent";
  }

  return "ok";
}
