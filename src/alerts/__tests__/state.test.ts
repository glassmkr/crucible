import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// An unreadable (EACCES) state file is simulated through a delegating fs mock
// rather than chmod 000, which root reads regardless. Everything else hits the
// real fs so the temp-dir tests below are unaffected.
const { UNREADABLE, copyFileSpy } = vi.hoisted(() => ({
  UNREADABLE: "/__unreadable__/alert-state.json",
  copyFileSpy: vi.fn<(src: string) => void>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: any, ...rest: any[]) => {
      if (String(path) === UNREADABLE) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${UNREADABLE}'`), { code: "EACCES", errno: -13, syscall: "open", path: UNREADABLE });
      }
      return (actual.readFileSync as any)(path, ...rest);
    }) as typeof actual.readFileSync,
    copyFileSync: ((src: any, ...rest: any[]) => {
      copyFileSpy(String(src));
      if (String(src) === UNREADABLE) {
        throw Object.assign(new Error(`EACCES: permission denied, copyfile '${UNREADABLE}'`), { code: "EACCES", errno: -13, syscall: "copyfile", path: UNREADABLE });
      }
      return (actual.copyFileSync as any)(src, ...rest);
    }) as typeof actual.copyFileSync,
  };
});

import { loadAlertStateFile, MAX_CORRUPT_STATE_BACKUPS, saveAlertStateFile, updateAlertState, __test_only, type AlertState } from "../state.js";
import type { AlertResult } from "../../lib/types.js";

function alert(type: string, instance?: string): AlertResult {
  return {
    type,
    instance,
    severity: "critical",
    title: instance ? `${type} ${instance}` : type,
    message: "",
    evidence: {},
    recommendation: "",
  };
}

describe("updateAlertState per-resource keying", () => {
  beforeEach(() => __test_only.reset());

  it("treats a second failing resource of the same type as new (Codex #1)", () => {
    const first = updateAlertState([alert("smart_failing", "/dev/sda")]);
    expect(first.newAlerts.map((a) => a.instance)).toEqual(["/dev/sda"]);

    // /dev/sdb starts failing while /dev/sda is still failing. Keying by type
    // alone would treat this as already-known and never notify; it must fire.
    const second = updateAlertState([
      alert("smart_failing", "/dev/sda"),
      alert("smart_failing", "/dev/sdb"),
    ]);
    expect(second.newAlerts.map((a) => a.instance)).toEqual(["/dev/sdb"]);
    expect(second.resolvedAlerts).toHaveLength(0);
  });

  it("resolves one resource without disturbing the other", () => {
    updateAlertState([
      alert("smart_failing", "/dev/sda"),
      alert("smart_failing", "/dev/sdb"),
    ]);
    // /dev/sda recovers; /dev/sdb still failing.
    const r = updateAlertState([alert("smart_failing", "/dev/sdb")]);
    expect(r.newAlerts).toHaveLength(0);
    expect(r.resolvedAlerts).toHaveLength(1);
    expect(r.resolvedAlerts[0].type).toBe("smart_failing");
    expect(r.resolvedAlerts[0].instance).toBe("/dev/sda");
  });

  it("singleton alerts (no instance) still dedupe by type", () => {
    const first = updateAlertState([alert("no_firewall")]);
    expect(first.newAlerts).toHaveLength(1);
    // Same singleton next cycle: not new, not resolved.
    const second = updateAlertState([alert("no_firewall")]);
    expect(second.newAlerts).toHaveLength(0);
    expect(second.resolvedAlerts).toHaveLength(0);
  });

  it("does not collapse different instances into one resolve", () => {
    updateAlertState([
      alert("interface_errors", "eth0"),
      alert("interface_errors", "eth1"),
    ]);
    // Both clear at once: two distinct resolves, not one.
    const r = updateAlertState([]);
    expect(r.resolvedAlerts).toHaveLength(2);
    expect(new Set(r.resolvedAlerts.map((a) => a.instance))).toEqual(
      new Set(["eth0", "eth1"]),
    );
  });
});

describe("alert state persistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crucible-alert-state-"));
    path = join(dir, "alert-state.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function value(lastSeen: string): Map<string, AlertState> {
    return new Map([["disk_space_high", {
      type: "disk_space_high",
      first_seen: "2026-01-01T00:00:00.000Z",
      last_seen: lastSeen,
      notified: false,
    }]]);
  }

  it("writes mode 0600 through a temporary file and atomically replaces state", () => {
    saveAlertStateFile(path, value("first"));
    saveAlertStateFile(path, value("second"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).disk_space_high.last_seen).toBe("second");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("preserves a corrupt state file instead of silently discarding it", () => {
    writeFileSync(path, "{broken", { mode: 0o600 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadAlertStateFile(path).size).toBe(0);
    const backup = readdirSync(dir).find((name) => name.includes(".corrupt-"));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(dir, backup!), "utf8")).toBe("{broken");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps only the newest corrupt-state backups", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let timestamp = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => timestamp++);
    writeFileSync(path, "{broken", { mode: 0o600 });

    for (let i = 0; i < MAX_CORRUPT_STATE_BACKUPS + 3; i++) loadAlertStateFile(path);

    const backups = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(MAX_CORRUPT_STATE_BACKUPS);
    expect(backups.some((name) => name.includes("1700000000000"))).toBe(false);
    error.mockRestore();
  });
});

// An unreadable file is not a corrupt file. On 2026-09-04 an EACCES from a
// root-owned state file (CLI run as an unprivileged user) was logged as
// "Invalid alert state" and a copy to a .corrupt-* backup was attempted; both
// are wrong for a permission error, which says nothing about the content.
describe("loadAlertStateFile on an unreadable file (EACCES)", () => {
  it("does not label it corrupt and does not attempt a corrupt-backup copy", () => {
    copyFileSpy.mockClear();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = loadAlertStateFile(UNREADABLE);
      expect(result.size).toBe(0);
      const stderr = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(stderr).not.toContain("Invalid alert state");
      expect(stderr).not.toContain("corrupt");
      expect(copyFileSpy).not.toHaveBeenCalledWith(UNREADABLE);
    } finally {
      errSpy.mockRestore();
    }
  });
});
