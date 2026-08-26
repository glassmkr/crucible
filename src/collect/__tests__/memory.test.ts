// Tests for /proc/meminfo parsing, including the hugepages close
// (collectd parity, 2026-08-24). parseMeminfo is the pure parser
// collectMemory feeds with the real file.

import { describe, it, expect } from "vitest";
import { parseMeminfo } from "../memory.js";

const BASE_MEMINFO = [
  "MemTotal:       65536000 kB",
  "MemFree:         8192000 kB",
  "MemAvailable:   32768000 kB",
  "Buffers:          409600 kB",
  "Cached:         20480000 kB",
  "SwapTotal:       4194304 kB",
  "SwapFree:        4194304 kB",
];

describe("parseMeminfo: base fields", () => {
  it("computes mb totals from kB lines", () => {
    const m = parseMeminfo(BASE_MEMINFO.join("\n") + "\n");
    expect(m.total_mb).toBe(64000);
    expect(m.free_mb).toBe(8000);
    expect(m.available_mb).toBe(32000);
    expect(m.used_mb).toBe(32000);
    expect(m.swap_total_mb).toBe(4096);
    expect(m.swap_used_mb).toBe(0);
  });
});

describe("parseMeminfo: hugepages gate (lean snapshots)", () => {
  it("omits hugepages when HugePages_Total is 0", () => {
    const m = parseMeminfo([...BASE_MEMINFO,
      "HugePages_Total:       0",
      "HugePages_Free:        0",
      "HugePages_Rsvd:        0",
      "Hugepagesize:       2048 kB",
    ].join("\n") + "\n");
    expect(m.hugepages).toBeUndefined();
  });

  it("omits hugepages when the lines are absent entirely", () => {
    const m = parseMeminfo(BASE_MEMINFO.join("\n") + "\n");
    expect(m.hugepages).toBeUndefined();
  });

  it("emits absolute values when a pool is configured", () => {
    const m = parseMeminfo([...BASE_MEMINFO,
      "HugePages_Total:     512",
      "HugePages_Free:      500",
      "HugePages_Rsvd:       12",
      "HugePages_Surp:        0",
      "Hugepagesize:       2048 kB",
    ].join("\n") + "\n");
    expect(m.hugepages).toEqual({
      total: 512,
      free: 500,
      reserved: 12,
      page_size_kb: 2048,
    });
  });

  it("reports null (not zero) for hugepage lines the kernel did not emit", () => {
    const m = parseMeminfo([...BASE_MEMINFO,
      "HugePages_Total:     512",
      // HugePages_Free / HugePages_Rsvd / Hugepagesize absent
    ].join("\n") + "\n");
    expect(m.hugepages).toEqual({
      total: 512,
      free: null,
      reserved: null,
      page_size_kb: null,
    });
  });

  it("treats a malformed HugePages_Total as no pool", () => {
    const m = parseMeminfo([...BASE_MEMINFO,
      "HugePages_Total:     garbage",
      "HugePages_Free:      500",
    ].join("\n") + "\n");
    expect(m.hugepages).toBeUndefined();
  });
});
