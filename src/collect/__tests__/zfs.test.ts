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
    expect(p.vdevs[0].redundancy_class).toBe("mirror");
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
