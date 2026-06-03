import { readFileSync, readdirSync } from "fs";

export function readProcFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// Read a file and return its trimmed contents, or null if it can't be
// read. Empty/whitespace-only files yield "" (not null); callers that
// treat empty as absent append `|| null`. Shared by the dmi/thermal/edac
// collectors and the per-process fd scan, which all had byte-equivalent
// private copies of this read.
export function readFileTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

// Read a file expected to hold a single non-negative integer (the common
// /sys counter shape). Returns null on read failure or when the trimmed
// contents are not all digits. Mirrors edac.ts's former readUint.
export function readFileInt(path: string): number | null {
  const s = readFileTrim(path);
  if (s === null || !/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// List a directory, returning [] on any error (missing dir, EACCES, etc.).
// Callers that need to distinguish "looked but empty" from "couldn't look"
// must keep their own try/catch instead.
export function readDirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function parseKeyValue(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

// `Key=Value` block parser (the `=`-delimited cousin of parseKeyValue).
// Used by `systemctl show` output. Splits on the first `=` per line so
// values containing `=` survive intact; lines without `=` are skipped.
// Keys and values are trimmed. Shared by the systemd collector, which
// previously inlined this loop (twice).
export function parseEqualsKeyValue(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

// Parse the prefixed two-line header+values shape of /proc/net/snmp and
// /proc/net/netstat sections (e.g. `Tcp:` / `TcpExt:`). The first line
// starting with `prefix` supplies the column names; the second supplies
// the values. The prefix token is stripped from both lines before the
// remainder is whitespace-split. Values are parsed in base 10 via
// Number(). Returns a record of the requested columns, or null if the
// section/value-row is missing, a requested column is absent from the
// header, or any requested value is non-finite (all-or-nothing, matching
// the tcp-stats callers' strictness).
export function parseColumnarStat(
  raw: string,
  prefix: string,
  wantedCols: string[],
): Record<string, number> | null {
  const lines = raw.split("\n");
  let header: string[] | null = null;
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const fields = line.slice(prefix.length).trim().split(/\s+/);
    if (!header) {
      header = fields;
      continue;
    }
    // This is the value row.
    const out: Record<string, number> = {};
    for (const col of wantedCols) {
      const idx = header.indexOf(col);
      if (idx === -1) return null;
      const value = Number(fields[idx]);
      if (!Number.isFinite(value)) return null;
      out[col] = value;
    }
    return out;
  }
  return null;
}

export function parseKb(val: string | undefined): number {
  if (!val) return 0;
  const num = parseInt(val.replace(/\s*kB$/i, ""), 10);
  return isNaN(num) ? 0 : num;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
