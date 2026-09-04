// `glassmkr-crucible --help` / `--version` must not touch the alert-state file.
//
// Observed 2026-09-04 on a 1.2.3 host: running --help as an unprivileged user
// printed two EACCES stack traces ("[state] Invalid alert state ...
// preserving it as ...corrupt-...") before the usage text. index.ts parses
// argv first in source order, but ESM hoists its static runtime imports, so
// alerts/state.js (which loads the state file at import) ran before the
// help check ever executed. The entry must decide help/version before any
// module with import-time side effects is loaded.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { STATE_FILE } = vi.hoisted(() => ({ STATE_FILE: "/var/lib/glassmkr/alert-state.json" }));

// Real fs everywhere except the state file, which is unreadable (EACCES), as
// it is for a non-root, non-service user on a real host.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const eacces = (syscall: string) => Object.assign(new Error(`EACCES: permission denied, ${syscall} '${STATE_FILE}'`), { code: "EACCES", errno: -13, syscall, path: STATE_FILE });
  return {
    ...actual,
    readFileSync: ((path: any, ...rest: any[]) => {
      if (String(path) === STATE_FILE) throw eacces("open");
      return (actual.readFileSync as any)(path, ...rest);
    }) as typeof actual.readFileSync,
    copyFileSync: ((src: any, ...rest: any[]) => {
      if (String(src) === STATE_FILE) throw eacces("copyfile");
      return (actual.copyFileSync as any)(src, ...rest);
    }) as typeof actual.copyFileSync,
  };
});

class ExitSentinel extends Error {
  constructor(public code: number | undefined) { super(`process.exit(${code})`); }
}

let originalArgv: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  originalArgv = process.argv;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new ExitSentinel(code); }) as never);
});
afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

async function runEntry(...args: string[]): Promise<number | undefined> {
  process.argv = ["node", "glassmkr-crucible", ...args];
  try {
    await import("../preflight.js");
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  }
  return undefined;
}

describe("CLI entry: help/version before any import-time side effect", () => {
  it("--help prints usage, exits 0, and never reads the alert-state file", async () => {
    const code = await runEntry("--help");
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("Usage:");
    const stderr = errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
    expect(stderr).not.toContain("[state]");
    expect(stderr).not.toContain("EACCES");
  });

  it("--version prints the version, exits 0, and never reads the alert-state file", async () => {
    const code = await runEntry("--version");
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/^glassmkr-crucible v\d+\.\d+\.\d+/m);
    const stderr = errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
    expect(stderr).not.toContain("[state]");
  });
});
