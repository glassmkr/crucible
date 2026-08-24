// Tests for the /proc/stat host-activity collector (context switches,
// forks, procs_running, procs_blocked). collectd parity close 2026-08-24.
//
// The collector takes a path + nowMs test hook so these tests drive it
// against fixture files in a temp dir with a controlled clock, covering
// the known-bad cases FIRST (round-5 lesson): missing file, missing
// lines, malformed values, first-cycle null rates, counter reset.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectHostActivity, __test_only } from "../host-activity.js";

let root: string;
let statPath: string;

const FULL_STAT = [
  "cpu  74608 2520 24433 1117073 6176 4054 0 0 0 0",
  "cpu0 40602 1421 12222 560580 3103 2021 0 0 0 0",
  "cpu1 34006 1099 12211 556493 3073 2033 0 0 0 0",
  "intr 5017763 9 0 0 0 0 0 3 0 1 0 0 0 156 0 0 0",
  "ctxt 12000000",
  "btime 1755955200",
  "processes 68000",
  "procs_running 3",
  "procs_blocked 1",
  "softirq 4029005 5 1826269 3 400502 113209 0 4508 1135894",
].join("\n") + "\n";

async function writeStat(content: string): Promise<void> {
  await fs.writeFile(statPath, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "host-activity-test-"));
  statPath = join(root, "stat");
  __test_only.resetForTests();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectHostActivity: known-bad inputs", () => {
  it("returns null when the file is missing", () => {
    expect(collectHostActivity(join(root, "no-such-file"), 1000)).toBeNull();
  });

  it("returns null when no relevant lines exist (cpu lines only)", async () => {
    await writeStat("cpu  1 2 3 4 5 6 7 8 9 0\ncpu0 1 2 3 4 5 6 7 8 9 0\n");
    expect(collectHostActivity(statPath, 1000)).toBeNull();
  });

  it("reports null per field for missing lines, keeps the rest", async () => {
    // procs_blocked and processes lines absent; ctxt + procs_running present.
    await writeStat("ctxt 500\nprocs_running 2\n");
    const r = collectHostActivity(statPath, 1000);
    expect(r).not.toBeNull();
    expect(r!.context_switches_total).toBe(500);
    expect(r!.procs_running).toBe(2);
    expect(r!.forks_total).toBeNull();
    expect(r!.forks_rate).toBeNull();
    expect(r!.procs_blocked).toBeNull();
  });

  it("treats malformed values as absent (null), not zero", async () => {
    await writeStat("ctxt garbage\nprocesses 12\nprocs_running -3\nprocs_blocked 1\n");
    const r = collectHostActivity(statPath, 1000);
    expect(r).not.toBeNull();
    expect(r!.context_switches_total).toBeNull();
    // Negative counts are bogus for /proc/stat: rejected, not passed through.
    expect(r!.procs_running).toBeNull();
    expect(r!.forks_total).toBe(12);
    expect(r!.procs_blocked).toBe(1);
  });
});

describe("collectHostActivity: rate tracking", () => {
  it("first cycle: totals + current values present, rates null", async () => {
    await writeStat(FULL_STAT);
    const r = collectHostActivity(statPath, 1_000_000);
    expect(r).not.toBeNull();
    expect(r!.context_switches_total).toBe(12_000_000);
    expect(r!.forks_total).toBe(68_000);
    expect(r!.procs_running).toBe(3);
    expect(r!.procs_blocked).toBe(1);
    expect(r!.context_switches_rate).toBeNull();
    expect(r!.forks_rate).toBeNull();
  });

  it("second cycle: per-second rates over the elapsed interval", async () => {
    await writeStat(FULL_STAT);
    collectHostActivity(statPath, 1_000_000);
    await writeStat(FULL_STAT
      .replace("ctxt 12000000", "ctxt 12003000")
      .replace("processes 68000", "processes 68060"));
    const r = collectHostActivity(statPath, 1_060_000); // +60s
    expect(r!.context_switches_rate).toBe(50); // 3000 / 60
    expect(r!.forks_rate).toBe(1); // 60 / 60
  });

  it("counter reset (reboot): rates null again, then resume", async () => {
    await writeStat(FULL_STAT);
    collectHostActivity(statPath, 1_000_000);
    // Counters went backwards: host rebooted.
    await writeStat(FULL_STAT
      .replace("ctxt 12000000", "ctxt 100")
      .replace("processes 68000", "processes 10"));
    const r2 = collectHostActivity(statPath, 1_060_000);
    expect(r2!.context_switches_rate).toBeNull();
    expect(r2!.forks_rate).toBeNull();
    // Next cycle rates resume from the new baseline.
    await writeStat(FULL_STAT
      .replace("ctxt 12000000", "ctxt 700")
      .replace("processes 68000", "processes 40"));
    const r3 = collectHostActivity(statPath, 1_120_000);
    expect(r3!.context_switches_rate).toBe(10); // 600 / 60
    expect(r3!.forks_rate).toBe(0.5); // 30 / 60
  });

  it("non-positive elapsed interval yields null rates", async () => {
    await writeStat(FULL_STAT);
    collectHostActivity(statPath, 1_000_000);
    const r = collectHostActivity(statPath, 1_000_000); // same instant
    expect(r!.context_switches_rate).toBeNull();
    expect(r!.forks_rate).toBeNull();
  });
});
