import { execFile } from "child_process";
import { promisify } from "util";
import type { AlertResult } from "../lib/types.js";
import { CRUCIBLE_VERSION } from "../lib/version.js";

const execFileAsync = promisify(execFile);

export async function sendEmail(
  config: { to: string },
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string
): Promise<boolean> {
  if (!config.to) return false;

  const subject = buildSubject(newAlerts, resolvedAlerts, serverName);
  const body = buildBody(newAlerts, resolvedAlerts, serverName);

  const email = [
    `To: ${config.to}`,
    `From: glassmkr-crucible@${serverName}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].join("\n");

  try {
    const child = execFileAsync("/usr/sbin/sendmail", ["-t"], { timeout: 10000 });
    child.child.stdin?.write(email);
    child.child.stdin?.end();
    await child;
    return true;
  } catch {
    console.error("[email] Failed to send. Is sendmail/postfix/msmtp installed?");
    return false;
  }
}

function buildSubject(newAlerts: AlertResult[], resolvedAlerts: AlertResult[], serverName: string): string {
  if (newAlerts.length > 0) {
    const worst = newAlerts.find((a) => a.severity === "critical") ? "CRITICAL" : "WARNING";
    return `[${worst}] ${serverName}: ${newAlerts.length} alert(s)`;
  }
  return `[RESOLVED] ${serverName}: ${resolvedAlerts.length} alert(s) cleared`;
}

function buildBody(newAlerts: AlertResult[], resolvedAlerts: AlertResult[], serverName: string): string {
  const lines: string[] = [];
  lines.push(`Server: ${serverName}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push("");

  for (const a of newAlerts) {
    lines.push(`[${a.severity.toUpperCase()}] ${a.title}`);
    lines.push(a.message);
    lines.push(`Action: ${a.recommendation}`);
    lines.push("");
  }

  for (const a of resolvedAlerts) {
    lines.push(`[RESOLVED] ${a.title}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`Glassmkr Crucible v${CRUCIBLE_VERSION}`);
  return lines.join("\n");
}
