import { runPrivileged } from "../lib/privileged.js";
import { readdirSync, readFileSync } from "fs";
import type { SmartInfo } from "../lib/types.js";

export async function collectSmart(): Promise<SmartInfo[]> {
  // Find block devices
  const devices: string[] = [];
  try {
    const entries = readdirSync("/sys/block");
    for (const entry of entries) {
      if (!(entry.startsWith("sd") || entry.startsWith("nvme") || entry.startsWith("hd"))) continue;
      // Skip media-less virtual devices (BMC virtual media: "AMI Virtual
      // HDisk0" enumerates as a 0-byte USB /dev/sda on Supermicro/ASUS
      // boards). smartctl cannot interrogate them and they are not disks;
      // without this guard one produced a phantom "SMART failure on
      // /dev/sda" (agentic-17, 2026-07-05).
      try {
        if (parseInt(readFileSync(`/sys/block/${entry}/size`, "utf-8").trim(), 10) === 0) continue;
      } catch { /* unreadable size: let smartctl decide */ }
      devices.push(`/dev/${entry}`);
    }
  } catch {
    return [];
  }

  const results: SmartInfo[] = [];
  for (const device of devices) {
    const output = await runPrivileged("smart", [device]);
    if (!output) continue;

    try {
      const info = parseSmartctlJson(JSON.parse(output), device);
      if (info) results.push(info);
    } catch {
      // Failed to parse, skip this device
    }
  }

  return results;
}

export function parseSmartctlJson(data: Record<string, unknown> & {
  model_name?: string;
  model_family?: string;
  serial_number?: string;
  firmware_version?: string;
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  nvme_smart_health_information_log?: {
    percentage_used?: number;
    temperature?: number;
    /** NVMe Critical Warning byte (NVM Express spec §5.21). */
    critical_warning?: number;
    available_spare?: number;
    available_spare_threshold?: number;
  };
  ata_smart_attributes?: { table?: Array<{ id?: number; name?: string; value?: number; raw?: { value?: number } }> };
}, device: string): SmartInfo | null {
  // No SMART surface at all: smartctl emitted JSON but could not interrogate
  // the device (USB bridge without a -d type, BMC virtual media, unsupported
  // enclosure). "Cannot read SMART" is NOT "FAILED": before this guard,
  // `smart_status?.passed` being undefined fell through to FAILED and fired a
  // phantom critical smart_failing on AMI Virtual HDisk0 (agentic-17).
  if (data.smart_status === undefined && data.nvme_smart_health_information_log === undefined) {
    return null;
  }

  const info: SmartInfo = {
    device,
    model: data.model_name || data.model_family || "unknown",
    serial: data.serial_number,
    firmware: data.firmware_version,
    health: data.smart_status?.passed ? "PASSED" : "FAILED",
    temperature_c: data.temperature?.current,
    power_on_hours: data.power_on_time?.hours,
  };

  // NVMe specific
  if (data.nvme_smart_health_information_log) {
    const nvme = data.nvme_smart_health_information_log;
    info.percentage_used = nvme.percentage_used;
    info.temperature_c = nvme.temperature;
    // C17 (2026-05-19): expose the raw Critical Warning byte + per-bit
    // decoded flags so Dashboard's nvme_critical_warning rule can fire
    // on the specific failure modes. Per NVM Express spec §5.21.
    if (typeof nvme.critical_warning === "number") {
      info.critical_warning_raw = nvme.critical_warning;
      info.critical_warning_decoded = decodeNvmeCriticalWarning(nvme.critical_warning);
    }
    if (typeof nvme.available_spare === "number") {
      info.nvme_available_spare = nvme.available_spare;
    }
    if (typeof nvme.available_spare_threshold === "number") {
      info.nvme_available_spare_threshold = nvme.available_spare_threshold;
    }
  }

  // SATA specific
  if (data.ata_smart_attributes?.table) {
    // SSD endurance/wear. Unlike NVMe (which has a dedicated percentage_used
    // field), a SATA SSD reports wear through a vendor-specific attribute whose
    // NORMALIZED value is "% life remaining" (100 = new, counts down toward the
    // failure threshold). Convert the most-worn such attribute into
    // percentage_used so a SATA SSD flows the SAME wear field NVMe does, which
    // is what the dashboard wear rule + trend engine read. Without this a worn
    // SATA SSD (e.g. a Crucial MX500 at 25% life remaining) is invisible to
    // wear detection. Match by attribute NAME (authoritative, and disambiguates
    // ID 231, which is wear on some drives and temperature on others) with a
    // known-ID fallback (Micron/Crucial 202, Intel 233, Samsung 177, others
    // 173/231); skip anything that looks like a temperature attribute.
    let ssdWearUsedPct: number | null = null;
    for (const attr of data.ata_smart_attributes.table) {
      if (attr.id === 5 || attr.name === "Reallocated_Sector_Ct") {
        info.reallocated_sectors = attr.raw?.value || 0;
      }
      if (attr.id === 197 || attr.name === "Current_Pending_Sector") {
        info.pending_sectors = attr.raw?.value || 0;
      }
      const name = (attr.name || "").toLowerCase();
      const isWearName = /wear.?level|wearout|life.?left|life.?time|percent.?life|ssd.?life|endurance/.test(name);
      const isWearId = attr.id === 202 || attr.id === 233 || attr.id === 177 || attr.id === 173 || attr.id === 231;
      const looksTemperature = name.includes("temp");
      if ((isWearName || isWearId) && !looksTemperature && typeof attr.value === "number") {
        // Normalized value is life remaining; used = 100 - remaining. Take the
        // most-worn (highest used) across candidates: conservative for a
        // plan-replacement signal.
        const used = Math.min(100, Math.max(0, 100 - attr.value));
        if (ssdWearUsedPct == null || used > ssdWearUsedPct) ssdWearUsedPct = used;
      }
    }
    // Only fill percentage_used for a SATA drive; NVMe already set it from its
    // own health log above.
    if (ssdWearUsedPct != null && info.percentage_used == null) {
      info.percentage_used = ssdWearUsedPct;
    }
  }

  return info;
}

/**
 * Decode the NVMe Critical Warning byte (NVM Express spec §5.21):
 *   bit 0: available spare below threshold
 *   bit 1: temperature outside operating range
 *   bit 2: NVM subsystem reliability degraded
 *   bit 3: media in read-only mode
 *   bit 4: volatile memory backup device has failed
 *   bit 5: persistent memory region became read-only (NVMe 1.4+)
 *
 * Bit ordering differs across docs; this implementation follows the
 * spec verbatim. Any non-zero bit is a vendor-recommended immediate-
 * action signal.
 */
export function decodeNvmeCriticalWarning(byte: number): {
  available_spare_low: boolean;
  temperature_threshold: boolean;
  reliability_degraded: boolean;
  read_only: boolean;
  volatile_memory_backup_failed: boolean;
  persistent_memory_readonly: boolean;
} {
  return {
    available_spare_low: (byte & 0x01) !== 0,
    temperature_threshold: (byte & 0x02) !== 0,
    reliability_degraded: (byte & 0x04) !== 0,
    read_only: (byte & 0x08) !== 0,
    volatile_memory_backup_failed: (byte & 0x10) !== 0,
    persistent_memory_readonly: (byte & 0x20) !== 0,
  };
}
