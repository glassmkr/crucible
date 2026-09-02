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

  it("does NOT treat a resilver as a scrub: never-scrubbed stays true, no last_scrub_date", () => {
    // Grok's H-D4h: offline+online of a mirror leaf produced
    // `scan: resilvered ...`. The old parser saw a `scan:` line and set
    // last_scrub_date + suppressed scrub_never_run, silently clearing the
    // "never checksum-scrubbed" warning on a pool that had still never
    // been scrubbed. A resilver must not do either.
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
    expect(p.scrub_never_run).toBe(true);
    expect(p.last_scrub_date).toBeUndefined();
    expect(p.scrub_repaired).toBeUndefined();
  });

  it("does NOT treat a canceled scrub as scrub history (Codex round-1 #1)", () => {
    // A canceled scrub never finished verifying the pool, so it must not set
    // last_scrub_date or suppress the never-scrubbed warning.
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
    expect(p.scrub_never_run).toBe(true);
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
