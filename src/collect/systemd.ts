import { run } from "../lib/exec.js";

export interface SystemdData {
  failed_units: string[];
  failed_count: number;
}

// Units commonly in failed state by design or misconfiguration
const DEFAULT_EXCLUDES = [
  "systemd-networkd-wait-online.service",
];

export async function collectSystemd(extraExcludes: string[] = []): Promise<SystemdData> {
  const output = await run("systemctl", [
    "list-units", "--type=service", "--state=failed", "--no-legend", "--plain",
  ]);

  if (!output || output.trim() === "") {
    return { failed_units: [], failed_count: 0 };
  }

  const excludes = new Set([...DEFAULT_EXCLUDES, ...extraExcludes]);
  const units: string[] = [];

  for (const line of output.trim().split("\n")) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit && unit.endsWith(".service") && !excludes.has(unit)) {
      units.push(unit);
    }
  }

  return { failed_units: units, failed_count: units.length };
}
