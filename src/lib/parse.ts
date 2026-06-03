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

export function parseKb(val: string | undefined): number {
  if (!val) return 0;
  const num = parseInt(val.replace(/\s*kB$/i, ""), 10);
  return isNaN(num) ? 0 : num;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
