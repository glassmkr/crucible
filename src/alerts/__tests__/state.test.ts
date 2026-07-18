import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadAlertStateFile, saveAlertStateFile, updateAlertState, __test_only, type AlertState } from "../state.js";
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
});
