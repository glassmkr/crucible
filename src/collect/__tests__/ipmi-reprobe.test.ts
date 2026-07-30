// The dead-BMC re-probe (2026-07-30 review finding #1, agent side).
//
// Separate file from ipmi.test.ts on purpose: these cases need module-level mocks
// for runPrivileged and findBmcDeviceNode, and ipmi.test.ts deliberately exercises
// the real ENOENT path. vi.mock is file-scoped, so mixing them would silently
// change what those tests prove.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runPrivilegedMock = vi.fn();
const findBmcDeviceNodeMock = vi.fn();

vi.mock("../../lib/privileged.js", () => ({
  runPrivileged: (...args: unknown[]) => runPrivilegedMock(...args),
}));
vi.mock("../../lib/bmc-presence.js", () => ({
  findBmcDeviceNode: (...args: unknown[]) => findBmcDeviceNodeMock(...args),
}));

const { collectIpmi } = await import("../ipmi.js");

beforeEach(() => {
  runPrivilegedMock.mockReset();
  findBmcDeviceNodeMock.mockReset();
});

describe("collectIpmi: re-probe when the cached reason contradicts a live device node", () => {
  it("reports probe FAILED for a BMC that was already dead at agent start", async () => {
    // THE BUG. `detection` is one-shot at startup, so a BMC that was dead before
    // the agent came up cached `no_bmc_device`, and collectIpmi then short-circuited
    // to probe "skipped" forever without ever touching the BMC. The dashboard rule
    // keyed on "failed" could therefore never fire for the case it exists for.
    findBmcDeviceNodeMock.mockReturnValue("/dev/ipmi0");
    runPrivilegedMock.mockResolvedValue(null);

    const out = await collectIpmi("generic", { available: false, reason: "no_bmc_device" });

    expect(out.available).toBe(false);
    expect(out.probe).toEqual({
      status: "failed",
      detail: "wrapped ipmi-sensor probe returned no output",
    });
    expect(out.bmc_device_node).toBe("/dev/ipmi0");
    // It actually asked, rather than trusting the stale cache.
    expect(runPrivilegedMock).toHaveBeenCalledWith("ipmi-sensor");
  });

  it("reports available again when the BMC comes back, without waiting for the hourly refresh", async () => {
    findBmcDeviceNodeMock.mockReturnValue("/dev/ipmi0");
    runPrivilegedMock.mockImplementation(async (action: string) => {
      if (action === "ipmi-sensor") return "CPU Temp | 39.000 | degrees C | ok | na | na | na | na | 90.000";
      return null;
    });

    const out = await collectIpmi("generic", { available: false, reason: "no_bmc_device" });

    expect(out.available).toBe(true);
    expect(out.probe).toEqual({ status: "ok" });
    // `detection` still carries the stale startup verdict; `probe` is what tells
    // the truth per snapshot. That is exactly why `probe` was added.
    expect(out.detection).toEqual({ available: false, reason: "no_bmc_device" });
  });

  it("does NOT re-probe when no device node exists, so BMC-less hosts stay free", async () => {
    // The original reason the short-circuit exists: no BMC means no point asking,
    // every interval, forever.
    findBmcDeviceNodeMock.mockReturnValue(null);

    const out = await collectIpmi("generic", { available: false, reason: "no_bmc_device" });

    expect(out.probe).toEqual({ status: "skipped", detail: "startup capability: no_bmc_device" });
    expect(runPrivilegedMock).not.toHaveBeenCalled();
  });

  it("does NOT re-probe on ipmitool_cve_2020_5208 even with a device node present", async () => {
    // SECURITY-RELEVANT. That reason means we refused to hand this binary root.
    // Re-probing would exec the very binary we just declined to trust, through the
    // sudo wrapper, defeating the gate entirely.
    findBmcDeviceNodeMock.mockReturnValue("/dev/ipmi0");

    const out = await collectIpmi("generic", {
      available: false,
      reason: "ipmitool_cve_2020_5208",
      detail: "unowned build",
    });

    expect(out.probe?.status).toBe("skipped");
    expect(runPrivilegedMock).not.toHaveBeenCalled();
  });

  it.each(["permission_denied", "no_ipmitool_binary", "execution_failed"] as const)(
    "does NOT re-probe on the host-side reason %s, where probing cannot succeed",
    async (reason) => {
      findBmcDeviceNodeMock.mockReturnValue("/dev/ipmi0");

      const out = await collectIpmi("generic", { available: false, reason });

      expect(out.probe?.status).toBe("skipped");
      expect(runPrivilegedMock).not.toHaveBeenCalled();
    },
  );
});
