const CURRENT_VERSION = "0.1.0";
let lastCheckTime = 0;
let lastResult: { updateAvailable: boolean; latest: string; changelog: string } | null = null;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // check every 6 hours

export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

export async function checkForUpdates(forgeUrl?: string): Promise<void> {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL) return;
  lastCheckTime = now;

  const url = forgeUrl || "https://forge.glassmkr.com";
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
      lastResult = { updateAvailable: true, latest, changelog: data.crucible?.changelog_url || "" };
    } else {
      lastResult = { updateAvailable: false, latest, changelog: "" };
    }
  } catch {
    // Version check is non-critical, fail silently
  }
}

export function getUpdateStatus() {
  return lastResult;
}
