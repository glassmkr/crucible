import { CRUCIBLE_VERSION as CURRENT_VERSION } from "./version.js";

let lastCheckTime = 0;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // check every 6 hours

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

    if (latest !== CURRENT_VERSION) {
      console.log(`[update] New Crucible version available: ${latest} (current: ${CURRENT_VERSION})`);
      console.log(`[update] Changelog: ${data.crucible?.changelog_url || "https://github.com/glassmkr/crucible/releases"}`);
      console.log(`[update] Run: npm update -g @glassmkr/crucible && sudo systemctl restart glassmkr-crucible`);
    }
  } catch {
    // Version check is non-critical, fail silently
  }
}
