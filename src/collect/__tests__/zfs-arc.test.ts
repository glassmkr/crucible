// Tests for the ZFS ARC kstat collector. collectd parity close 2026-08-24.
//
// Fixture-path pattern (as in host-activity.test.ts). Known-bad cases
// FIRST (round-5 lesson): missing file (ZFS not loaded), missing rows,
// malformed values, first-cycle null ratio, counter reset, idle interval.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectZfsArc, __test_only } from "../zfs-arc.js";

let root: string;
let arcPath: string;

function arcstats(rows: Record<string, string | number>): string {
  const body = Object.entries(rows)
    .map(([k, v]) => `${k.padEnd(32)}4    ${v}`)
    .join("\n");
  return [
    "13 1 0x01 123 33456 8402944205 632568437854307",
    "name                            type data",
    body,
  ].join("\n") + "\n";
}

async function writeArc(content: string): Promise<void> {
  await fs.writeFile(arcPath, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "zfs-arc-test-"));
  arcPath = join(root, "arcstats");
  __test_only.resetForTests();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectZfsArc: capability gate (absent means not-loaded)", () => {
  it("returns null when the file is missing (no ZFS)", () => {
    expect(collectZfsArc(join(root, "no-such-file"))).toBeNull();
  });

  it("returns null when the file has none of the tracked rows", async () => {
    await writeArc(arcstats({ deleted: 42, mru_hits: 7 }));
    expect(collectZfsArc(arcPath)).toBeNull();
  });
});

describe("collectZfsArc: known-bad rows", () => {
  it("missing or malformed rows yield null per field, not zero", async () => {
    await writeArc(arcstats({ size: 832527096, c: "garbage", hits: 500 })); // misses absent
    const r = collectZfsArc(arcPath);
    expect(r).not.toBeNull();
    expect(r!.size_bytes).toBe(832527096);
    expect(r!.target_bytes).toBeNull();
    expect(r!.hits_total).toBe(500);
    expect(r!.misses_total).toBeNull();
    // Ratio needs both counters: null, never a guess.
    expect(r!.hit_ratio_pct).toBeNull();
  });
});

describe("collectZfsArc: interval hit ratio", () => {
  it("first cycle: sizes + totals present, ratio null", async () => {
    await writeArc(arcstats({ size: 832527096, c: 8321499136, hits: 519165, misses: 9787 }));
    const r = collectZfsArc(arcPath);
    expect(r!.size_bytes).toBe(832527096);
    expect(r!.target_bytes).toBe(8321499136);
    expect(r!.hits_total).toBe(519165);
    expect(r!.misses_total).toBe(9787);
    expect(r!.hit_ratio_pct).toBeNull();
  });

  it("second cycle: ratio from the interval deltas, not the totals", async () => {
    await writeArc(arcstats({ size: 1, c: 1, hits: 1_000_000, misses: 1_000_000 }));
    collectZfsArc(arcPath);
    // +90 hits, +10 misses this interval: 90% even though totals say 50%.
    await writeArc(arcstats({ size: 1, c: 1, hits: 1_000_090, misses: 1_000_010 }));
    const r = collectZfsArc(arcPath);
    expect(r!.hit_ratio_pct).toBe(90);
  });

  it("zero lookups in the interval: ratio null (no data is not 0% or 100%)", async () => {
    await writeArc(arcstats({ size: 1, c: 1, hits: 500, misses: 50 }));
    collectZfsArc(arcPath);
    const r = collectZfsArc(arcPath); // unchanged counters
    expect(r!.hit_ratio_pct).toBeNull();
  });

  it("counter reset (module reload): ratio null, then resumes", async () => {
    await writeArc(arcstats({ size: 1, c: 1, hits: 500, misses: 50 }));
    collectZfsArc(arcPath);
    await writeArc(arcstats({ size: 1, c: 1, hits: 10, misses: 0 })); // went backwards
    const r2 = collectZfsArc(arcPath);
    expect(r2!.hit_ratio_pct).toBeNull();
    await writeArc(arcstats({ size: 1, c: 1, hits: 40, misses: 10 }));
    const r3 = collectZfsArc(arcPath);
    expect(r3!.hit_ratio_pct).toBe(75); // 30 / 40
  });

  it("a one-cycle counter parse hiccup does not poison the next baseline", async () => {
    await writeArc(arcstats({ size: 1, c: 1, hits: 100, misses: 0 }));
    collectZfsArc(arcPath);
    // hits row malformed this cycle: totals null, ratio null, baseline kept.
    await writeArc(arcstats({ size: 1, c: 1, hits: "bogus", misses: 10 }));
    const r2 = collectZfsArc(arcPath);
    expect(r2!.hit_ratio_pct).toBeNull();
    // Counters readable again: delta is against the LAST GOOD pair.
    await writeArc(arcstats({ size: 1, c: 1, hits: 130, misses: 10 }));
    const r3 = collectZfsArc(arcPath);
    expect(r3!.hit_ratio_pct).toBe(75); // dHits 30, dMisses 10
  });
});
