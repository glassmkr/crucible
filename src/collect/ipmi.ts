import { run } from "../lib/exec.js";
import type { BmcVendor, IpmiInfo, SelEvent, FanStatus, Vendor, PsuRedundancyState, IpmiCapability } from "../lib/types.js";

/**
 * C11 (2026-05-19): map DMI vendor to BMC vendor + parser quality tier.
 *
 * Fleet-tested: dell, hpe, supermicro (years of fleet validation; SEL
 *   classifier confirmed against real-host event streams).
 * Stub: lenovo, cisco, openbmc (parser ships but unvalidated against
 *   real fleet data; first real customer per vendor surfaces gaps).
 * Unknown: everything else (asrockrack, inspur, generic, virtual, ...);
 *   classifier still runs (it's keyword-driven, vendor-agnostic) but
 *   we tag the events honestly.
 */
function mapVendorToBmcVendor(vendor: Vendor): BmcVendor {
  if (vendor === "dell" || vendor === "hpe" || vendor === "supermicro") return vendor;
  if (vendor === "lenovo" || vendor === "cisco") return vendor;
  // OpenBMC isn't a DMI vendor; it would surface as "generic" with a
  // BMC manufacturer of "OpenBMC Project" in ipmitool mc info. We'd
  // need to probe that to identify; deferred to a follow-up.
  return "unknown";
}

function parserQualityFor(bmcVendor: BmcVendor): "fleet-tested" | "stub" | "unknown" {
  if (bmcVendor === "dell" || bmcVendor === "hpe" || bmcVendor === "supermicro") {
    return "fleet-tested";
  }
  if (bmcVendor === "lenovo" || bmcVendor === "cisco" || bmcVendor === "openbmc") {
    return "stub";
  }
  return "unknown";
}
import { isPsuRedundancySensor, classifyPsuRedundancyState } from "../lib/vendor-sensors.js";
import { filterRedundantCpuDtsSensors } from "../lib/ipmi-sensor-filter.js";

/**
 * Collect IPMI snapshot.
 *
 * @param vendor      Vendor from DMI; controls vendor-aware sensor classification.
 * @param capability  Optional cached startup-time IPMI capability. When passed
 *                    and `available: false`, returns emptyIpmi without spawning
 *                    any ipmitool processes. When omitted, behaves as before
 *                    (per-cycle ENOENT on no-BMC hosts; supported for tests
 *                    and back-compat).
 */
export async function collectIpmi(vendor: Vendor = "generic", capability?: IpmiCapability): Promise<IpmiInfo> {
  if (capability && !capability.available) {
    // No probe possible — distinguish "we couldn't ask" from "BMC said
    // zero". Dashboard schema accepts both shapes; dashboard renders null
    // as "no signal" not "0 errors observed". glassmkr#29.
    return {
      available: false,
      sensors: [],
      ecc_errors: null,
      sel_entries_count: null,
      sel_events_recent: [],
      fans: [],
      detection: capability,
    };
  }

  const sensorRaw = await run("ipmitool", ["sensor"]);
  if (!sensorRaw) {
    return {
      available: false, sensors: [],
      ecc_errors: null,
      sel_entries_count: null,
      sel_events_recent: [],
      fans: [],
      detection: capability,
    };
  }

  // Parse sensor readings
  let sensors: IpmiInfo["sensors"] = [];
  for (const line of sensorRaw.split("\n")) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 4) continue;
    const name = parts[0];
    const rawValue = parts[1];
    const unit = parts[2];
    const status = parts[3];

    const numValue = parseFloat(rawValue);
    const value: number | string = isNaN(numValue) ? rawValue : numValue;

    let upperCritical: number | undefined;
    if (parts[8]) {
      const uc = parseFloat(parts[8]);
      if (!isNaN(uc)) upperCritical = uc;
    }

    sensors.push({ name, value, unit, status, upper_critical: upperCritical });
  }

  // Per-socket CPU thermal pre-filter: drop `CPU<N>_DTS` when a sibling
  // `CPU<N>_TEMP` (or `CPU<N> Temp`) sensor is present. Closes the
  // Gigabyte BMC firmware 12.61 over-fire on AMD platforms (crucible#2).
  // Applied before downstream classification so ECC and PSU loops see
  // the same list that gets published.
  sensors = filterRedundantCpuDtsSensors(sensors);

  // ECC errors from memory-type sensors
  let correctable = 0;
  let uncorrectable = 0;
  for (const sensor of sensors) {
    const name = sensor.name.toLowerCase();
    if (name.includes("correctable") && typeof sensor.value === "number") {
      correctable += sensor.value;
    }
    if (name.includes("uncorrectable") && typeof sensor.value === "number") {
      uncorrectable += sensor.value;
    }
  }

  // SEL entry count
  let selCount = 0;
  const selInfo = await run("ipmitool", ["sel", "info"]);
  if (selInfo) {
    const match = selInfo.match(/Entries\s*:\s*(\d+)/i);
    if (match) selCount = parseInt(match[1], 10);
  }

  // SEL recent events. C11 (2026-05-19): tag each event with the BMC
  // vendor's parser_quality so Dashboard can render an honesty surface
  // for stub-parser BMCs (Lenovo, Cisco, OpenBMC).
  const bmcVendor = mapVendorToBmcVendor(vendor);
  const selParserQuality = parserQualityFor(bmcVendor);
  const selEventsRaw = await collectSelEvents();
  const selEvents = selEventsRaw.map((e) => ({ ...e, parser_quality: selParserQuality }));

  // ECC errors from SEL events (Dell iDRAC reports memory ECC only via SEL).
  // Counts ALL events since last SEL clear, not just the recent window —
  // re-parse the full SEL elist for accurate cumulative counts.
  const selEccCounts = await collectSelEccCounts();

  // PSU redundancy state from a vendor sensor (Dell `PS Redundancy`).
  let psuRedundancyState: PsuRedundancyState | undefined;
  for (const s of sensors) {
    if (isPsuRedundancySensor(s.name, vendor)) {
      const stateText = String(s.status).toLowerCase() === "ok"
        ? String(s.value)  // value carries the redundancy text on some firmwares
        : String(s.status);
      psuRedundancyState = classifyPsuRedundancyState(stateText);
      break;
    }
  }

  // Fan status
  const fans = await collectFanStatus();

  return {
    available: true,
    bmc_vendor: bmcVendor,
    sensors,
    ecc_errors: { correctable, uncorrectable },
    ecc_errors_from_sel: selEccCounts,
    psu_redundancy_state: psuRedundancyState,
    sel_entries_count: selCount,
    sel_events_recent: selEvents,
    fans,
    detection: capability,
  };
}

export const __test_only_c11 = { mapVendorToBmcVendor, parserQualityFor };

/**
 * Re-parse the full SEL elist counting ECC events on the Memory entity.
 * Used for vendors (notably Dell) that don't expose ECC counters as
 * named sensors. Returns cumulative counts since last SEL clear.
 */
export async function collectSelEccCounts(): Promise<{ correctable: number; uncorrectable: number; newest_event_timestamp: string | null }> {
  const output = await run("ipmitool", ["sel", "elist"]);
  if (!output) return { correctable: 0, uncorrectable: 0, newest_event_timestamp: null };
  return parseSelEccCounts(output);
}

export function parseSelEccCounts(output: string): { correctable: number; uncorrectable: number; newest_event_timestamp: string | null } {
  let correctable = 0;
  let uncorrectable = 0;
  let newest: string | null = null;
  for (const line of output.split("\n")) {
    const parts = line.split("|").map(s => s.trim());
    if (parts.length < 5) continue;
    const [_id, date, time, sensor, event] = parts;
    const sensorLower = sensor.toLowerCase();
    const eventLower = event.toLowerCase();
    // Memory entity: Dell uses sensor names like "Memory", "ECC Corr Err",
    // "ECC Uncorr Err", or DIMM-slot identifiers. Match on sensor type
    // tokens or the event description directly.
    const isMemoryRelated =
      sensorLower.includes("memory") ||
      sensorLower.includes("dimm") ||
      sensorLower.includes("ecc") ||
      eventLower.includes("ecc");
    if (!isMemoryRelated) continue;
    if (eventLower.includes("uncorrectable") || eventLower.includes("uncorr")) {
      uncorrectable++;
    } else if (eventLower.includes("correctable") || eventLower.includes("corr")) {
      correctable++;
    }
    const ts = parseSelTimestamp(date, time);
    if (!newest || ts > newest) newest = ts;
  }
  return { correctable, uncorrectable, newest_event_timestamp: newest };
}

async function collectSelEvents(): Promise<SelEvent[]> {
  const output = await run("ipmitool", ["sel", "elist"]);
  if (!output) return [];

  const events: SelEvent[] = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 5) continue;

    const [idStr, date, time, sensor, event, direction] = parts;

    const timestamp = parseSelTimestamp(date, time);

    // Contract: the agent reports the last 20 SEL events regardless of
    // age, every snapshot. The dashboard applies the recency window
    // (ipmi_sel_critical_window_days, default 30, per-server override)
    // and the transient-pairing filter; a client-side age filter here
    // would starve that window after an agent restart. (An unused
    // 5-minute filter once sat here; it was never applied.)
    const sensorType = classifySensor(sensor);
    const severity = deriveSelSeverity(event, sensorType);

    events.push({
      id: parseInt(idStr) || 0,
      timestamp,
      sensor,
      sensor_type: sensorType,
      event,
      direction: direction || "Asserted",
      severity,
    });
  }

  // Return last 20 events, most recent first
  return events.slice(-20).reverse();
}

export function parseSelTimestamp(date: string, time: string): string {
  if (!date || !time) return new Date().toISOString();
  // ipmitool sel elist date formats observed in the wild:
  //   "04/05/2026"  (Dell iDRAC, 4-digit year)
  //   "06/17/23"    (Supermicro X11/X12 BMCs, 2-digit year)
  // Time formats observed:
  //   "14:23:05"
  //   "09:05:27 UTC"  (Supermicro X11/X12 BMCs append a UTC suffix)
  // Pre-fix the function emitted shapes like "23-06-17T09:05:27 UTCZ"
  // which Dashboard's evaluator couldn't parse for the time-window check.
  // Normalise to strict ISO-8601: 4-digit year, no trailing UTC.
  // glassmkr#24 / Codex experiment 2026-05-12.
  const parts = date.split("/");
  if (parts.length !== 3) return new Date().toISOString();
  let [month, day, year] = parts;
  if (year.length === 2) {
    // ipmitool convention: 70-99 = 19xx, 00-69 = 20xx
    year = Number(year) >= 70 ? `19${year}` : `20${year}`;
  }
  const cleanTime = time.replace(/\s*UTC\s*$/i, "").trim();
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${cleanTime}Z`;
}

export function classifySensor(sensor: string): string {
  const lower = sensor.toLowerCase();
  if (lower.includes("memory") || lower.includes("dimm")) return "memory";
  if (lower.includes("power supply") || lower.includes("psu")) return "power";
  if (lower.includes("fan")) return "fan";
  if (lower.includes("watchdog")) return "watchdog";
  if (lower.includes("processor") || lower.includes("cpu")) return "processor";
  if (lower.includes("temperature") || lower.includes("temp")) return "temperature";
  if (lower.includes("voltage")) return "voltage";
  if (lower.includes("drive") || lower.includes("disk")) return "storage";
  if (lower.includes("chassis") || lower.includes("intrusion")) return "chassis";
  return "other";
}

export function deriveSelSeverity(event: string, sensorType: string): string {
  const lower = event.toLowerCase();

  // Critical events
  if (lower.includes("uncorrectable")) return "critical";
  if (lower.includes("failure detected")) return "critical";
  if (lower.includes("ac lost")) return "critical";
  if (lower.includes("hard reset")) return "critical";
  if (lower.includes("power off")) return "critical";
  if (lower.includes("critical")) return "critical";
  if (lower.includes("non-recoverable")) return "critical";
  if (lower.includes("thermal trip")) return "critical";
  if (lower.includes("processor disabled")) return "critical";
  if (lower.includes("machine check")) return "critical";

  // Warning events
  if (lower.includes("correctable ecc")) return "warning";
  if (lower.includes("logging limit")) return "warning";
  if (lower.includes("lower critical going low")) return "warning";
  if (lower.includes("upper critical going high")) return "warning";
  if (lower.includes("redundancy lost")) return "warning";
  if (lower.includes("predictive failure")) return "warning";
  if (lower.includes("degraded")) return "warning";

  // Info events
  if (lower.includes("presence detected")) return "info";
  if (lower.includes("power cycle")) return "info";
  if (lower.includes("oem")) return "info";

  if (["memory", "power", "fan", "processor"].includes(sensorType)) return "warning";
  return "info";
}

async function collectFanStatus(): Promise<FanStatus[]> {
  const output = await run("ipmitool", ["sdr", "type", "Fan"]);
  if (!output) return [];
  return parseFanStatus(output);
}

export function parseFanStatus(output: string): FanStatus[] {
  const fans: FanStatus[] = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) continue;

    const name = parts[0];
    const fullLine = parts.join(" ");

    let rpm = 0;
    let status = "ok";

    // Search all fields for RPM value (format varies by BMC)
    const rpmMatch = fullLine.match(/(\d+)\s*RPM/i);
    if (rpmMatch) {
      rpm = parseInt(rpmMatch[1]);
    }

    // Check status codes across all fields
    const hasNoReading = fullLine.toLowerCase().includes("no reading");
    const statusCodes = parts.slice(1).map((p) => p.toLowerCase());
    const hasCritical = statusCodes.some((s) => s === "cr" || s === "nr");
    const hasWarning = statusCodes.some((s) => s === "nc");
    const hasAbsent = statusCodes.some((s) => s === "ns") || hasNoReading;
    const hasOk = statusCodes.some((s) => s === "ok");

    if (hasCritical) status = "critical";
    else if (hasWarning) status = "warning";
    else if (hasAbsent) status = "absent";
    else if (hasOk) status = "ok";
    else if (rpm === 0 && !hasNoReading) status = "critical";

    fans.push({ name, rpm, status });
  }

  return fans;
}
