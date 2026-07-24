// systemd state collection.
//
// Pre-C12: failed_units + per-unit journal_excerpts.
// C12 (2026-05-19): per-failed-unit Result + ActiveState + SubState
// from `systemctl show`. Result is systemd's classifier for *why* a
// unit failed (oom-kill, watchdog, exit-code, timeout, ...). Dashboard
// uses it to set per-unit severity and to wire the
// systemd_service_oom_killed rule + service_flapping rule.
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §1.1.

import { run, runDetailed } from "../lib/exec.js";
import { parseEqualsKeyValue } from "../lib/parse.js";
import type { CollectorAvailability } from "../lib/availability.js";

export type SystemdUnitResult =
  | "success"
  | "protocol"
  | "timeout"
  | "exit-code"
  | "signal"
  | "core-dump"
  | "watchdog"
  | "start-limit-hit"
  | "resources"
  | "oom-kill"
  | "unknown";

export interface SystemdFailedUnit {
  name: string;
  /** systemd's failure-cause classifier from `systemctl show -p Result`.
   *  Unknown when the property is empty or the show command fails. */
  result: SystemdUnitResult;
  /** ActiveState from systemctl show. Typically "failed" when this unit
   *  is in this list, but kept for cross-checks. */
  active_state: string;
  /** SubState (more granular than ActiveState; e.g. "auto-restart"). */
  sub_state: string;
  /** NRestarts from systemctl show; cumulative since last successful
   *  start. Crude flapping signal — service_flapping rule's primary
   *  history source remains cross-snapshot, but this is the per-snap
   *  number a single emission carries. */
  n_restarts: number;
}

export interface SystemdData extends CollectorAvailability {
  failed_units: string[];
  failed_count: number | null;
  /** Last 5 journal lines per failed unit. Populated only when units
   *  are present so the happy path stays cheap. Keys match
   *  `failed_units`. Codex experiment 2026-05-12 P2; closes the
   *  "service failed -> what went wrong" seam without forcing the
   *  customer to SSH to the box. */
  journal_excerpts?: Record<string, string[]>;
  /** C12 structured per-unit failure metadata. Keys match
   *  `failed_units`; absent on pre-0.12.0 agents. Dashboard's TUNE
   *  + new rules consume `failed_unit_details[unit].result` etc. */
  failed_unit_details?: Record<string, SystemdFailedUnit>;
}

// Units commonly in failed state by design or misconfiguration
const DEFAULT_EXCLUDES = [
  "systemd-networkd-wait-online.service",
];

const JOURNAL_LINES_PER_UNIT = 5;
export const JOURNAL_MAX_LINE_CHARS = 512;
export const JOURNAL_MAX_TOTAL_CHARS = 4096;
const REDACTED = "[REDACTED]";
const SENSITIVE_QUERY_KEY = /^(?:pass(?:word|wd)?|pwd|api[_-]?key|apikey|access[_-]?(?:token|key)|refresh[_-]?token|auth(?:orization)?|credential|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|aws_secret_access_key|session|signature|sig|token|key|passphrase)$/i;

const RESULT_VALUES: ReadonlySet<SystemdUnitResult> = new Set([
  "success",
  "protocol",
  "timeout",
  "exit-code",
  "signal",
  "core-dump",
  "watchdog",
  "start-limit-hit",
  "resources",
  "oom-kill",
  "unknown",
]);

export async function collectSystemd(extraExcludes: string[] = []): Promise<SystemdData> {
  const result = await runDetailed("systemctl", [
    "list-units", "--type=service", "--state=failed", "--no-legend", "--plain",
  ]);
  if (!result.installed) {
    return { available: false, error: "systemctl is not installed", failed_units: [], failed_count: null };
  }
  if (result.timedOut) {
    return { available: false, error: "systemctl list-units timed out", failed_units: [], failed_count: null };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return {
      available: false,
      error: `systemctl list-units failed${detail ? `: ${detail}` : ""}`,
      failed_units: [],
      failed_count: null,
    };
  }
  const output = result.stdout ?? "";

  if (output.trim() === "") {
    return { available: true, failed_units: [], failed_count: 0 };
  }

  const excludes = new Set([...DEFAULT_EXCLUDES, ...extraExcludes]);
  const units: string[] = [];

  for (const line of output.trim().split("\n")) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit && unit.endsWith(".service") && !excludes.has(unit)) {
      units.push(unit);
    }
  }

  // For each failed unit, collect the last N journal lines + structured
  // properties (C12). Per-unit failure is tolerated (an unreadable
  // journal or a missing property doesn't drop the entire snapshot)
  // — we surface an empty journal array or `unknown` result for the
  // affected unit so the receiver knows we tried.
  const journal_excerpts: Record<string, string[]> = {};
  const failed_unit_details: Record<string, SystemdFailedUnit> = {};
  let journalBudget = JOURNAL_MAX_TOTAL_CHARS;
  for (const unit of units) {
    const excerpt = journalBudget > 0 ? await readJournalExcerpt(unit, journalBudget) : [];
    journal_excerpts[unit] = excerpt;
    journalBudget -= excerpt.reduce((sum, line) => sum + line.length, 0);
    failed_unit_details[unit] = await readUnitDetails(unit);
  }

  return {
    available: true,
    failed_units: units,
    failed_count: units.length,
    ...(units.length > 0 ? { journal_excerpts } : {}),
    ...(units.length > 0 ? { failed_unit_details } : {}),
  };
}

async function readJournalExcerpt(unit: string, budget: number): Promise<string[]> {
  // `--no-pager` so we don't block; `-n N` for the most recent N
  // lines; `-o cat` to drop the systemd-prefix metadata and keep
  // only the message body (cleaner display, less log volume on the
  // ingest path).
  const out = await run("journalctl", [
    "-u", unit,
    "--no-pager",
    "-n", String(JOURNAL_LINES_PER_UNIT),
    "-o", "cat",
  ]);
  if (!out) return [];
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-JOURNAL_LINES_PER_UNIT);
  return sanitizeJournalLines(lines, budget);
}

function redactUrlSecrets(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    const userinfo = url.username || url.password ? `${REDACTED}@` : "";
    if (userinfo) changed = true;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    const redactedSearch = url.search.replace(/%5BREDACTED%5D/gi, REDACTED);
    return changed
      ? `${url.protocol}//${userinfo}${url.host}${url.pathname}${redactedSearch}${url.hash}`
      : raw;
  } catch {
    return raw;
  }
}

export function redactJournalLine(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (url) => redactUrlSecrets(url))
    .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]+/gi, (_match, scheme, space) => `${scheme}${space}${REDACTED}`)
    // Prefix guard excludes letters/digits AND `-`, so `_`/`.` count as env-var
    // separators (DATABASE_PASSWORD, MY_API_KEY, x_secret_key redact) while a
    // hyphenated word like `hockey-key` and a suffix like `monkey` do not; the
    // required trailing `[:=]` also keeps `tokens=` from matching `token`.
    .replace(/((?:^|[^A-Za-z0-9-])["']?(?:password|passwd|pwd|token|key|apikey|api[_-]?key|x[_-]?api[_-]?key|passphrase|auth|authorization|access[_-]?(?:token|key)|refresh[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|aws_secret_access_key|session[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gim, (_match, prefix) => `${prefix}${REDACTED}`)
    .replace(/\bgmk_(?:acct|cru)_live_[A-Za-z0-9_]+\b/g, REDACTED)
    .replace(/\bcol_[A-Fa-f0-9]{16,}\b/g, REDACTED)
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
}

function truncateJournalLine(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const marker = "...[truncated]";
  if (limit <= marker.length) return marker.slice(0, limit);
  return `${line.slice(0, limit - marker.length)}${marker}`;
}

export function sanitizeJournalLines(lines: string[], totalBudget = JOURNAL_MAX_TOTAL_CHARS): string[] {
  const result: string[] = [];
  let remaining = Math.max(0, totalBudget);
  for (const raw of lines.slice(-JOURNAL_LINES_PER_UNIT)) {
    if (remaining === 0) break;
    const redacted = redactJournalLine(raw.trim());
    if (!redacted) continue;
    const line = truncateJournalLine(redacted, Math.min(JOURNAL_MAX_LINE_CHARS, remaining));
    result.push(line);
    remaining -= line.length;
  }
  return result;
}

/**
 * `systemctl show -p Property,Property,...` emits `Key=Value` lines.
 * One call per unit; lightweight. Best-effort; on parse failure
 * returns a record with unknown/empty fields so downstream code can
 * still rely on key presence.
 */
async function readUnitDetails(unit: string): Promise<SystemdFailedUnit> {
  const fallback: SystemdFailedUnit = {
    name: unit,
    result: "unknown",
    active_state: "",
    sub_state: "",
    n_restarts: 0,
  };
  const out = await run("systemctl", [
    "show", unit,
    "--no-pager",
    "--property=Result,ActiveState,SubState,NRestarts",
  ]);
  if (!out) return fallback;
  return parseUnitDetailsOutput(unit, out);
}

/**
 * Map a `systemctl show` `Key=Value` block to a SystemdFailedUnit.
 * Pure: no I/O. Unrecognized Result values collapse to "unknown";
 * a non-numeric NRestarts defaults to 0.
 */
function parseUnitDetailsOutput(unit: string, out: string): SystemdFailedUnit {
  const props = parseEqualsKeyValue(out);

  const rawResult = props.Result ?? "";
  const result: SystemdUnitResult = (RESULT_VALUES as Set<string>).has(rawResult)
    ? (rawResult as SystemdUnitResult)
    : "unknown";

  const nRestarts = Number.parseInt(props.NRestarts ?? "0", 10);

  return {
    name: unit,
    result,
    active_state: props.ActiveState ?? "",
    sub_state: props.SubState ?? "",
    n_restarts: Number.isFinite(nRestarts) ? nRestarts : 0,
  };
}

export const __test_only = {
  RESULT_VALUES,
  parseUnitDetailsOutput,
  redactUrlSecrets,
};
