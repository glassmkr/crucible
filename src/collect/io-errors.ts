import { readProcFile } from "../lib/parse.js";
import { runPrivileged } from "../lib/privileged.js";

// The dmesg-io action's window: `dmesg --since "10 minutes ago"`.
const WINDOW_SECONDS = 600;

export async function collectIoErrors(): Promise<{ count: number; devices: string[] } | null> {
  // Parse dmesg for recent I/O errors (last 10 minutes covers the 5-min collection interval)
  const output = await runPrivileged("dmesg-io", [], 5000);
  if (!output || !output.trim()) return null;
  const uptime = parseFloat((readProcFile("/proc/uptime") ?? "").split(/\s+/)[0]);
  return parseIoErrorLines(output, Number.isFinite(uptime) ? uptime : null);
}

/**
 * Count the dmesg-io action's lines. On util-linux >= 2.35 they come from
 * `dmesg -T --since "10 minutes ago"` and are already windowed. On older
 * dmesg the action falls back to a plain read, whose lines keep the raw
 * "[seconds since boot]" stamp and span the whole ring buffer: those count
 * only when stamped within WINDOW_SECONDS of `uptimeSeconds`, and not at all
 * when uptime is unknown (counting the whole boot would raise an old error
 * on every snapshot).
 */
export function parseIoErrorLines(
  output: string,
  uptimeSeconds: number | null,
): { count: number; devices: string[] } | null {
  const lines = output.trim().split("\n").filter((l) => {
    if (!l.trim()) return false;
    const raw = l.match(/^\[\s*(\d+(?:\.\d+)?)\]/);
    if (!raw) return true;
    return uptimeSeconds !== null && parseFloat(raw[1]) >= uptimeSeconds - WINDOW_SECONDS;
  });
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
