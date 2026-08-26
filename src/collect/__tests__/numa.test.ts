// Tests for the sysfs NUMA collector. collectd parity close 2026-08-24.
//
// Fixture-root pattern (as in cpufreq.test.ts) with a controlled clock
// for the rate fields. Known-bad cases FIRST (round-5 lesson): missing
// root, no nodeN dirs, missing/malformed meminfo and numastat lines,
// first-cycle null rates, counter reset.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectNuma, __test_only } from "../numa.js";

let root: string;

function meminfo(node: number, totalKb: number, freeKb: number): string {
  return [
    `Node ${node} MemTotal:       ${totalKb} kB`,
    `Node ${node} MemFree:        ${freeKb} kB`,
    `Node ${node} MemUsed:        ${totalKb - freeKb} kB`,
    `Node ${node} Active:         123456 kB`,
  ].join("\n") + "\n";
}

function numastat(hit: number, miss: number, foreign: number): string {
  return [
    `numa_hit ${hit}`,
    `numa_miss ${miss}`,
    `numa_foreign ${foreign}`,
    "interleave_hit 0",
    `local_node ${hit}`,
    "other_node 0",
  ].join("\n") + "\n";
}

async function writeNode(n: number, files: Record<string, string>): Promise<void> {
  const dir = join(root, `node${n}`);
  await fs.mkdir(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await fs.writeFile(join(dir, k), v);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "numa-test-"));
  __test_only.resetForTests();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectNuma: capability gate (absent means not-supported)", () => {
  it("returns null when the root does not exist", () => {
    expect(collectNuma(join(root, "no-such-root"), 1000)).toBeNull();
  });

  it("returns null when the root has no nodeN dirs", async () => {
    await fs.mkdir(join(root, "cpu0"), { recursive: true });
    expect(collectNuma(root, 1000)).toBeNull();
  });

  it("single node0 still emits: single-node is an answer, not an absence", async () => {
    await writeNode(0, { meminfo: meminfo(0, 1000, 400), numastat: numastat(50, 0, 0) });
    const r = collectNuma(root, 1000);
    expect(r).not.toBeNull();
    expect(r!.node_count).toBe(1);
    expect(r!.nodes[0].mem_total_kb).toBe(1000);
    // One readable node: imbalance is 0, not null.
    expect(r!.max_mem_used_imbalance_pct).toBe(0);
  });
});

describe("collectNuma: known-bad node files", () => {
  it("missing meminfo/numastat files yield null fields, node still listed", async () => {
    await fs.mkdir(join(root, "node0"), { recursive: true });
    const r = collectNuma(root, 1000);
    expect(r!.nodes[0]).toEqual({
      node: 0,
      mem_total_kb: null,
      mem_free_kb: null,
      numa_hit_total: null,
      numa_hit_rate: null,
      numa_miss_total: null,
      numa_miss_rate: null,
      numa_foreign_total: null,
      numa_foreign_rate: null,
    });
    expect(r!.max_mem_used_imbalance_pct).toBeNull();
  });

  it("malformed values are null, not zero; per-field independence holds", async () => {
    await writeNode(0, {
      meminfo: "Node 0 MemTotal:  garbage kB\nNode 0 MemFree:   500 kB\n",
      numastat: "numa_hit abc\nnuma_miss 7\n", // numa_foreign line absent
    });
    const r = collectNuma(root, 1000);
    const n = r!.nodes[0];
    expect(n.mem_total_kb).toBeNull();
    expect(n.mem_free_kb).toBe(500);
    expect(n.numa_hit_total).toBeNull();
    expect(n.numa_miss_total).toBe(7);
    expect(n.numa_foreign_total).toBeNull();
    // MemTotal unreadable on the only node: no imbalance computable.
    expect(r!.max_mem_used_imbalance_pct).toBeNull();
  });
});

describe("collectNuma: rates and imbalance", () => {
  it("first cycle: totals present, rates null", async () => {
    await writeNode(0, { meminfo: meminfo(0, 1000, 500), numastat: numastat(6000, 60, 6) });
    const r = collectNuma(root, 1_000_000);
    const n = r!.nodes[0];
    expect(n.numa_hit_total).toBe(6000);
    expect(n.numa_hit_rate).toBeNull();
    expect(n.numa_miss_rate).toBeNull();
    expect(n.numa_foreign_rate).toBeNull();
  });

  it("second cycle: per-second rates per node, keyed per node", async () => {
    await writeNode(0, { meminfo: meminfo(0, 1000, 500), numastat: numastat(6000, 60, 6) });
    await writeNode(1, { meminfo: meminfo(1, 1000, 500), numastat: numastat(1200, 0, 0) });
    collectNuma(root, 1_000_000);
    await writeNode(0, { numastat: numastat(9000, 120, 12) });
    await writeNode(1, { numastat: numastat(1800, 0, 0) });
    const r = collectNuma(root, 1_060_000); // +60s
    expect(r!.nodes[0].numa_hit_rate).toBe(50); // 3000 / 60
    expect(r!.nodes[0].numa_miss_rate).toBe(1); // 60 / 60
    expect(r!.nodes[0].numa_foreign_rate).toBe(0.1); // 6 / 60
    expect(r!.nodes[1].numa_hit_rate).toBe(10); // 600 / 60
  });

  it("counter reset (reboot) yields null rates, then resumes", async () => {
    await writeNode(0, { meminfo: meminfo(0, 1000, 500), numastat: numastat(6000, 60, 6) });
    collectNuma(root, 1_000_000);
    await writeNode(0, { numastat: numastat(100, 1, 0) }); // went backwards
    const r2 = collectNuma(root, 1_060_000);
    expect(r2!.nodes[0].numa_hit_rate).toBeNull();
    await writeNode(0, { numastat: numastat(700, 1, 0) });
    const r3 = collectNuma(root, 1_120_000);
    expect(r3!.nodes[0].numa_hit_rate).toBe(10); // 600 / 60
  });

  it("computes the max memory-use imbalance across nodes in percentage points", async () => {
    // node0 at 80% used, node1 at 30% used, node2 unreadable (skipped).
    await writeNode(0, { meminfo: meminfo(0, 1000, 200), numastat: numastat(1, 0, 0) });
    await writeNode(1, { meminfo: meminfo(1, 2000, 1400), numastat: numastat(1, 0, 0) });
    await fs.mkdir(join(root, "node2"), { recursive: true });
    const r = collectNuma(root, 1000);
    expect(r!.node_count).toBe(3);
    expect(r!.max_mem_used_imbalance_pct).toBe(50); // 80 - 30
  });

  it("orders nodes numerically (node10 after node2)", async () => {
    for (const n of [10, 2, 0]) {
      await writeNode(n, { meminfo: meminfo(n, 1000, 500), numastat: numastat(1, 0, 0) });
    }
    const r = collectNuma(root, 1000);
    expect(r!.nodes.map((x) => x.node)).toEqual([0, 2, 10]);
  });
});
