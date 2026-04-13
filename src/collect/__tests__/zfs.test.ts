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
});
