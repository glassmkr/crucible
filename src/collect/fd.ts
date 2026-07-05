// File descriptor collection.
//
// Host-wide path (collectFileDescriptors): reads /proc/sys/fs/file-nr.
// Predates C7; still consumed by dashboard's host-wide fd_exhaustion path.
//
// Per-process path (collectProcessFd): reads /proc/<pid>/fd/ + /proc/<pid>/limits
// to surface processes approaching their RLIMIT_NOFILE soft limit. Per
// CC_SPEC_CRUCIBLE_C7_C10_NETWORK_PROCESS_COLLECTION_2026-05-19.md §1.
//
// Two-pass strategy: cheap readdir over /proc to count FDs per PID, then
// expensive read of limits + comm only for the top 50 consumers. Process-
// disappeared races are tolerated silently (ENOENT swallowed).

import { readdirSync } from "fs";

import { readFileTrim, readProcFile } from "../lib/parse.js";
import { runPrivileged } from "../lib/privileged.js";

export interface FileDescriptorData {
  allocated: number;
  free: number;
  max: number;
  percent: number;
}

export interface ProcessFdEntry {
  pid: number;
  comm: string;
  fd_count: number;
  rlimit_nofile_soft: number;
  rlimit_nofile_hard: number;
  percent_of_soft_limit: number;
}

export interface ProcessFdSnapshot {
  available: boolean;
  reason?: string;
  top_consumers: ProcessFdEntry[];
  total_processes_scanned: number;
  highest_percent_of_limit: number | null;
}

const TOP_N = 50;

export function collectFileDescriptors(): FileDescriptorData {
  const raw = readProcFile("/proc/sys/fs/file-nr");
  if (!raw) {
    return { allocated: 0, free: 0, max: 0, percent: 0 };
  }

  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) {
    return { allocated: 0, free: 0, max: 0, percent: 0 };
  }

  const allocated = parseInt(parts[0], 10);
  const free = parseInt(parts[1], 10);
  const max = parseInt(parts[2], 10);

  if (isNaN(allocated) || isNaN(max) || max === 0) {
    return { allocated: 0, free: 0, max: 0, percent: 0 };
  }

  const percent = Math.round(((allocated / max) * 100) * 10) / 10;
  return { allocated, free: isNaN(free) ? 0 : free, max, percent };
}

/**
 * Per-process FD scan. Prefers the privileged facade (`proc-fd`) so
 * root-owned processes are visible: running as the unprivileged `glassmkr`
 * service user, an in-process readdir on /proc/<root-pid>/fd returns EACCES,
 * so a root daemon leaking descriptors was silently skipped (found by the
 * validation-ladder Round F arming, 2026-07-05). The wrapper runs the scan as
 * root and returns it parseable.
 *
 * Falls back to the in-process scan when the privileged call returns null
 * (host still on User=root without the wrapper, or a wrapper-less non-root
 * agent) - identical behaviour to before, so this only ever ADDS visibility.
 */
export async function collectProcessFd(): Promise<ProcessFdSnapshot> {
  // 15s: the scan shells out over all of /proc; generous but bounded.
  const raw = await runPrivileged("proc-fd", [], 15000);
  if (raw !== null) {
    const parsed = parseProcFdOutput(raw);
    if (parsed) return parsed;
  }
  return scanProcessFdInProcess();
}

/** Parse the `proc-fd` wrapper output: a `SCANNED <n>` line followed by
 *  `pid|fd_count|soft hard|comm` lines (top consumers, pre-sorted). Returns
 *  null if the output has no usable data (so the caller falls back). */
export function parseProcFdOutput(raw: string): ProcessFdSnapshot | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let scanned = 0;
  const top_consumers: ProcessFdEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("SCANNED ")) {
      const n = Number(line.slice("SCANNED ".length).trim());
      if (Number.isInteger(n) && n >= 0) scanned = n;
      continue;
    }
    // pid|fd_count|soft hard|comm  (comm may contain spaces; limit split to 4)
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const fd_count = Number(parts[1]);
    const lim = parts[2].trim().split(/\s+/);
    const comm = parts.slice(3).join("|");
    if (!Number.isInteger(pid) || !Number.isInteger(fd_count)) continue;
    const soft = parseLimitValue(lim[0] ?? "");
    const hard = parseLimitValue(lim[1] ?? "");
    if (soft === null || hard === null) continue;
    const percent = soft > 0 ? Math.round((fd_count / soft) * 1000) / 10 : 0;
    top_consumers.push({ pid, comm, fd_count, rlimit_nofile_soft: soft, rlimit_nofile_hard: hard, percent_of_soft_limit: percent });
  }
  if (scanned === 0 && top_consumers.length === 0) return null;
  const highest = top_consumers.length > 0
    ? top_consumers.reduce((m, e) => (e.percent_of_soft_limit > m ? e.percent_of_soft_limit : m), 0)
    : null;
  return { available: true, top_consumers, total_processes_scanned: scanned, highest_percent_of_limit: highest };
}

/** In-process fallback scan (the pre-0.13.20 behaviour). Sees only the
 *  processes this uid can readdir - complete when run as root, partial as an
 *  unprivileged user without the wrapper. */
function scanProcessFdInProcess(): ProcessFdSnapshot {
  let pidNames: string[];
  try {
    pidNames = readdirSync("/proc");
  } catch (err) {
    return {
      available: false,
      reason: `/proc not accessible: ${errCode(err)}`,
      top_consumers: [],
      total_processes_scanned: 0,
      highest_percent_of_limit: null,
    };
  }

  // Cheap pass: just count FDs per numeric PID directory.
  const fdCounts: Array<{ pid: number; fd_count: number }> = [];
  let scanned = 0;
  for (const entry of pidNames) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    scanned++;
    try {
      const fds = readdirSync(`/proc/${pid}/fd`);
      fdCounts.push({ pid, fd_count: fds.length });
    } catch {
      // Process disappeared or no permission to read fd/; skip silently.
    }
  }

  // Top-N by fd_count.
  fdCounts.sort((a, b) => b.fd_count - a.fd_count);
  const candidates = fdCounts.slice(0, TOP_N);

  // Expensive pass: read comm + limits for the candidates.
  const top_consumers: ProcessFdEntry[] = [];
  for (const { pid, fd_count } of candidates) {
    const comm = readFileTrim(`/proc/${pid}/comm`);
    if (comm === null) continue; // Process disappeared.
    const limits = readFileTrim(`/proc/${pid}/limits`);
    if (limits === null) continue;
    const parsed = parseOpenFilesLimit(limits);
    if (!parsed) continue; // Malformed limits; skip.
    const { soft, hard } = parsed;
    const percent =
      soft > 0
        ? Math.round((fd_count / soft) * 1000) / 10
        : 0;
    top_consumers.push({
      pid,
      comm,
      fd_count,
      rlimit_nofile_soft: soft,
      rlimit_nofile_hard: hard,
      percent_of_soft_limit: percent,
    });
  }

  const highest =
    top_consumers.length > 0
      ? top_consumers.reduce(
          (m, e) => (e.percent_of_soft_limit > m ? e.percent_of_soft_limit : m),
          0,
        )
      : null;

  return {
    available: true,
    top_consumers,
    total_processes_scanned: scanned,
    highest_percent_of_limit: highest,
  };
}

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

/**
 * Parse the "Max open files" line from /proc/<pid>/limits.
 *
 * Format (fixed-width, header + rows):
 *   Limit                     Soft Limit           Hard Limit           Units
 *   Max open files            1024                 4096                 files
 *
 * Returns null when the line is missing or fields are unparseable.
 * "unlimited" maps to Infinity which Number.MAX_SAFE_INTEGER would
 * misrepresent; we use 0 as a sentinel meaning "no useful soft limit"
 * which makes percent_of_soft_limit zero (and the dashboard rule
 * treats that as a no-emission case).
 */
function parseOpenFilesLimit(
  raw: string,
): { soft: number; hard: number } | null {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("Max open files")) continue;
    // After the label there are at least two whitespace-separated values.
    const rest = line.slice("Max open files".length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 2) return null;
    const soft = parseLimitValue(parts[0]);
    const hard = parseLimitValue(parts[1]);
    if (soft === null || hard === null) return null;
    return { soft, hard };
  }
  return null;
}

function parseLimitValue(v: string): number | null {
  if (v === "unlimited") return 0; // sentinel; see parseOpenFilesLimit comment
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export const __test_only = {
  parseOpenFilesLimit,
  parseProcFdOutput,
  TOP_N,
};
