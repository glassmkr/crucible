import { runPrivileged } from "../lib/privileged.js";

export async function collectIoErrors(): Promise<{ count: number; devices: string[] } | null> {
  // Parse dmesg for recent I/O errors (last 10 minutes covers the 5-min collection interval)
  const output = await runPrivileged("dmesg-io", [], 5000);
  if (!output || !output.trim()) return null;

  const lines = output.trim().split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  // Extract device names from error messages
  const deviceSet = new Set<string>();
  for (const line of lines) {
    // "blk_update_request: I/O error, dev sda, sector 12345"
    const devMatch = line.match(/dev\s+(\w+)/);
    if (devMatch) deviceSet.add(devMatch[1]);
    // "Buffer I/O error on device sda1"
    const bufMatch = line.match(/on device\s+(\w+)/);
    if (bufMatch) deviceSet.add(bufMatch[1]);
  }

  return { count: lines.length, devices: Array.from(deviceSet) };
}
