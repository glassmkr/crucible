import { hostname } from "os";
import { readProcFile } from "../lib/parse.js";
import { run } from "../lib/exec.js";
import type { SystemInfo } from "../lib/types.js";

// Matches KEY=value with optional surrounding double quotes. Handles both
// `ID=ubuntu` and `ID="rocky"` styles found in the wild. Tolerates non-spec
// lines like `ID=ubuntu  ` (trailing space) or `ID="ubuntu" ` (space after the
// closing quote): trim, strip one layer of matching quotes, trim again, so a
// malformed line yields the clean id rather than a junk value that falls
// through to "unknown". (Codex review 2026-06-06, #27.)
export function readOsReleaseField(osRelease: string, key: string): string | undefined {
  const m = osRelease.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return undefined;
  const value = m[1].trim().replace(/^"(.*)"$/, "$1").trim();
  return value ? value.toLowerCase() : undefined;
}

export async function collectSystem(): Promise<SystemInfo> {
  const osRelease = readProcFile("/etc/os-release") || "";
  const osName = osRelease.match(/PRETTY_NAME="(.+?)"/)?.[1] || "Unknown";
  const os_id = readOsReleaseField(osRelease, "ID");
  const os_id_like = readOsReleaseField(osRelease, "ID_LIKE");
  // VERSION_ID added 2026-05-18: Dashboard's FIX-workflow variant
  // selector keys distro_match patterns on `<os_id>-<os_version_id>`
  // (e.g. "debian-13", "ubuntu-24.04"). Without this field, every
  // variant with a `["debian-*", ...]` pattern falls through to the
  // wildcard `["*"]` fallback in Dashboard, so customers running the
  // 0.10.1-or-older agent see the generic "distro/vendor unknown"
  // FIX block on alert detail pages.
  const os_version_id = readOsReleaseField(osRelease, "VERSION_ID");
  const kernel = (await run("uname", ["-r"]))?.trim() || "unknown";
  const uptimeRaw = readProcFile("/proc/uptime") || "0";
  const uptimeSeconds = Math.floor(parseFloat(uptimeRaw.split(" ")[0]));
  const ip = (await run("hostname", ["-I"]))?.trim().split(" ")[0] || "unknown";

  return {
    hostname: hostname(),
    ip,
    os: osName,
    ...(os_id ? { os_id } : {}),
    ...(os_id_like ? { os_id_like } : {}),
    ...(os_version_id ? { os_version_id } : {}),
    kernel,
    uptime_seconds: uptimeSeconds,
  };
}
