import { CRUCIBLE_VERSION as CURRENT_VERSION } from "./version.js";

let lastCheckTime = 0;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // check every 6 hours

/**
 * True when `current` is strictly older than `latest` (semver
 * major.minor.patch, numeric per-segment, tolerant of a leading "v").
 * Mirrors the dashboard's ServerCard `isOlderVersion`.
 *
 * Used so the daemon only announces a genuine upgrade. A plain `!==`
 * also fires when the host is NEWER than the dashboard-reported latest,
 * which happens transiently during a fleet roll (hosts upgraded before
 * the dashboard's FALLBACK_LATEST is bumped) and prints a misleading
 * "0.13.7 available (current: 0.13.8)" line.
 */
export function isOlderVersion(current: string, latest: string): boolean {
  const c = current.replace(/^v/, "").split(".").map(Number);
  const l = latest.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((c[i] || 0) < (l[i] || 0)) return true;
    if ((c[i] || 0) > (l[i] || 0)) return false;
  }
  return false;
}

export async function checkForUpdates(dashboardUrl?: string): Promise<void> {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL) return;
  lastCheckTime = now;

  const url = dashboardUrl || "https://app.glassmkr.com";
  try {
    const res = await fetch(`${url}/api/v1/version`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = await res.json() as { crucible?: { latest?: string; min_supported?: string; changelog_url?: string } };
    const latest = data.crucible?.latest;
    if (!latest) return;

    if (isOlderVersion(CURRENT_VERSION, latest)) {
      console.log(`[update] New Crucible version available: ${latest} (current: ${CURRENT_VERSION})`);
      console.log(`[update] Changelog: ${data.crucible?.changelog_url || "https://github.com/glassmkr/crucible/releases"}`);
      console.log(`[update] Run: npm update -g @glassmkr/crucible && sudo systemctl restart glassmkr-crucible`);
    }
  } catch {
    // Version check is non-critical, fail silently
  }
}
