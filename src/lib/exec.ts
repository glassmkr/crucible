import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type SubprocessEnv = Record<string, string | undefined>;

export function buildSubprocessEnv(extra: SubprocessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Backwards-compatible: existing callers get a string or null.
// The new runDetailed() returns stderr + exitCode + presence info so
// callers can distinguish "tool not installed" from "tool exited 0
// with empty stdout but errored to stderr". The latter is the silent-
// regression class that hid the v0.13.0 `retired_pages.double_bit_ecc`
// typo + the v0.13.2 `clocks_event_reasons` rename for ~24h each: in
// both cases nvidia-smi exited 0 with stderr saying "field not found"
// and Crucible's collectors processed empty stdout as "no data".
export async function run(
  cmd: string,
  args: string[],
  timeoutMs = 10000,
  extraEnv: SubprocessEnv = {},
): Promise<string | null> {
  const res = await runDetailed(cmd, args, timeoutMs, extraEnv);
  return res.installed && res.stdout !== null ? res.stdout : null;
}

export interface RunDetailedResult {
  installed: boolean; // false iff ENOENT
  exitCode: number | null; // null on timeout
  stdout: string | null; // may be empty string ""
  stderr: string;
  timedOut: boolean;
}

export async function runDetailed(
  cmd: string,
  args: string[],
  timeoutMs = 10000,
  extraEnv: SubprocessEnv = {},
): Promise<RunDetailedResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      env: buildSubprocessEnv(extraEnv),
    });
    return { installed: true, exitCode: 0, stdout, stderr: stderr ?? "", timedOut: false };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { installed: false, exitCode: null, stdout: null, stderr: "", timedOut: false };
    }
    if (err.killed) {
      return { installed: true, exitCode: null, stdout: null, stderr: "", timedOut: true };
    }
    return {
      installed: true,
      exitCode: typeof err.code === "number" ? err.code : null,
      stdout: typeof err.stdout === "string" ? err.stdout : null,
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      timedOut: false,
    };
  }
}

// Is `name` on PATH? Uses `which` (returns a path on stdout and exit 0
// when found, exit 1 / nothing when not). Shared by the hardware-raid and
// zfs collectors, which both gated CLI parsing on a `which` probe.
export async function which(name: string, timeoutMs = 2000): Promise<boolean> {
  const out = await run("which", [name], timeoutMs);
  return !!(out && out.trim());
}

// Is a systemd unit active? `systemctl is-active <unit>` prints "active"
// (and exits 0) when up, and a non-active state word otherwise. Shared by
// the ntp daemon detector and the gpu DCGM probe.
export async function isUnitActive(unit: string, timeoutMs = 3000): Promise<boolean> {
  const out = await run("systemctl", ["is-active", unit], timeoutMs);
  return out?.trim() === "active";
}

// Heuristic: does this stderr look like the "field/tag name not found"
// pattern that nvidia-smi (and others) emit when a query field has
// been renamed by a tool upgrade? Used by the gpu.ts collector's
// silent-no-op detector. The pattern is intentionally conservative:
// false positives degrade gracefully (an extra WARN log), false
// negatives are the original bug class we're trying to prevent.
export function looksLikeFieldRenameError(stderr: string): boolean {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  return (
    lower.includes("is not a valid field") ||
    lower.includes("unknown field") ||
    lower.includes("invalid field") ||
    lower.includes("no such field") ||
    lower.includes("not recognized") ||
    /<[a-z_]+>.*not found/.test(lower)
  );
}
