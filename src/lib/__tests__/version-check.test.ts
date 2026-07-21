import { beforeEach, describe, it, expect, vi } from "vitest";
import { __test_only, checkForUpdates, isOlderVersion } from "../version-check.js";

beforeEach(() => __test_only.reset());

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

describe("checkForUpdates endpoint policy", () => {
  it("rejects a private update endpoint before fetch", async () => {
    const fetchImpl = vi.fn();
    await checkForUpdates("https://updates.example", undefined, {
      fetch: fetchImpl as typeof fetch,
      resolveEndpoint: async () => { throw new Error("private resolution"); },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates and rejects a redirect to a private target", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/version" },
    }));
    await checkForUpdates("https://updates.example", undefined, {
      fetch: fetchImpl as typeof fetch,
      resolveEndpoint: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("manual");
  });
});
