// Tests for the /proc/vmstat page-fault/scan/steal rate extension
// (collectd vmem parity close, 2026-08-24) plus the pre-existing
// swap-rate delta behavior, now drivable via the path + nowMs test
// hooks. Known-bad cases first (round-5 lesson): missing file, missing
// keys, malformed values, first-cycle null, counter reset.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectVmstat, __test_only } from "../vmstat.js";

let root: string;
let vmstatPath: string;

// Modern (6.x) shape: the reclaim-source counters AND the anon/file
// type-classification counters, which count the SAME scanned pages and
// must not be double-summed.
const MODERN = [
  "nr_free_pages 123456",
  "pswpin 100",
  "pswpout 200",
  "pgfault 1000000",
  "pgmajfault 5000",
  "pgscan_kswapd 40000",
  "pgscan_direct 2000",
  "pgscan_direct_throttle 3",
  "pgscan_khugepaged 100",
  "pgscan_anon 21050",
  "pgscan_file 21050",
  "pgsteal_kswapd 30000",
  "pgsteal_direct 1500",
  "pgsteal_khugepaged 50",
  "pgsteal_anon 15775",
  "pgsteal_file 15775",
].join("\n") + "\n";

async function writeVmstat(content: string): Promise<void> {
  await fs.writeFile(vmstatPath, content);
}

function bump(content: string, key: string, delta: number): string {
  return content.replace(new RegExp(`^${key} (\\d+)$`, "m"), (_, v) => `${key} ${Number(v) + delta}`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "vmstat-test-"));
  vmstatPath = join(root, "vmstat");
  __test_only.resetForTests();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectVmstat: known-bad inputs", () => {
  it("returns null when the file is missing", () => {
    expect(collectVmstat(join(root, "no-such-file"), 1000)).toBeNull();
  });

  it("returns null when the swap counters are absent (pre-existing gate)", async () => {
    await writeVmstat("nr_free_pages 1\npgfault 10\n");
    expect(collectVmstat(vmstatPath, 1000)).toBeNull();
  });

  it("omits a rate field entirely when its counter key is absent", async () => {
    await writeVmstat("pswpin 1\npswpout 2\npgfault 10\n");
    const r = collectVmstat(vmstatPath, 1000);
    expect(r).not.toBeNull();
    expect("pgfault_rate" in r!).toBe(true);
    expect(r!.pgfault_rate).toBeNull(); // answered, first cycle
    expect("pgmajfault_rate" in r!).toBe(false); // did not answer
    expect("pgscan_rate" in r!).toBe(false);
    expect("pgsteal_rate" in r!).toBe(false);
  });

  it("treats a malformed counter value as absent, not zero", async () => {
    await writeVmstat("pswpin 1\npswpout 2\npgfault abc\npgmajfault 7\n");
    const r = collectVmstat(vmstatPath, 1000);
    expect("pgfault_rate" in r!).toBe(false);
    expect("pgmajfault_rate" in r!).toBe(true);
  });
});

describe("collectVmstat: fault/scan/steal rates", () => {
  it("first cycle: totals present, all rates null", async () => {
    await writeVmstat(MODERN);
    const r = collectVmstat(vmstatPath, 1_000_000);
    expect(r!.pswpin_total).toBe(100);
    expect(r!.pswpout_total).toBe(200);
    expect(r!.pswpin_rate).toBeNull();
    expect(r!.pswpout_rate).toBeNull();
    expect(r!.pgfault_rate).toBeNull();
    expect(r!.pgmajfault_rate).toBeNull();
    expect(r!.pgscan_rate).toBeNull();
    expect(r!.pgsteal_rate).toBeNull();
  });

  it("second cycle: per-second rates; anon/file and throttle excluded from scan sums", async () => {
    await writeVmstat(MODERN);
    collectVmstat(vmstatPath, 1_000_000);
    let next = MODERN;
    next = bump(next, "pswpin", 120);
    next = bump(next, "pswpout", 180);
    next = bump(next, "pgfault", 6000);
    next = bump(next, "pgmajfault", 60);
    next = bump(next, "pgscan_kswapd", 600);
    next = bump(next, "pgscan_direct_throttle", 600); // must NOT count
    next = bump(next, "pgscan_anon", 600); // must NOT count
    next = bump(next, "pgscan_file", 600); // must NOT count
    next = bump(next, "pgsteal_direct", 300);
    next = bump(next, "pgsteal_anon", 300); // must NOT count
    await writeVmstat(next);
    const r = collectVmstat(vmstatPath, 1_060_000); // +60s
    expect(r!.pswpin_rate).toBe(2);
    expect(r!.pswpout_rate).toBe(3);
    expect(r!.pgfault_rate).toBe(100);
    expect(r!.pgmajfault_rate).toBe(1);
    expect(r!.pgscan_rate).toBe(10); // only pgscan_kswapd's +600
    expect(r!.pgsteal_rate).toBe(5); // only pgsteal_direct's +300
  });

  it("sums old per-zone pgscan_*/pgsteal_* variants", async () => {
    const oldShape = [
      "pswpin 0",
      "pswpout 0",
      "pgscan_kswapd_dma 100",
      "pgscan_kswapd_normal 300",
      "pgscan_direct_dma 20",
      "pgscan_direct_normal 80",
      "pgsteal_kswapd_normal 250",
      "pgsteal_direct_normal 50",
    ].join("\n") + "\n";
    await writeVmstat(oldShape);
    collectVmstat(vmstatPath, 1_000_000);
    let next = oldShape;
    next = bump(next, "pgscan_kswapd_normal", 500);
    next = bump(next, "pgscan_direct_dma", 100);
    next = bump(next, "pgsteal_kswapd_normal", 300);
    await writeVmstat(next);
    const r = collectVmstat(vmstatPath, 1_060_000);
    expect(r!.pgscan_rate).toBe(10); // (500 + 100) / 60
    expect(r!.pgsteal_rate).toBe(5); // 300 / 60
  });

  it("counter reset (reboot): all rates null, then resume next cycle", async () => {
    await writeVmstat(MODERN);
    collectVmstat(vmstatPath, 1_000_000);
    // Everything went backwards: reboot.
    const rebooted = [
      "pswpin 0",
      "pswpout 0",
      "pgfault 100",
      "pgmajfault 1",
      "pgscan_kswapd 10",
      "pgsteal_kswapd 5",
    ].join("\n") + "\n";
    await writeVmstat(rebooted);
    const r2 = collectVmstat(vmstatPath, 1_060_000);
    expect(r2!.pswpin_rate).toBeNull();
    expect(r2!.pgfault_rate).toBeNull();
    expect(r2!.pgscan_rate).toBeNull();
    expect(r2!.pgsteal_rate).toBeNull();
    // Rates resume against the post-reboot baseline.
    let next = rebooted;
    next = bump(next, "pgfault", 120);
    next = bump(next, "pgscan_kswapd", 60);
    await writeVmstat(next);
    const r3 = collectVmstat(vmstatPath, 1_120_000);
    expect(r3!.pgfault_rate).toBe(2);
    expect(r3!.pgscan_rate).toBe(1);
    expect(r3!.pswpin_rate).toBe(0);
  });

  it("non-positive elapsed interval yields null rates and keeps the baseline", async () => {
    await writeVmstat(MODERN);
    collectVmstat(vmstatPath, 1_000_000);
    const same = collectVmstat(vmstatPath, 1_000_000);
    expect(same!.pgfault_rate).toBeNull();
    // Baseline was NOT consumed: a later call still rates from t=1_000_000.
    await writeVmstat(bump(MODERN, "pgfault", 600));
    const r = collectVmstat(vmstatPath, 1_060_000);
    expect(r!.pgfault_rate).toBe(10);
  });
});
