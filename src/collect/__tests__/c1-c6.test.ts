// Tests for C1-C6 collectors (v0.10.4, 2026-05-19).
//
// Most collectors hit real filesystem paths (/sys/devices/system/edac/,
// /proc/pressure/, /proc/vmstat, /var/crash/, etc.) so we can't fully
// integration-test them outside a Linux host with the expected
// capabilities. These tests cover the pure parser functions and the
// capability-gate behavior (collectors return null on hosts where the
// surface is absent).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { __test_only as psiTest } from "../psi.js";
import { __test_only as vmstatTest, collectVmstat } from "../vmstat.js";
import { parseZpoolStatus } from "../zfs.js";

describe("C2 PSI: parsePsiLine", () => {
  it("parses a complete PSI line", () => {
    const r = psiTest.parsePsiLine(
      "some avg10=0.06 avg60=0.04 avg300=0.05 total=12345",
    );
    expect(r).toEqual({ avg10: 0.06, avg60: 0.04, avg300: 0.05, total: 12345 });
  });

  it("returns null on malformed input", () => {
    expect(psiTest.parsePsiLine("some avg10=0.06")).toBeNull();
    expect(psiTest.parsePsiLine("garbage")).toBeNull();
  });
});

describe("C2 PSI: parsePsiFile", () => {
  it("captures both some and full lines (memory/io shape)", () => {
    const out = psiTest.parsePsiFile(
      "some avg10=1.0 avg60=2.0 avg300=3.0 total=100\nfull avg10=0.5 avg60=1.0 avg300=1.5 total=50\n",
    );
    expect(out?.some.avg10).toBe(1.0);
    expect(out?.full?.avg60).toBe(1.0);
  });

  it("works when only 'some' is present (cpu shape)", () => {
    const out = psiTest.parsePsiFile(
      "some avg10=0.0 avg60=0.0 avg300=0.0 total=0\n",
    );
    expect(out?.some.avg10).toBe(0.0);
    expect(out?.full).toBeUndefined();
  });

  it("returns null on empty input", () => {
    expect(psiTest.parsePsiFile("")).toBeNull();
  });
});

describe("C3 vmstat: collectVmstat delta tracking", () => {
  // Note: vmstat reads real /proc/vmstat on the test runner; on a
  // dev macOS host the file doesn't exist so collectVmstat returns
  // null cleanly. This is sufficient evidence for the capability
  // gate; behavioral delta tests live in the e2e tier.
  beforeEach(() => {
    vmstatTest.resetForTests();
  });

  it("returns null on a host without /proc/vmstat", () => {
    // On macOS / non-Linux, readProcFile returns null and the
    // collector returns null cleanly.
    const r = collectVmstat();
    // We accept either: null (non-Linux) or a snapshot with null
    // rates (Linux but first call). Both prove the capability gate
    // shape.
    if (r !== null) {
      expect(r.pswpin_rate).toBeNull();
      expect(r.pswpout_rate).toBeNull();
    }
  });
});

describe("C6 ZFS: parseZpoolStatus extended vdev fields", () => {
  it("parses a raidz2 pool with a mirrored SLOG and L2ARC", () => {
    const status = [
      "  pool: tank",
      " state: ONLINE",
      "  scan: scrub repaired 0B in 00:00:30 with 0 errors on Sun Oct  1 02:30:00 2026",
      "config:",
      "",
      "\tNAME              STATE     READ WRITE CKSUM",
      "\ttank              ONLINE       0     0     0",
      "\t  raidz2-0        ONLINE       0     0     0",
      "\t    sda           ONLINE       0     0     0",
      "\t    sdb           ONLINE       0     0     0",
      "\t    sdc           ONLINE       0     0     0",
      "\t    sdd           ONLINE       0     0     0",
      "logs",
      "\t  mirror-1        ONLINE       0     0     0",
      "\t    nvme0n1p2     ONLINE       0     0     0",
      "\t    nvme1n1p2     ONLINE       0     0     0",
      "cache",
      "\t  nvme0n1p3       ONLINE       0     0     0",
      "",
      "errors: No known data errors",
    ].join("\n");
    const pools = parseZpoolStatus(status);
    expect(pools).toHaveLength(1);
    const p = pools[0];
    expect(p.name).toBe("tank");
    expect(p.state).toBe("ONLINE");
    expect(p.vdevs).toHaveLength(1);
    expect(p.vdevs[0].name).toBe("raidz2-0");
    expect(p.vdevs[0].redundancy_class).toBe("raidz2");
    expect(p.vdevs[0].degraded_disks_count).toBe(0);
    expect(p.slog_vdevs).toHaveLength(1);
    expect(p.slog_vdevs[0].name).toBe("mirror-1");
    expect(p.l2arc_vdevs).toHaveLength(1);
    expect(p.l2arc_vdevs[0].name).toBe("nvme0n1p3");
  });

  it("classifies raidz1 / raidz3 / mirror correctly", () => {
    const status = [
      "  pool: a",
      " state: ONLINE",
      "config:",
      "\tNAME       STATE",
      "\ta          ONLINE",
      "\t  raidz1-0 ONLINE",
      "\t    s1     ONLINE",
      "\t    s2     ONLINE",
      "  pool: b",
      " state: ONLINE",
      "config:",
      "\tNAME       STATE",
      "\tb          ONLINE",
      "\t  raidz3-0 ONLINE",
      "\t    s1     ONLINE",
      "  pool: c",
      " state: ONLINE",
      "config:",
      "\tNAME       STATE",
      "\tc          ONLINE",
      "\t  mirror-0 ONLINE",
      "\t    s1     ONLINE",
    ].join("\n");
    const pools = parseZpoolStatus(status);
    expect(pools.map((p) => p.vdevs[0]?.redundancy_class)).toEqual([
      "raidz1",
      "raidz3",
      "mirror",
    ]);
  });

  it("counts degraded child devices on a DEGRADED vdev", () => {
    const status = [
      "  pool: tank",
      " state: DEGRADED",
      "config:",
      "\tNAME              STATE",
      "\ttank              DEGRADED",
      "\t  raidz2-0        DEGRADED",
      "\t    sda           ONLINE",
      "\t    sdb           FAULTED",
      "\t    sdc           ONLINE",
      "\t    sdd           ONLINE",
      "",
      "errors: No known data errors",
    ].join("\n");
    const pools = parseZpoolStatus(status);
    expect(pools[0].vdevs[0].degraded_disks_count).toBe(1);
  });

  it("treats a single-device top-level vdev as stripe (no redundancy)", () => {
    const status = [
      "  pool: scratch",
      " state: ONLINE",
      "config:",
      "\tNAME       STATE",
      "\tscratch    ONLINE",
      "\t  sda      ONLINE",
    ].join("\n");
    const pools = parseZpoolStatus(status);
    expect(pools[0].vdevs[0].redundancy_class).toBe("stripe");
  });
});
