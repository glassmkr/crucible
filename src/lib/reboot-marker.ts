// Planned-reboot marker handling.
//
// An operator signals "the next reboot is expected, don't page me"
// by writing a short-lived JSON file to disk BEFORE rebooting. The
// collector reads and deletes it on agent startup; the first
// post-boot snapshot then carries `expected_reboot: true` so Forge's
// unexpected_reboot rule stays quiet.
//
// Single-use (deleted on read regardless of validity) and TTL-guarded
// (default 10 min) so a forgotten marker cannot silence a genuine
// crash reboot weeks later.

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_MARKER_PATH = "/var/lib/crucible/reboot-expected";
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface PlannedReboot {
  expected: true;
  reason?: string;
}

export interface RebootMarker {
  expires_at: string; // ISO timestamp
  reason?: string;
}

/**
 * Read and delete the marker at `path`. Returns the resolved reboot flag
 * if the file existed, was parseable JSON, and hasn't expired; otherwise
 * returns null. The file is unlinked in every branch where it existed,
 * so a malformed or stale marker is one-shot (can't linger).
 */
export function consumeRebootMarker(
  path: string = DEFAULT_MARKER_PATH,
  now: Date = new Date(),
): PlannedReboot | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { try { unlinkSync(path); } catch {} return null; }
  // Always delete after read, regardless of validity.
  try { unlinkSync(path); } catch {}

  let parsed: RebootMarker;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || typeof parsed.expires_at !== "string") return null;
  const expiresAt = new Date(parsed.expires_at);
  if (isNaN(expiresAt.getTime())) return null;
  if (expiresAt.getTime() <= now.getTime()) return null; // stale
  return { expected: true, reason: parsed.reason };
}

/**
 * Write a planned-reboot marker. Used by the `mark-reboot` and `reboot`
 * CLI subcommands. `ttlMs` defaults to 10 minutes. Creates the parent
 * directory if needed. Chmod 600 so other users on the host can't read
 * or modify it.
 */
export function writeRebootMarker(opts: {
  reason?: string;
  ttlMs?: number;
  path?: string;
  now?: Date;
}): { path: string; expires_at: string } {
  const path = opts.path ?? DEFAULT_MARKER_PATH;
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const body: RebootMarker = { expires_at: expiresAt.toISOString() };
  if (opts.reason) body.reason = opts.reason;
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch {}
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  return { path, expires_at: body.expires_at };
}

/** Parse a duration like "10m", "2h", "600s" into milliseconds. Used by
 *  the CLI for the `--ttl` flag. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] ?? "s";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return n * mult;
}
