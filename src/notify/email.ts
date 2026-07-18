import { execFile } from "child_process";
import { promisify } from "util";
import type { AlertResult } from "../lib/types.js";
import { CRUCIBLE_VERSION } from "../lib/version.js";
import { buildSubprocessEnv } from "../lib/exec.js";
import { boundedSingleLine, boundedText, containsHeaderBreak, isValidMailbox } from "./sanitize.js";

const execFileAsync = promisify(execFile);

export async function sendEmail(
  config: { to: string },
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string
): Promise<boolean> {
  const email = buildEmailMessage(config.to, newAlerts, resolvedAlerts, serverName);
  if (!email) {
    console.error("[email] Refusing invalid mailbox or header value");
    return false;
  }

  try {
    const child = execFileAsync("/usr/sbin/sendmail", ["-i", "--", config.to], {
      timeout: 10000,
      env: buildSubprocessEnv(),
    });
    child.child.stdin?.write(email);
    child.child.stdin?.end();
    await child;
    return true;
  } catch {
    console.error("[email] Failed to send. Is sendmail/postfix/msmtp installed?");
    return false;
  }
}

export function buildEmailMessage(
  to: string,
  newAlerts: AlertResult[],
  resolvedAlerts: AlertResult[],
  serverName: string,
): string | null {
  const from = "glassmkr-crucible@localhost";
  if (!isValidMailbox(to) || !isValidMailbox(from) || containsHeaderBreak(serverName)) return null;
  const subject = buildSubject(newAlerts, resolvedAlerts, boundedSingleLine(serverName, 200));
  if (containsHeaderBreak(subject)) return null;
  const body = buildBody(newAlerts, resolvedAlerts, boundedSingleLine(serverName, 200));
  return [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${boundedSingleLine(subject, 300)}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].join("\n");
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
    lines.push(`[${a.severity.toUpperCase()}] ${boundedText(a.title, 1000)}`);
    lines.push(boundedText(a.message));
    lines.push(`Action: ${boundedText(a.recommendation)}`);
    lines.push("");
  }

  for (const a of resolvedAlerts) {
    lines.push(`[RESOLVED] ${boundedText(a.title, 1000)}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`Glassmkr Crucible v${CRUCIBLE_VERSION}`);
  return lines.join("\n").slice(0, 64 * 1024);
}
