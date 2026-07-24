import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, nodeMajorMeetsMinimum, oldNodeMessage, parseNodeMajor } from "../node-version.js";

describe("parseNodeMajor", () => {
  it("reads the major from process.versions.node-style strings", () => {
    expect(parseNodeMajor("20.11.1")).toBe(20);
    expect(parseNodeMajor("24.0.0")).toBe(24);
    expect(parseNodeMajor("v25.9.0")).toBe(25);
    expect(parseNodeMajor("  18.19.0  ")).toBe(18);
  });

  it("returns null for anything unrecognisable (so callers fail closed)", () => {
    expect(parseNodeMajor("")).toBeNull();
    expect(parseNodeMajor("not-a-version")).toBeNull();
    expect(parseNodeMajor("v24")).toBeNull(); // no dot after major
  });
});

describe("nodeMajorMeetsMinimum", () => {
  it("rejects a Node older than the required major (the crash case)", () => {
    // undici@8 crashes at import on Node < 24; the preflight must exit before
    // that import, so this is the guard that stops it.
    expect(nodeMajorMeetsMinimum("20.11.1")).toBe(false);
    expect(nodeMajorMeetsMinimum("22.4.0")).toBe(false);
  });

  it("accepts the required major and newer", () => {
    expect(nodeMajorMeetsMinimum("24.0.0")).toBe(true);
    expect(nodeMajorMeetsMinimum("v25.9.0")).toBe(true);
  });

  it("treats an unparseable version as too old (fail closed)", () => {
    expect(nodeMajorMeetsMinimum("garbage")).toBe(false);
  });

  it("honours a custom minimum", () => {
    expect(nodeMajorMeetsMinimum("20.0.0", 20)).toBe(true);
    expect(nodeMajorMeetsMinimum("19.0.0", 20)).toBe(false);
  });

  it("defaults to MIN_NODE_MAJOR", () => {
    expect(MIN_NODE_MAJOR).toBe(24);
    expect(nodeMajorMeetsMinimum(`${MIN_NODE_MAJOR}.0.0`)).toBe(true);
    expect(nodeMajorMeetsMinimum(`${MIN_NODE_MAJOR - 1}.9.9`)).toBe(false);
  });
});

describe("oldNodeMessage", () => {
  it("names both the requirement and the running version on one line", () => {
    const msg = oldNodeMessage("20.11.1");
    expect(msg).toContain("Node.js 24 or newer");
    expect(msg).toContain("20.11.1");
    expect(msg).not.toContain("\n");
  });
});
