import { describe, it, expect } from "vitest";
import { isOlderVersion } from "../version-check.js";

describe("isOlderVersion (update-check comparison)", () => {
  it("returns true when current is older than latest (a genuine update)", () => {
    expect(isOlderVersion("0.13.7", "0.13.8")).toBe(true); // patch
    expect(isOlderVersion("0.12.9", "0.13.0")).toBe(true); // minor
    expect(isOlderVersion("0.13.7", "1.0.0")).toBe(true); // major
  });

  it("returns false when current equals latest (no update)", () => {
    expect(isOlderVersion("0.13.8", "0.13.8")).toBe(false);
  });

  it("returns false when current is NEWER than latest (the bug it fixes)", () => {
    // Regression guard: during a fleet roll, a host already on the new
    // version must NOT be told "<old> available" just because the
    // dashboard's reported latest still lags behind. This is exactly the
    // backwards "0.13.7 available (current: 0.13.8)" line that the old
    // `latest !== CURRENT_VERSION` check produced.
    expect(isOlderVersion("0.13.8", "0.13.7")).toBe(false); // patch ahead
    expect(isOlderVersion("0.14.0", "0.13.9")).toBe(false); // minor ahead
    expect(isOlderVersion("1.0.0", "0.13.8")).toBe(false); // major ahead
  });

  it("compares each segment numerically, not lexicographically", () => {
    // A string compare would call "0.13.8" newer than "0.13.10" ("8" > "1");
    // semver says 8 < 10.
    expect(isOlderVersion("0.13.8", "0.13.10")).toBe(true);
    expect(isOlderVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.13.10", "0.13.8")).toBe(false);
  });

  it("tolerates a leading v on either side", () => {
    expect(isOlderVersion("v0.13.7", "0.13.8")).toBe(true);
    expect(isOlderVersion("0.13.7", "v0.13.8")).toBe(true);
    expect(isOlderVersion("v0.13.8", "v0.13.8")).toBe(false);
  });
});
