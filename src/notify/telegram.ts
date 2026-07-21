import type { AlertResult } from "../lib/types.js";
import { escapeTelegramHtml } from "./sanitize.js";

const PRIORITY_MAP: Record<string, string> = {
  raid_degraded: "P1", smart_failing: "P1", ecc_errors: "P1", psu_redundancy_loss: "P1", ipmi_fan_failure: "P1",
  oom_kills: "P2", ram_high: "P2", disk_space_high: "P2", ipmi_sel_critical: "P2", disk_io_errors: "P2", zfs_pool_unhealthy: "P2",
  cpu_iowait_high: "P3", nvme_wear_high: "P3", disk_latency_high: "P3", cpu_temperature_high: "P3",
  ssh_root_password: "P3", ssh_config_unapplied: "P3", pending_security_updates: "P3", kernel_vulnerabilities: "P3", zfs_scrub_errors: "P3",
  swap_high: "P4", no_firewall: "P4", kernel_needs_reboot: "P4", unattended_upgrades_disabled: "P4",
  interface_errors: "P4", link_speed_mismatch: "P4", interface_saturation: "P4",
};

const PRIORITY_LABELS: Record<string, string> = {
  P1: "\u{1F534} P1 Urgent", P2: "\u{1F7E0} P2 High", P3: "\u{1F7E1} P3 Medium", P4: "\u{1F535} P4 Low",
};

export const TELEGRAM_TEXT_LIMIT = 4096;
const MAX_ALERTS_PER_MESSAGE = 50;
const MAX_SERVER_NAME_CHARS = 100;
const MAX_TITLE_CHARS = 200;
const MAX_RECOMMENDATION_CHARS = 400;

function getPriority(alertType: string): string {
  return PRIORITY_MAP[alertType] || "P3";
}

export async function sendTelegram(
  botToken: string,
  chatId: string,
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string
): Promise<boolean> {
  const message = buildTelegramMessage(newAlerts, resolvedAlerts, serverName);
  if (!message) return true;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    console.error("[telegram] Failed to send notification");
    return false;
  }
}

export function buildTelegramMessage(
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string,
): string {
  const parts: string[] = [];
  let length = 0;
  const append = (part: string): boolean => {
    const separator = parts.length === 0 ? "" : "\n";
    if (length + separator.length + part.length > TELEGRAM_TEXT_LIMIT) return false;
    parts.push(part);
    length += separator.length + part.length;
    return true;
  };
  const safeServerName = escapeTelegramHtml(serverName.slice(0, MAX_SERVER_NAME_CHARS));

  if (newAlerts.length > 0) {
    // Group by priority
    const byPriority: Record<string, AlertResult[]> = {};
    for (const a of newAlerts.slice(0, MAX_ALERTS_PER_MESSAGE)) {
      const p = getPriority(a.type);
      if (!byPriority[p]) byPriority[p] = [];
      byPriority[p].push(a);
    }

    priorityLoop: for (const p of ["P1", "P2", "P3", "P4"]) {
      const alerts = byPriority[p];
      if (!alerts?.length) continue;
      const blockFor = (a: AlertResult) => `  \u2022 <b>${escapeTelegramHtml(a.title.slice(0, MAX_TITLE_CHARS))}</b>\n  ${escapeTelegramHtml(a.recommendation.slice(0, MAX_RECOMMENDATION_CHARS))}`;
      const [first, ...rest] = alerts;
      if (!append(`${PRIORITY_LABELS[p]} on <b>${safeServerName}</b>:\n${blockFor(first)}`)) break;
      for (const a of rest) {
        if (!append(blockFor(a))) break priorityLoop;
      }
    }
  }

  if (resolvedAlerts.length > 0) {
    if (append(`\u2705 <b>${resolvedAlerts.length} resolved</b> on <b>${safeServerName}</b>:`)) {
      for (const a of resolvedAlerts.slice(0, MAX_ALERTS_PER_MESSAGE)) {
        if (!append(`  \u2022 ${escapeTelegramHtml(a.title.slice(0, MAX_TITLE_CHARS))}`)) break;
      }
    }
  }

  return parts.join("\n");
}
