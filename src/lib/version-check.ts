import { CRUCIBLE_VERSION as CURRENT_VERSION } from "./version.js";
import {
  assertEndpointResolution,
  fetchPinnedEndpoint,
  validateEndpoint,
  type EndpointPolicy,
} from "./endpoint-policy.js";

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

export interface VersionCheckDeps {
  fetch: typeof fetch;
  resolveEndpoint: typeof assertEndpointResolution;
}

const defaultDeps: VersionCheckDeps = { fetch, resolveEndpoint: assertEndpointResolution };

export async function checkForUpdates(
  dashboardUrl?: string,
  policy: EndpointPolicy = { allowInsecure: false, allowedOrigins: [] },
  deps: VersionCheckDeps = defaultDeps,
): Promise<void> {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL) return;
  lastCheckTime = now;

  const url = dashboardUrl || "https://app.glassmkr.com";
  try {
    const initial = validateEndpoint(`${url.replace(/\/+$/, "")}/api/v1/version`, policy);
    const initialOrigin = initial.origin;
    let current = initial;
    let data: { crucible?: { latest?: string; min_supported?: string; changelog_url?: string } } | undefined;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
      const { response, dispatcher } = await fetchPinnedEndpoint(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      }, policy, deps.fetch, deps.resolveEndpoint);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        await dispatcher.close();
        if (!location) return;
        current = validateEndpoint(new URL(location, current).toString(), policy, initialOrigin);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        await dispatcher.close();
        return;
      }
      try {
        data = await response.json() as typeof data;
      } finally {
        await dispatcher.close();
      }
      break;
    }
    if (!data) return;
    const latest = data.crucible?.latest;
    if (!latest) return;

    if (isOlderVersion(CURRENT_VERSION, latest)) {
      console.log(`[update] New Crucible version available: ${latest} (current: ${CURRENT_VERSION})`);
      console.log(`[update] Changelog: ${data.crucible?.changelog_url || "https://github.com/glassmkr/crucible/releases"}`);
      console.log(`[update] Run: npm i -g @glassmkr/crucible && sudo glassmkr-crucible init && sudo systemctl restart glassmkr-crucible`);
    }
  } catch {
    // Version check is non-critical, fail silently
  }
}

export const __test_only = {
  reset: () => { lastCheckTime = 0; },
};
