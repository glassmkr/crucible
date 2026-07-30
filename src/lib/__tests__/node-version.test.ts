import { describe, expect, it } from "vitest";
import { MIN_NODE_VERSION, nodeMeetsMinimum, oldNodeMessage, parseNodeVersion } from "../node-version.js";

describe("parseNodeVersion", () => {
  it("reads major.minor.patch from process.versions.node-style strings", () => {
    expect(parseNodeVersion("20.11.1")).toEqual([20, 11, 1]);
    expect(parseNodeVersion("22.22.2")).toEqual([22, 22, 2]);
    expect(parseNodeVersion("v25.9.0")).toEqual([25, 9, 0]);
    expect(parseNodeVersion("  18.19.0  ")).toEqual([18, 19, 0]);
  });

  it("treats a missing minor or patch as zero rather than unparseable", () => {
    // The old major-only parser required a dot and returned null for "v24",
    // failing closed on a legitimate version string.
    expect(parseNodeVersion("v24")).toEqual([24, 0, 0]);
    expect(parseNodeVersion("22.19")).toEqual([22, 19, 0]);
  });

  it("returns null for anything with no leading integer (so callers fail closed)", () => {
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("not-a-version")).toBeNull();
    expect(parseNodeVersion("vNext")).toBeNull();
  });
});

describe("nodeMeetsMinimum", () => {
  it("compares components NUMERICALLY, so 22.19 outranks 22.9", () => {
    // Why this is not a string compare: as strings, "22.9.0" >= "22.19.0" is
    // true, which would wave through a Node too old to import undici.
    expect(nodeMeetsMinimum("22.9.0")).toBe(false);
    expect(nodeMeetsMinimum("22.19.0")).toBe(true);
    expect(nodeMeetsMinimum("22.100.0")).toBe(true);
  });

  it("accepts the Node 22 LTS releases the old major-only floor wrongly rejected", () => {
    // 22.22.2 is the version that held a fleet box back for days. Verified on
    // real hardware 2026-07-30: undici imports, a live HTTPS request through its
    // Agent returns 200, and the CLI runs correctly. Refusing it was the bug,
    // and a major-only comparison could not express the real boundary at all.
    expect(nodeMeetsMinimum("22.22.2")).toBe(true);
    expect(nodeMeetsMinimum("22.19.0")).toBe(true);
  });

  it("still rejects the Nodes that genuinely cannot import undici", () => {
    expect(nodeMeetsMinimum("20.11.1")).toBe(false); // the prod box that found the crash
    expect(nodeMeetsMinimum("22.4.0")).toBe(false);  // below undici's declared floor
    expect(nodeMeetsMinimum("18.19.0")).toBe(false);
  });

  it("accepts everything above the floor", () => {
    expect(nodeMeetsMinimum("24.0.0")).toBe(true);
    expect(nodeMeetsMinimum("v25.9.0")).toBe(true);
  });

  it("treats an unparseable version as too old (fail closed)", () => {
    expect(nodeMeetsMinimum("garbage")).toBe(false);
    expect(nodeMeetsMinimum("")).toBe(false);
  });

  it("fails closed when the MINIMUM itself is unparseable", () => {
    // Stops a typo in the constant from silently disabling the whole guard.
    expect(nodeMeetsMinimum("24.0.0", "not-a-version")).toBe(false);
  });

  it("honours a custom minimum and treats exact equality as met", () => {
    expect(nodeMeetsMinimum("20.0.0", "20.0.0")).toBe(true);
    expect(nodeMeetsMinimum("19.9.9", "20.0.0")).toBe(false);
  });

  it("defaults to MIN_NODE_VERSION, which tracks undici's own engines.node", () => {
    expect(MIN_NODE_VERSION).toBe("22.19.0");
    expect(nodeMeetsMinimum(MIN_NODE_VERSION)).toBe(true);
  });
});

describe("oldNodeMessage", () => {
  it("names both the requirement and the running version on one line", () => {
    const msg = oldNodeMessage("20.11.1");
    expect(msg).toContain("Node.js 22.19.0 or newer");
    expect(msg).toContain("20.11.1");
    expect(msg).not.toContain("\n");
  });
});

describe("parseNodeVersion: trailing garbage and prereleases (review 2026-07-30 #7)", () => {
  it("REJECTS prereleases, which precede their release and may lack the undici API", () => {
    // Unanchored, these all parsed as [22,19,0] and satisfied the floor, which could
    // put us back at the import-time crash-loop the guard exists to prevent.
    for (const v of ["22.19.0-rc.1", "22.19.0-nightly20260730", "24.0.0-pre"]) {
      expect(parseNodeVersion(v)).toBeNull();
      expect(nodeMeetsMinimum(v)).toBe(false);
    }
  });

  it("REJECTS trailing garbage rather than silently truncating it", () => {
    for (const v of ["22.19.0garbage", "v24junk", "22.19.0 extra"]) {
      expect(parseNodeVersion(v)).toBeNull();
      expect(nodeMeetsMinimum(v)).toBe(false);
    }
  });

  it("still accepts every real process.versions.node shape", () => {
    for (const v of ["22.19.0", "22.22.2", "24.18.0", "v25.9.0", "24", "22.19"]) {
      expect(parseNodeVersion(v)).not.toBeNull();
    }
  });
});
