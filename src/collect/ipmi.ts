import { run } from "../lib/exec.js";
import type { IpmiInfo, SelEvent, FanStatus } from "../lib/types.js";

export async function collectIpmi(): Promise<IpmiInfo> {
  const sensorRaw = await run("ipmitool", ["sensor"]);
  if (!sensorRaw) {
    return { available: false, sensors: [], ecc_errors: { correctable: 0, uncorrectable: 0 }, sel_entries_count: 0, sel_events_recent: [], fans: [] };
  }

  // Parse sensor readings
  const sensors: IpmiInfo["sensors"] = [];
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

  // SEL recent events
  const selEvents = await collectSelEvents();

  // Fan status
  const fans = await collectFanStatus();

  return {
    available: true,
    sensors,
    ecc_errors: { correctable, uncorrectable },
    sel_entries_count: selCount,
    sel_events_recent: selEvents,
    fans,
  };
}

async function collectSelEvents(): Promise<SelEvent[]> {
  const output = await run("ipmitool", ["sel", "elist"]);
  if (!output) return [];

  const events: SelEvent[] = [];
  const lines = output.trim().split("\n");
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  for (const line of lines) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 5) continue;

    const [idStr, date, time, sensor, event, direction] = parts;

    const timestamp = parseSelTimestamp(date, time);
    const tsDate = new Date(timestamp);

    // Only include events from the last 5 minutes on subsequent runs
    // On first run this will include everything (fiveMinAgo is always recent)
    // We keep last 20 events max regardless
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

function parseSelTimestamp(date: string, time: string): string {
  if (!date || !time) return new Date().toISOString();
  // Format: "04/05/2026" and "14:23:05"
  const parts = date.split("/");
  if (parts.length !== 3) return new Date().toISOString();
  const [month, day, year] = parts;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${time}Z`;
}

function classifySensor(sensor: string): string {
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

function deriveSelSeverity(event: string, sensorType: string): string {
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
