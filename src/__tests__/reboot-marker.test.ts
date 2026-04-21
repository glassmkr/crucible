import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, statSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeRebootMarker,
  writeRebootMarker,
  parseDuration,
} from "../lib/reboot-marker.js";
import { parseCliArgs } from "../cli.js";

let tmpDir: string;
let path: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crucible-test-"));
  path = join(tmpDir, "reboot-expected");
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("consumeRebootMarker", () => {
  it("7. marker present, not expired: returns flag, deletes file", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(path, JSON.stringify({ expires_at: future, reason: "kernel update" }));
    const out = consumeRebootMarker(path);
    expect(out).toEqual({ expected: true, reason: "kernel update" });
    expect(existsSync(path)).toBe(false);
  });

  it("8. marker present, expired: returns null, deletes file", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, JSON.stringify({ expires_at: past, reason: "stale" }));
    expect(consumeRebootMarker(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("9. marker absent: returns null, no throw", () => {
    expect(consumeRebootMarker(path)).toBeNull();
  });

  it("15. malformed JSON: returns null, file deleted, no crash", () => {
    writeFileSync(path, "{not json at all");
    expect(consumeRebootMarker(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("invalid expires_at (missing): returns null, file deleted", () => {
    writeFileSync(path, JSON.stringify({ reason: "oops" }));
    expect(consumeRebootMarker(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("consumed marker cannot be re-read (single-use)", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(path, JSON.stringify({ expires_at: future }));
    expect(consumeRebootMarker(path)).not.toBeNull();
    expect(consumeRebootMarker(path)).toBeNull();
  });
});

describe("writeRebootMarker", () => {
  it("13. writes file at given path with correct TTL and reason, 0600 mode", () => {
    const now = new Date("2026-04-21T22:00:00Z");
    const res = writeRebootMarker({ path, reason: "kernel update", ttlMs: 10 * 60_000, now });
    expect(res.path).toBe(path);
    expect(res.expires_at).toBe("2026-04-21T22:10:00.000Z");
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const round = consumeRebootMarker(path, new Date("2026-04-21T22:05:00Z"));
    expect(round).toEqual({ expected: true, reason: "kernel update" });
  });

  it("default TTL is 10 minutes", () => {
    const now = new Date("2026-04-21T22:00:00Z");
    const res = writeRebootMarker({ path, now });
    expect(res.expires_at).toBe("2026-04-21T22:10:00.000Z");
  });
});

describe("parseDuration", () => {
  it.each([
    ["10m", 600_000],
    ["2h", 7_200_000],
    ["600s", 600_000],
    ["500ms", 500],
    ["30", 30_000], // bare number -> seconds
  ])("%s -> %d ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });
  it("rejects garbage", () => {
    expect(parseDuration("forever")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("CLI parseCliArgs subcommands", () => {
  it("14. `reboot` subcommand captured with flags", () => {
    const { result } = parseCliArgs(["reboot", "--reason", "kernel update"], "1.0.0");
    expect(result.mode).toBe("reboot");
    expect(result.reason).toBe("kernel update");
  });
  it("`mark-reboot` with --ttl parsed through", () => {
    const { result } = parseCliArgs(["mark-reboot", "--ttl=5m", "--reason=test"], "1.0.0");
    expect(result.mode).toBe("mark-reboot");
    expect(result.ttl).toBe("5m");
    expect(result.reason).toBe("test");
  });
  it("`mark-reboot --help` returns help output without running", () => {
    const { result, output } = parseCliArgs(["mark-reboot", "--help"], "1.0.0");
    expect(result.mode).toBe("help");
    expect(output).toContain("mark-reboot");
  });
  it("top-level help lists the new subcommands", () => {
    const { output } = parseCliArgs(["--help"], "1.0.0");
    expect(output).toMatch(/mark-reboot/);
    expect(output).toMatch(/reboot/);
  });
});
