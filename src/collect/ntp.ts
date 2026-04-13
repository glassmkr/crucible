import { run } from "../lib/exec.js";

export interface NtpData {
  synced: boolean;
  offset_seconds: number;
  source: string;
  daemon_running: boolean;
  daemon_name: string;
}

// Check whether a systemd unit is active. Returns false for missing units, not-found, etc.
async function isUnitActive(unit: string): Promise<boolean> {
  const out = await run("systemctl", ["is-active", unit], 3000);
  return out?.trim() === "active";
}

// Detect which time-sync daemon unit is currently active on the host, if any.
// Returns "" when none are. We check the common names in order of preference.
async function detectActiveDaemon(): Promise<string> {
  const candidates = ["chrony", "chronyd", "systemd-timesyncd", "ntp", "ntpsec", "ntpd"];
  for (const unit of candidates) {
    if (await isUnitActive(unit)) return unit;
  }
  return "";
}

export async function collectNtp(): Promise<NtpData> {
  // The authoritative "is the daemon running" check is systemctl is-active,
  // not any derived flag from timedatectl. This catches daemon crashes and
  // manual stops where the kernel clock is still synced.
  const daemonName = await detectActiveDaemon();
  const daemonRunning = daemonName !== "";

  // Try timedatectl first (works for systemd-timesyncd and records the kernel
  // NTPSynchronized flag regardless of which daemon set it).
  const tdctl = await run("timedatectl", ["show", "--property=NTPSynchronized", "--value"]);
  if (tdctl !== null && (tdctl.trim() === "yes" || tdctl.trim() === "no")) {
    const synced = tdctl.trim() === "yes";

    let offset = 0;
    try {
      const tsStatus = await run("timedatectl", ["timesync-status"]);
      if (tsStatus) {
        const match = tsStatus.match(/Offset:\s*([+-]?\d+\.?\d*)(us|ms|s)/);
        if (match) {
          const val = parseFloat(match[1]);
          const unit = match[2];
          if (unit === "us") offset = val / 1_000_000;
          else if (unit === "ms") offset = val / 1000;
          else offset = val;
        }
      }
    } catch { /* offset stays 0 */ }

    // Prefer an explicitly detected daemon name; fall back to systemd-timesyncd
    // since timedatectl is most commonly the timesyncd frontend.
    const source = daemonName || "systemd-timesyncd";
    return { synced, offset_seconds: offset, source, daemon_running: daemonRunning, daemon_name: daemonName };
  }

  // Chrony tracking. Validate Leap status so we do not misread error text.
  const chronyOut = await run("chronyc", ["tracking"]);
  if (chronyOut) {
    const leapMatch = chronyOut.match(/Leap status\s*:\s*(.+)/);
    if (leapMatch) {
      const synced = leapMatch[1].trim() === "Normal";
      let offset = 0;
      const offsetMatch = chronyOut.match(/Last offset\s*:\s*([+-]?\d+\.?\d*)\s*seconds/);
      if (offsetMatch) offset = parseFloat(offsetMatch[1]);
      return {
        synced,
        offset_seconds: Math.abs(offset),
        source: daemonName || "chrony",
        daemon_running: daemonRunning,
        daemon_name: daemonName,
      };
    }
  }

  // ntpq peer table. Header check avoids false positives on error messages.
  const ntpqOut = await run("ntpq", ["-pn"]);
  if (ntpqOut) {
    const hasHeader = ntpqOut.split("\n").some((line) => line.includes("remote"));
    if (hasHeader) {
      const synced = ntpqOut.split("\n").some((line) => line.startsWith("*"));
      let offset = 0;
      const selectedLine = ntpqOut.split("\n").find((line) => line.startsWith("*"));
      if (selectedLine) {
        const fields = selectedLine.trim().split(/\s+/);
        if (fields.length >= 9) {
          const rawOffset = parseFloat(fields[8]);
          if (!isNaN(rawOffset)) offset = Math.abs(rawOffset) / 1000;
        }
      }
      return {
        synced,
        offset_seconds: offset,
        source: daemonName || "ntpd",
        daemon_running: daemonRunning,
        daemon_name: daemonName,
      };
    }
  }

  // No usable probe output. If systemd still reports a daemon as active, trust that;
  // otherwise report fully down.
  return {
    synced: false,
    offset_seconds: 0,
    source: daemonName || "none",
    daemon_running: daemonRunning,
    daemon_name: daemonName,
  };
}
