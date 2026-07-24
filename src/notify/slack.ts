import type { AlertResult } from "../lib/types.js";
import { CRUCIBLE_VERSION } from "../lib/version.js";
import { escapeSlackMrkdwn } from "./sanitize.js";
import { assertEndpointResolution, fetchPinnedEndpoint, undiciFetchImpl, validateEndpoint, type EndpointPolicy } from "../lib/endpoint-policy.js";

export async function sendSlack(
  webhookUrl: string,
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string,
  policy: EndpointPolicy,
  fetchImpl: typeof fetch = undiciFetchImpl,
  resolveEndpoint: typeof assertEndpointResolution = assertEndpointResolution,
): Promise<boolean> {
  const blocks: any[] = [];

  if (newAlerts.length > 0) {
    const criticals = newAlerts.filter((a) => a.severity === "critical");
    const warnings = newAlerts.filter((a) => a.severity === "warning");

    if (criticals.length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `\u{1F534} *${criticals.length} CRITICAL* on *${escapeSlackMrkdwn(serverName)}*` } });
      for (const a of criticals.slice(0, 20)) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeSlackMrkdwn(a.title)}*\n${escapeSlackMrkdwn(a.recommendation)}` } });
    }
    if (warnings.length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `\u{1F7E1} *${warnings.length} WARNING* on *${escapeSlackMrkdwn(serverName)}*` } });
      for (const a of warnings.slice(0, 20)) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeSlackMrkdwn(a.title)}*\n${escapeSlackMrkdwn(a.recommendation)}` } });
    }
  }

  if (resolvedAlerts.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `\u2705 *${resolvedAlerts.length} resolved* on *${escapeSlackMrkdwn(serverName)}*` } });
  }

  if (blocks.length === 0) return true;

  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Glassmkr Crucible v${CRUCIBLE_VERSION}` }] });

  // Route the operator webhook through the endpoint policy (HTTPS + no private
  // destinations unless explicitly opted in) with a pinned connection and no
  // auto-followed redirects, so a stale/mis-supplied webhook cannot become an SSRF.
  let target: URL;
  try {
    target = validateEndpoint(webhookUrl, policy);
  } catch (err) {
    console.error(`[slack] Refusing webhook endpoint: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  try {
    const { response, dispatcher } = await fetchPinnedEndpoint(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    }, policy, fetchImpl, resolveEndpoint);
    try {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        console.error("[slack] Refusing redirected webhook response");
        return false;
      }
      return response.ok;
    } finally {
      await dispatcher.close();
    }
  } catch {
    console.error("[slack] Failed to send notification");
    return false;
  }
}
