import type { AlertResult } from "../lib/types.js";
import { CRUCIBLE_VERSION } from "../lib/version.js";
import { escapeSlackMrkdwn } from "./sanitize.js";

export async function sendSlack(
  webhookUrl: string,
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string
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

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    console.error("[slack] Failed to send notification");
    return false;
  }
}
