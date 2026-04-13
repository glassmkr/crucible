import { run } from "../lib/exec.js";
import { readdirSync } from "fs";
import type { SmartInfo } from "../lib/types.js";

export async function collectSmart(): Promise<SmartInfo[]> {
  // Find block devices
  const devices: string[] = [];
  try {
    const entries = readdirSync("/sys/block");
    for (const entry of entries) {
      if (entry.startsWith("sd") || entry.startsWith("nvme") || entry.startsWith("hd")) {
        devices.push(`/dev/${entry}`);
      }
    }
  } catch {
    return [];
  }

  const results: SmartInfo[] = [];
  for (const device of devices) {
    const output = await run("smartctl", ["--json", "--all", device]);
    if (!output) continue;

    try {
      const info = parseSmartctlJson(JSON.parse(output), device);
      results.push(info);
    } catch {
      // Failed to parse, skip this device
    }
  }

  return results;
}

export function parseSmartctlJson(data: Record<string, unknown> & {
  model_name?: string;
  model_family?: string;
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  nvme_smart_health_information_log?: { percentage_used?: number; temperature?: number };
  ata_smart_attributes?: { table?: Array<{ id?: number; name?: string; raw?: { value?: number } }> };
}, device: string): SmartInfo {
  const info: SmartInfo = {
    device,
    model: data.model_name || data.model_family || "unknown",
    health: data.smart_status?.passed ? "PASSED" : "FAILED",
    temperature_c: data.temperature?.current,
    power_on_hours: data.power_on_time?.hours,
  };

  // NVMe specific
  if (data.nvme_smart_health_information_log) {
    const nvme = data.nvme_smart_health_information_log;
    info.percentage_used = nvme.percentage_used;
    info.temperature_c = nvme.temperature;
  }

  // SATA specific
  if (data.ata_smart_attributes?.table) {
    for (const attr of data.ata_smart_attributes.table) {
      if (attr.id === 5 || attr.name === "Reallocated_Sector_Ct") {
        info.reallocated_sectors = attr.raw?.value || 0;
      }
      if (attr.id === 197 || attr.name === "Current_Pending_Sector") {
        info.pending_sectors = attr.raw?.value || 0;
      }
    }
  }

  return info;
}
