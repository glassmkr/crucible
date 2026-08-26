// Tests for the sysfs cpufreq collector. collectd parity close 2026-08-24.
//
// Fixture-root pattern (as in thermal.test.ts): the collector takes a
// root dir so tests point it at a temp tree. Known-bad cases first
// (round-5 lesson): absent root, CPUs without cpufreq dirs, unreadable
// or malformed files.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectCpufreq } from "../cpufreq.js";

let root: string;

async function writeCpu(n: number, files: Record<string, string> | null): Promise<void> {
  const cpuDir = join(root, `cpu${n}`);
  await fs.mkdir(cpuDir, { recursive: true });
  if (files === null) return; // CPU dir without a cpufreq subdir
  const freqDir = join(cpuDir, "cpufreq");
  await fs.mkdir(freqDir, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await fs.writeFile(join(freqDir, k), v);
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cpufreq-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("collectCpufreq: capability gate (absent means not-supported)", () => {
  it("returns null when the root does not exist", () => {
    expect(collectCpufreq(join(root, "no-such-root"))).toBeNull();
  });

  it("returns null when no cpuN dir has a cpufreq subdir (VM shape)", async () => {
    await writeCpu(0, null);
    await writeCpu(1, null);
    expect(collectCpufreq(root)).toBeNull();
  });

  it("skips CPUs without a cpufreq dir instead of emitting all-null rows", async () => {
    await writeCpu(0, {
      scaling_cur_freq: "2200000\n",
      scaling_min_freq: "1500000\n",
      scaling_max_freq: "3700000\n",
      scaling_governor: "schedutil\n",
    });
    await writeCpu(1, null);
    const r = collectCpufreq(root);
    expect(r).not.toBeNull();
    expect(r!.cpus).toHaveLength(1);
    expect(r!.cpus[0].cpu).toBe(0);
  });
});

describe("collectCpufreq: readings and summary", () => {
  it("collects per-CPU freq + governor and a min/max/mean summary", async () => {
    await writeCpu(0, {
      scaling_cur_freq: "2200000\n",
      scaling_min_freq: "1500000\n",
      scaling_max_freq: "3700000\n",
      scaling_governor: "performance\n",
    });
    await writeCpu(1, {
      scaling_cur_freq: "3100000\n",
      scaling_min_freq: "1500000\n",
      scaling_max_freq: "3700000\n",
      scaling_governor: "performance\n",
    });
    const r = collectCpufreq(root);
    expect(r!.cpus).toHaveLength(2);
    expect(r!.cpus[0]).toEqual({
      cpu: 0, cur_khz: 2200000, min_khz: 1500000, max_khz: 3700000, governor: "performance",
    });
    expect(r!.cpus[1].cur_khz).toBe(3100000);
    expect(r!.cur_khz_min).toBe(2200000);
    expect(r!.cur_khz_max).toBe(3100000);
    expect(r!.cur_khz_mean).toBe(2650000);
  });

  it("orders CPUs numerically (cpu10 after cpu2)", async () => {
    for (const n of [10, 2, 0]) {
      await writeCpu(n, { scaling_cur_freq: `${1000000 + n}\n` });
    }
    const r = collectCpufreq(root);
    expect(r!.cpus.map((c) => c.cpu)).toEqual([0, 2, 10]);
  });

  it("malformed or missing per-CPU files yield null fields, not zero", async () => {
    await writeCpu(0, {
      scaling_cur_freq: "<unknown>\n", // malformed
      scaling_governor: "\n", // empty
      // scaling_min_freq / scaling_max_freq missing entirely
    });
    const r = collectCpufreq(root);
    expect(r).not.toBeNull();
    expect(r!.cpus[0]).toEqual({
      cpu: 0, cur_khz: null, min_khz: null, max_khz: null, governor: null,
    });
    // No readable cur_freq anywhere: summary is null, never zero.
    expect(r!.cur_khz_min).toBeNull();
    expect(r!.cur_khz_max).toBeNull();
    expect(r!.cur_khz_mean).toBeNull();
  });

  it("summary skips CPUs whose cur_freq is unreadable", async () => {
    await writeCpu(0, { scaling_cur_freq: "2000000\n" });
    await writeCpu(1, { scaling_governor: "powersave\n" }); // no cur_freq
    const r = collectCpufreq(root);
    expect(r!.cpus).toHaveLength(2);
    expect(r!.cur_khz_min).toBe(2000000);
    expect(r!.cur_khz_max).toBe(2000000);
    expect(r!.cur_khz_mean).toBe(2000000);
  });
});
