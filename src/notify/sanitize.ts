export function boundedSingleLine(value: string, maxLength = 1000): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, maxLength);
}

export function boundedText(value: string, maxLength = 4000): string {
  return value.slice(0, maxLength);
}

export function escapeTelegramHtml(value: string): string {
  return boundedSingleLine(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeSlackMrkdwn(value: string): string {
  return boundedSingleLine(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\u2217")
    .replace(/_/g, "\uFF3F")
    .replace(/~/g, "\uFF5E")
    .replace(/`/g, "\u02CB");
}

export function containsHeaderBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

export function isValidMailbox(value: string): boolean {
  if (value.length > 254 || containsHeaderBreak(value)) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  return domain.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}
