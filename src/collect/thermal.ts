import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isCpuChip } from "../lib/cpu-thermal-chips.js";
import { readFileTrim } from "../lib/parse.js";
import type { HwmonFanReading, HwmonVoltageReading, ThermalInfo, ThermalReading } from "../lib/types.js";

const HWMON_ROOT = "/sys/class/hwmon";
const THERMAL_ZONE_ROOT = "/sys/class/thermal";

// Driver names we skip entirely (not in cpu_readings, not in other_readings).
// Kept short: anything not on this list and not on the CPU allowlist becomes
// other_readings so users can still see the data.
const SKIP_CHIPS: ReadonlySet<string> = new Set([
  "nvme", // already covered by SMART
]);

// listDir intentionally returns null (not []) on error so collectThermal
// can distinguish "looked but empty" from "couldn't look at all" (see the
// everLookedAt* logic below); readDirSafe's [] return would conflate them.
async function listDir(path: string): Promise<string[] | null> {
  try {
    return await fs.readdir(path);
  } catch {
    return null;
  }
}

/**
 * Per-reading classification for CPU chips that don't need cross-reading
 * fallback logic.
 *
 * Intel coretemp:  prefer "Package id N", per-core to other_readings.
 * Pi cpu_thermal:  single anonymous reading, take it.
 *
 * AMD k10temp / zenpower handled separately in `pickAmdCpuReading` because
 * Tdie isn't always exposed; the kernel may show only Tctl, only Tccd*,
 * or any subset. We need to look at all readings on the chip together to
 * pick the best CPU candidate.
 */
function classifyCpuReading(chip: string, label: string): "cpu" | "other" | "skip" {
  const lower = label.toLowerCase();
  if (chip === "coretemp") {
    if (lower.startsWith("package id")) return "cpu";
    if (lower.startsWith("core ")) return "other";
    return "other";
  }
  // k10temp / zenpower handled by pickAmdCpuReading.
  if (chip === "k10temp" || chip === "zenpower") return "skip";
  // Pi cpu_thermal and other ARM SoCs: usually one reading per chip, take it.
  return "cpu";
}

/**
 * Pick the best CPU reading from a set of AMD k10temp / zenpower readings
 * on a single chip. Preference order:
 *   1. Tdie    -- die temperature, no offset, ideal
 *   2. First Tccd* (lowest index) -- per-CCD die temp, decent proxy
 *   3. Tctl   -- offset on Zen 1/2 (+20°C) but accurate on later parts;
 *                last resort because it can be misleading on older CPUs
 *
 * Other readings (e.g. additional Tccd siblings) become other_readings.
 * This matches what `sensors`(1) does in user-facing output and avoids
 * the 0.8.0 bug where "only-Tctl" or "only-Tccd" hosts produced no CPU
 * reading at all.
 */
function pickAmdCpuReading(readings: ThermalReading[]): { cpu: ThermalReading | null; other: ThermalReading[] } {
  if (readings.length === 0) return { cpu: null, other: [] };
  // Find by label (case-insensitive). Labels were already prefixed with
  // chip name in the caller; strip that prefix for matching.
  const labelOf = (r: ThermalReading) => r.label.replace(new RegExp(`^${r.source_chip}\\s+`, "i"), "").toLowerCase();
  const tdie = readings.find(r => labelOf(r) === "tdie");
  if (tdie) {
    return { cpu: tdie, other: readings.filter(r => r !== tdie) };
  }
  const tccds = readings
    .filter(r => labelOf(r).startsWith("tccd"))
    .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  if (tccds.length > 0) {
    return { cpu: tccds[0], other: readings.filter(r => r !== tccds[0]) };
  }
  const tctl = readings.find(r => labelOf(r) === "tctl");
  if (tctl) {
    return { cpu: tctl, other: readings.filter(r => r !== tctl) };
  }
  // Fallback: anonymous reading on a chip the driver didn't label.
  return { cpu: readings[0], other: readings.slice(1) };
}

export async function collectFromHwmon(root: string = HWMON_ROOT): Promise<{ cpu: ThermalReading[]; other: ThermalReading[]; fans: HwmonFanReading[]; voltages: HwmonVoltageReading[] } | null> {
  const entries = await listDir(root);
  if (!entries) return null;

  const cpu: ThermalReading[] = [];
  const other: ThermalReading[] = [];
  const fans: HwmonFanReading[] = [];
  const voltages: HwmonVoltageReading[] = [];

  for (const entry of entries) {
    const chipDir = join(root, entry);
    const chipName = readFileTrim(join(chipDir, "name"));
    if (!chipName) continue;
    if (SKIP_CHIPS.has(chipName)) continue;

    const files = await listDir(chipDir);
    if (!files) continue;

    // Stable per-device id so two sockets running the same driver (e.g. dual
    // k10temp both reporting "k10temp Tctl") get distinct alert-state keys. The
    // `device` symlink resolves to the PCI address, which is stable across
    // reboots; fall back to the hwmon dir name when it is absent.
    const devLink = await fs.readlink(join(chipDir, "device")).catch(() => null);
    const chipId = devLink ? (devLink.split("/").filter(Boolean).pop() ?? entry) : entry;

    // Fans + voltages (collectd sensors parity close, 2026-08-24). Read
    // alongside the temperatures on every chip; the CPU/other temperature
    // classification below does not apply to them.
    for (const file of files) {
      const fanMatch = file.match(/^fan(\d+)_input$/);
      if (fanMatch) {
        const rpmRaw = readFileTrim(join(chipDir, file));
        if (rpmRaw === null || !/^\d+$/.test(rpmRaw)) continue;
        const rpm = parseInt(rpmRaw, 10);
        // A 0 rpm reading is dropped ONLY when fanN_enable says the
        // sensor is disabled; otherwise a stopped fan is a signal, not
        // noise, so the 0 is reported.
        if (rpm === 0 && readFileTrim(join(chipDir, `fan${fanMatch[1]}_enable`)) === "0") continue;
        const fanLabel = readFileTrim(join(chipDir, `fan${fanMatch[1]}_label`));
        fans.push({
          label: fanLabel ? `${chipName} ${fanLabel}` : `${chipName} fan${fanMatch[1]}`,
          rpm,
          source_chip: chipName,
          chip_id: chipId,
        });
        continue;
      }
      const inMatch = file.match(/^in(\d+)_input$/);
      if (inMatch) {
        // inN_input is millivolts per the hwmon ABI; emitted as read.
        // Negative values are legal on some sensors.
        const mvRaw = readFileTrim(join(chipDir, file));
        if (mvRaw === null || !/^-?\d+$/.test(mvRaw)) continue;
        const inLabel = readFileTrim(join(chipDir, `in${inMatch[1]}_label`));
        voltages.push({
          label: inLabel ? `${chipName} ${inLabel}` : `${chipName} in${inMatch[1]}`,
          millivolts: parseInt(mvRaw, 10),
          source_chip: chipName,
          chip_id: chipId,
        });
      }
    }

    // Find tempN_input files. Skip threshold files (max, crit, max_hyst, min, etc.)
    const tempInputs = files.filter(f => /^temp\d+_input$/.test(f));
    const isCpu = isCpuChip(chipName);
    const isAmd = chipName === "k10temp" || chipName === "zenpower";

    // Buffer all readings on this chip first so AMD chips can do
    // cross-reading Tdie/Tccd/Tctl fallback without needing two passes
    // through the filesystem.
    const chipReadings: ThermalReading[] = [];

    for (const inputFile of tempInputs) {
      const idx = inputFile.match(/^temp(\d+)_input$/)![1];
      const valueRaw = readFileTrim(join(chipDir, inputFile));
      if (!valueRaw) continue;
      const millideg = parseInt(valueRaw, 10);
      if (!Number.isFinite(millideg)) continue;
      const celsius = millideg / 1000;
      // Reject obviously bogus values (millideg out of range / sensor offline)
      if (celsius < -50 || celsius > 200) continue;

      const labelFile = readFileTrim(join(chipDir, `temp${idx}_label`));
      const label = labelFile ? `${chipName} ${labelFile}` : `${chipName} temp${idx}`;
      const reading: ThermalReading = {
        label,
        value_celsius: Math.round(celsius * 10) / 10,
        source_chip: chipName,
        source: "hwmon",
        chip_id: chipId,
      };

      if (!isCpu) {
        other.push(reading);
        continue;
      }

      if (isAmd) {
        chipReadings.push(reading);
        continue;
      }

      const cls = classifyCpuReading(chipName, labelFile ?? "");
      if (cls === "cpu") cpu.push(reading);
      else if (cls === "other") other.push(reading);
      // "skip" → drop
    }

    if (isAmd && chipReadings.length > 0) {
      const { cpu: amdCpu, other: amdOther } = pickAmdCpuReading(chipReadings);
      if (amdCpu) cpu.push(amdCpu);
      other.push(...amdOther);
    }
  }

  return { cpu, other, fans, voltages };
}

export async function collectFromThermalZone(root: string = THERMAL_ZONE_ROOT): Promise<{ cpu: ThermalReading[]; other: ThermalReading[] } | null> {
  const entries = await listDir(root);
  if (!entries) return null;

  const cpu: ThermalReading[] = [];
  const other: ThermalReading[] = [];

  for (const entry of entries) {
    if (!entry.startsWith("thermal_zone")) continue;
    const zoneDir = join(root, entry);
    const type = readFileTrim(join(zoneDir, "type"));
    const tempRaw = readFileTrim(join(zoneDir, "temp"));
    if (!type || !tempRaw) continue;
    const millideg = parseInt(tempRaw, 10);
    if (!Number.isFinite(millideg)) continue;
    const celsius = Math.round((millideg / 1000) * 10) / 10;
    if (celsius < -50 || celsius > 200) continue;

    const reading: ThermalReading = {
      label: `${type} (${entry})`,
      value_celsius: celsius,
      source_chip: type,
      source: "thermal_zone",
    };

    const lower = type.toLowerCase();
    const isCpuZone =
      lower === "cpu-thermal" ||
      lower === "cpu_thermal" ||
      lower === "x86_pkg_temp" ||
      lower.startsWith("cpu");
    if (isCpuZone) cpu.push(reading);
    else other.push(reading);
  }

  return { cpu, other };
}

export async function collectThermal(): Promise<ThermalInfo> {
  // Try hwmon first.
  const hwmon = await collectFromHwmon();

  // Fans + voltages come only from hwmon and ride along regardless of
  // which temperature source wins below (a chassis can expose fans with
  // no usable temp sensors). Omitted when empty: absent means no such
  // sensors exposed, never zero fans.
  const extras: Pick<ThermalInfo, "fans" | "voltages"> = {};
  if (hwmon && hwmon.fans.length > 0) extras.fans = hwmon.fans;
  if (hwmon && hwmon.voltages.length > 0) extras.voltages = hwmon.voltages;

  if (hwmon && (hwmon.cpu.length > 0 || hwmon.other.length > 0)) {
    const max = hwmon.cpu.length > 0 ? Math.max(...hwmon.cpu.map(r => r.value_celsius)) : null;
    return {
      available: true,
      source: hwmon.cpu.length > 0 ? "hwmon" : (hwmon.other.length > 0 ? "hwmon" : "none"),
      cpu_readings: hwmon.cpu,
      other_readings: hwmon.other,
      max_cpu_celsius: max,
      ...extras,
    };
  }

  // Fallback to thermal_zone.
  const tz = await collectFromThermalZone();
  if (tz && (tz.cpu.length > 0 || tz.other.length > 0)) {
    const max = tz.cpu.length > 0 ? Math.max(...tz.cpu.map(r => r.value_celsius)) : null;
    return {
      available: true,
      source: "thermal_zone",
      cpu_readings: tz.cpu,
      other_readings: tz.other,
      max_cpu_celsius: max,
      ...extras,
    };
  }

  // Nothing available. Distinguish "we looked" (hwmon dir existed but empty)
  // from "we couldn't look at all" (no /sys mounted).
  const everLookedAtHwmon = hwmon !== null;
  const everLookedAtTz = tz !== null;
  if (everLookedAtHwmon || everLookedAtTz) {
    return { available: true, source: "none", cpu_readings: [], other_readings: [], max_cpu_celsius: null, ...extras };
  }
  return { available: false, source: "none", cpu_readings: [], other_readings: [], max_cpu_celsius: null };
}
