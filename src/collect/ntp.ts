import { run } from "../lib/exec.js";

export interface NtpData {
  synced: boolean;
  offset_seconds: number;
  source: string;
  daemon_running: boolean;
}

export async function collectNtp(): Promise<NtpData> {
  // Try timedatectl first (systemd-timesyncd)
  const tdctl = await run("timedatectl", ["show", "--property=NTPSynchronized", "--value"]);
  if (tdctl !== null) {
    const synced = tdctl.trim() === "yes";
    // Get the source daemon name
    const statusOut = await run("timedatectl", ["show", "--property=NTP", "--value"]);
    const ntpEnabled = statusOut?.trim() === "yes";

    // Try to get offset from timedatectl timesync-status
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

    return {
      synced,
      offset_seconds: offset,
      source: "systemd-timesyncd",
      daemon_running: ntpEnabled || synced,
    };
  }

  // Try chrony
  const chronyOut = await run("chronyc", ["tracking"]);
  if (chronyOut) {
    const leapMatch = chronyOut.match(/Leap status\s*:\s*(.+)/);
    const synced = leapMatch ? leapMatch[1].trim() === "Normal" : false;
    let offset = 0;
    const offsetMatch = chronyOut.match(/Last offset\s*:\s*([+-]?\d+\.?\d*)\s*seconds/);
    if (offsetMatch) offset = parseFloat(offsetMatch[1]);
    return {
      synced,
      offset_seconds: Math.abs(offset),
      source: "chrony",
      daemon_running: true,
    };
  }

  // Try ntpq
  const ntpqOut = await run("ntpq", ["-pn"]);
  if (ntpqOut) {
    // A line starting with * means a selected peer (synced)
    const synced = ntpqOut.split("\n").some((line) => line.startsWith("*"));
    let offset = 0;
    // Parse offset from the selected peer line
    const selectedLine = ntpqOut.split("\n").find((line) => line.startsWith("*"));
    if (selectedLine) {
      const fields = selectedLine.trim().split(/\s+/);
      // offset is typically field 8 (in ms)
      if (fields.length >= 9) {
        const rawOffset = parseFloat(fields[8]);
        if (!isNaN(rawOffset)) offset = Math.abs(rawOffset) / 1000;
      }
    }
    return {
      synced,
      offset_seconds: offset,
      source: "ntpd",
      daemon_running: true,
    };
  }

  // No time sync daemon found
  return {
    synced: false,
    offset_seconds: 0,
    source: "none",
    daemon_running: false,
  };
}
