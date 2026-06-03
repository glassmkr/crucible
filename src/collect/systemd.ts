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

import { run } from "../lib/exec.js";
import { parseEqualsKeyValue } from "../lib/parse.js";

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

export interface SystemdData {
  failed_units: string[];
  failed_count: number;
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
  const output = await run("systemctl", [
    "list-units", "--type=service", "--state=failed", "--no-legend", "--plain",
  ]);

  if (!output || output.trim() === "") {
    return { failed_units: [], failed_count: 0 };
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
  for (const unit of units) {
    journal_excerpts[unit] = await readJournalExcerpt(unit);
    failed_unit_details[unit] = await readUnitDetails(unit);
  }

  return {
    failed_units: units,
    failed_count: units.length,
    ...(units.length > 0 ? { journal_excerpts } : {}),
    ...(units.length > 0 ? { failed_unit_details } : {}),
  };
}

async function readJournalExcerpt(unit: string): Promise<string[]> {
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
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-JOURNAL_LINES_PER_UNIT);
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
};
