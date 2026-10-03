import { describe, it, expect } from "vitest";
import { parseZpoolStatus } from "../zfs.js";

describe("parseZpoolStatus", () => {
  it("parses a healthy pool", () => {
    const raw = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 01:23:45 with 0 errors on Sun Apr  5 12:34:56 2026
config:

        NAME        STATE     READ WRITE CKSUM
        tank        ONLINE       0     0     0
          mirror-0  ONLINE       0     0     0

errors: No known data errors
`;
    const pools = parseZpoolStatus(raw);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      name: "tank",
      state: "ONLINE",
      errors_text: "No known data errors",
      scrub_errors: 0,
      scrub_repaired: "0B",
    });
    expect(pools[0].last_scrub_date).toContain("2026");
  });

  it("parses a DEGRADED pool", () => {
    const raw = `  pool: tank
 state: DEGRADED
  scan: scrub repaired 16K in 02:00:00 with 3 errors on Sun Apr  5 12:34:56 2026

errors: 3 data errors, use '-v' for a list
`;
    const [p] = parseZpoolStatus(raw);
    expect(p.state).toBe("DEGRADED");
    expect(p.scrub_errors).toBe(3);
    expect(p.scrub_repaired).toBe("16K");
  });

  it("flags never-scrubbed pools", () => {
    const raw = `  pool: tank
 state: ONLINE
  scan: none requested

errors: No known data errors
`;
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBe(true);
    expect(p.scrub_errors).toBeUndefined();
  });

  it("returns empty for no pools", () => {
    expect(parseZpoolStatus("no pools available")).toEqual([]);
  });

  it("parses multiple pools", () => {
    const raw = `  pool: tank
 state: ONLINE
  scan: none requested
errors: No known data errors
  pool: data
 state: FAULTED
  scan: none requested
errors: 2 data errors
`;
    const pools = parseZpoolStatus(raw);
    expect(pools.map((p) => p.name)).toEqual(["tank", "data"]);
    expect(pools[1].state).toBe("FAULTED");
  });

  // === Regressions from session-9/A.1 surfacing on ZFS 2.2.9 ===

  it("routes the SLOG vdev into slog_vdevs[] (ZFS 2.2 tab-prefixed `logs` header)", () => {
    // Real fixture captured on val-mz62hd 2026-05-21, ZFS 2.2.9 on
    // AlmaLinux 9.6. The `logs` section header is TAB-prefixed with a
    // trailing TAB. Older parser regex `^logs\s*$` never matched, so
    // every SLOG vdev was misrouted into `vdevs[]` with class=stripe.
    const raw =
      "  pool: gmtest\n" +
      " state: ONLINE\n" +
      "config:\n" +
      "\n" +
      "\tNAME                             STATE     READ WRITE CKSUM\n" +
      "\tgmtest                           ONLINE       0     0     0\n" +
      "\t  mirror-0                       ONLINE       0     0     0\n" +
      "\t    /var/tmp/zfs-test/disk1.img  ONLINE       0     0     0\n" +
      "\t    /var/tmp/zfs-test/disk2.img  ONLINE       0     0     0\n" +
      "\tlogs\t\n" +
      "\t  /var/tmp/zfs-test/slog.img     ONLINE       0     0     0\n" +
      "\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.vdevs.length).toBe(1);
    expect(p.vdevs[0].name).toBe("mirror-0");
    // Two child devices -> mirror_2way (H-D4g).
    expect(p.vdevs[0].redundancy_class).toBe("mirror_2way");
    expect(p.vdevs[0].child_count).toBe(2);
    expect(p.slog_vdevs.length).toBe(1);
    expect(p.slog_vdevs[0].name).toBe("/var/tmp/zfs-test/slog.img");
    expect(p.slog_vdevs[0].state).toBe("ONLINE");
    expect(p.slog_vdevs[0].redundancy_class).toBe("stripe");
  });

  it("flags never-scrubbed on fresh pools that omit the `scan:` line (ZFS 2.2)", () => {
    // Real fixture: a freshly-created pool on ZFS 2.2.9 emits NO
    // `scan:` line at all (not even "scan: none requested"). The
    // older parser's `scrub_never_run` only triggered on the explicit
    // "none requested" phrase, so freshly-created pools never fired
    // the zfs_scrub_errors never-scrubbed branch. The fix asserts
    // scrub_never_run on reaching `errors:` without having seen any
    // `scan:` line.
    const raw =
      "  pool: gmtest\n" +
      " state: ONLINE\n" +
      "config:\n" +
      "\n" +
      "\tNAME      STATE     READ WRITE CKSUM\n" +
      "\tgmtest    ONLINE       0     0     0\n" +
      "\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBe(true);
    expect(p.scrub_errors).toBeUndefined();
  });

  it("does NOT mark scrub_never_run when scrub history is present (regression check on the above)", () => {
    // The complement: a pool with a real scrub history must NOT be
    // flagged as never-scrubbed by the new fresh-pool logic.
    const raw =
      "  pool: tank\n" +
      " state: ONLINE\n" +
      "  scan: scrub repaired 0B in 00:01:23 with 0 errors on Wed Jan 15 00:00:00 2026\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBeUndefined();
    expect(p.scrub_errors).toBe(0);
    expect(p.scrub_repaired).toBe("0B");
  });

  // === H-D4g: mirror_Nway classification from child count ===

  it("classifies a 2-way mirror as mirror_2way (Grok val-nvme-platinum shape)", () => {
    // The exact scenario Grok exercised: a 2-way mirror, one leaf
    // administratively offlined. The pool is DEGRADED but the vdev has
    // two children, so it is a 2-way mirror (a single fault exhausts
    // redundancy). The old parser emitted bare "mirror", which the
    // dashboard severity matrix could not classify ("unknown redundancy
    // class"); now it is mirror_2way.
    const raw =
      "  pool: gmkscratch\n" +
      " state: DEGRADED\n" +
      "  scan: resilvered 36K in 00:00:00 with 0 errors on Tue Sep  2 14:24:00 2026\n" +
      "config:\n" +
      "\n" +
      "\tNAME            STATE     READ WRITE CKSUM\n" +
      "\tgmkscratch      DEGRADED     0     0     0\n" +
      "\t  mirror-0      DEGRADED     0     0     0\n" +
      "\t    nvme0n1p3   ONLINE       0     0     0\n" +
      "\t    nvme1n1p3   OFFLINE      0     0     0\n" +
      "\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.state).toBe("DEGRADED");
    expect(p.vdevs[0].redundancy_class).toBe("mirror_2way");
    expect(p.vdevs[0].child_count).toBe(2);
    expect(p.vdevs[0].degraded_disks_count).toBe(1);
  });

  it("counts only immediate mirror children during a replacement, not sub-vdev leaves (Codex round-2 #1)", () => {
    // A 2-way mirror mid-replacement: mirror-0's immediate children are the
    // `replacing-0` sub-vdev and the surviving disk (2 = 2-way). The replacing
    // sub-vdev's old/new leaves are deeper and must NOT inflate the width.
    const raw =
      "  pool: tank\n" +
      " state: DEGRADED\n" +
      "  scan: resilver in progress since Tue Sep  2 14:00:00 2026\n" +
      "config:\n" +
      "\tNAME             STATE\n" +
      "\ttank             DEGRADED\n" +
      "\t  mirror-0       DEGRADED\n" +
      "\t    replacing-0  DEGRADED\n" +
      "\t      old        OFFLINE\n" +
      "\t      new        ONLINE\n" +
      "\t    disk2        ONLINE\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.vdevs[0].name).toBe("mirror-0");
    expect(p.vdevs[0].child_count).toBe(2);
    expect(p.vdevs[0].redundancy_class).toBe("mirror_2way");
  });

  it("classifies 3-way and 4-way mirrors", () => {
    const threeWay =
      "  pool: t3\n state: ONLINE\nconfig:\n" +
      "\tNAME        STATE\n\tt3          ONLINE\n\t  mirror-0  ONLINE\n" +
      "\t    a       ONLINE\n\t    b       ONLINE\n\t    c       ONLINE\n" +
      "errors: No known data errors\n";
    expect(parseZpoolStatus(threeWay)[0].vdevs[0].redundancy_class).toBe("mirror_3way");
    const fourWay =
      "  pool: t4\n state: ONLINE\nconfig:\n" +
      "\tNAME        STATE\n\tt4          ONLINE\n\t  mirror-0  ONLINE\n" +
      "\t    a       ONLINE\n\t    b       ONLINE\n\t    c       ONLINE\n\t    d       ONLINE\n" +
      "errors: No known data errors\n";
    expect(parseZpoolStatus(fourWay)[0].vdevs[0].redundancy_class).toBe("mirror_4way+");
  });

  // === H-D4h: a resilver is not a scrub ===

  it("does NOT treat a resilver as a scrub, and does not claim the pool was never scrubbed", () => {
    // Grok's H-D4h: offline+online of a mirror leaf produced
    // `scan: resilvered ...`. A resilver is not a scrub, so it must not set
    // last_scrub_date. But zpool status shows only the MOST RECENT scan, so
    // a resilver line also hides any earlier scrub: "never scrubbed" is
    // unknown here, not true. Asserting it (as this test once did) told an
    // operator whose pool was scrubbed last week that it never had been.
    const raw =
      "  pool: gmkscratch\n" +
      " state: ONLINE\n" +
      "  scan: resilvered 36K in 00:00:00 with 0 errors on Tue Sep  2 14:24:00 2026\n" +
      "config:\n" +
      "\tNAME            STATE\n" +
      "\tgmkscratch      ONLINE\n" +
      "\t  mirror-0      ONLINE\n" +
      "\t    nvme0n1p3   ONLINE\n" +
      "\t    nvme1n1p3   ONLINE\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBeUndefined();
    expect(p.last_scrub_date).toBeUndefined();
    expect(p.scrub_repaired).toBeUndefined();
  });

  it("does NOT treat a canceled scrub as scrub history, nor as proof of none (Codex round-1 #1)", () => {
    // A canceled scrub never finished verifying the pool, so it must not set
    // last_scrub_date. It also replaced whatever scan zpool showed before it,
    // so an earlier completed scrub may exist: never-scrubbed stays unknown.
    const raw =
      "  pool: tank\n" +
      " state: ONLINE\n" +
      "  scan: scrub canceled on Tue Sep  2 14:24:00 2026\n" +
      "config:\n" +
      "\tNAME       STATE\n" +
      "\ttank       ONLINE\n" +
      "\t  mirror-0 ONLINE\n" +
      "\t    a      ONLINE\n" +
      "\t    b      ONLINE\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBeUndefined();
    expect(p.last_scrub_date).toBeUndefined();
  });

  it("an in-progress resilver (multi-line scan block) leaves scrub history unknown", () => {
    const raw =
      "  pool: tank\n" +
      " state: DEGRADED\n" +
      "  scan: resilver in progress since Fri Sep 26 03:14:07 2025\n" +
      "\t1.62T scanned at 1.21G/s, 812G issued at 607M/s, 9.78T total\n" +
      "\t134G resilvered, 8.11% done, 04:18:22 to go\n" +
      "config:\n" +
      "\tNAME        STATE\n" +
      "\ttank        DEGRADED\n" +
      "\t  mirror-0  DEGRADED\n" +
      "\t    a       ONLINE\n" +
      "\t    b       OFFLINE\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBeUndefined();
    expect(p.last_scrub_date).toBeUndefined();
  });

  it("still records a real scrub after a resilver line elsewhere is ignored", () => {
    // A genuine scrub line must still set scrub history (regression guard
    // that the resilver carve-out did not break scrub parsing).
    const raw =
      "  pool: tank\n" +
      " state: ONLINE\n" +
      "  scan: scrub repaired 0B in 00:05:00 with 0 errors on Wed Jan 15 03:00:00 2026\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.scrub_never_run).toBeUndefined();
    expect(p.scrub_errors).toBe(0);
    expect(p.last_scrub_date).toContain("2026");
  });

  it("classifies a dRAID vdev from its real lowercase name, not as a stripe", () => {
    // zpool prints dRAID vdevs as "draid<parity>:<d>d:<c>c:<s>s-<n>". The old
    // startsWith("dRAID") never matched, so a degraded dRAID was reported as a
    // zero-redundancy stripe.
    const raw =
      "  pool: bulk\n" +
      " state: DEGRADED\n" +
      "  scan: scrub repaired 0B in 11:02:51 with 0 errors on Sun Sep 14 11:26:52 2025\n" +
      "config:\n" +
      "\n" +
      "\tNAME                   STATE     READ WRITE CKSUM\n" +
      "\tbulk                   DEGRADED     0     0     0\n" +
      "\t  draid2:4d:7c:1s-0    DEGRADED     0     0     0\n" +
      "\t    sdc                ONLINE       0     0     0\n" +
      "\t    sdd                ONLINE       0     0     0\n" +
      "\t    sde                FAULTED      0    58     0  too many errors\n" +
      "\t    sdf                ONLINE       0     0     0\n" +
      "\tspares\n" +
      "\t  draid2-0-0           AVAIL\n" +
      "\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(raw);
    expect(p.vdevs).toHaveLength(1);
    expect(p.vdevs[0].name).toBe("draid2:4d:7c:1s-0");
    expect(p.vdevs[0].redundancy_class).toBe("draid");
    expect(p.vdevs[0].degraded_disks_count).toBe(1);
  });

  it("section headers tolerate either tab-prefixed or unindented form (forwards-compat)", () => {
    // ZFS 2.0 emitted section headers unindented (`logs\n`); ZFS 2.2
    // uses tab-prefixed (`\tlogs\t\n`). The parser must handle both.
    const oldStyle =
      "  pool: oldzfs\n" +
      " state: ONLINE\n" +
      "config:\n" +
      "\tNAME       STATE\n" +
      "\toldzfs     ONLINE\n" +
      "\t  disk0    ONLINE\n" +
      "logs\n" +
      "\t  log0     ONLINE\n" +
      "errors: No known data errors\n";
    const [p] = parseZpoolStatus(oldStyle);
    expect(p.slog_vdevs.length).toBe(1);
    expect(p.slog_vdevs[0].name).toBe("log0");
  });
});
