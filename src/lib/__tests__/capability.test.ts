import { describe, it, expect } from "vitest";
import {
  detectIpmiCapability,
  formatCapabilityLine,
  isIpmitoolVersionVulnerable,
} from "../capability.js";

describe("isIpmitoolVersionVulnerable (CVE-2020-5208, fixed in 1.8.19)", () => {
  it("flags versions strictly below 1.8.19", () => {
    expect(isIpmitoolVersionVulnerable("1.8.18")).toBe(true);
    expect(isIpmitoolVersionVulnerable("1.8.11")).toBe(true);
    expect(isIpmitoolVersionVulnerable("1.7.99")).toBe(true);
  });
  it("clears 1.8.19 and above", () => {
    expect(isIpmitoolVersionVulnerable("1.8.19")).toBe(false);
    expect(isIpmitoolVersionVulnerable("1.8.20")).toBe(false);
    expect(isIpmitoolVersionVulnerable("1.9.0")).toBe(false);
    expect(isIpmitoolVersionVulnerable("2.0.0")).toBe(false);
  });
  it("does not gate an unknown/unparseable version (fail-open on identification)", () => {
    expect(isIpmitoolVersionVulnerable(null)).toBe(false);
    expect(isIpmitoolVersionVulnerable("")).toBe(false);
    expect(isIpmitoolVersionVulnerable("unknown")).toBe(false);
  });
  it("tolerates distro version suffixes", () => {
    expect(isIpmitoolVersionVulnerable("1.8.18-11ubuntu2")).toBe(true);
    expect(isIpmitoolVersionVulnerable("1.8.19-4")).toBe(false);
  });
});

describe("detectIpmiCapability", () => {
  it("returns no_ipmitool_binary when neither device nor binary exist (Pi)", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async () => "enoent",
      runIpmitool: async () => { const e: any = new Error("not found"); e.code = "ENOENT"; throw e; },
    });
    expect(cap).toEqual({ available: false, reason: "no_ipmitool_binary" });
  });

  it("returns available when /dev/ipmi0 exists and ipmitool runs (CVE-safe version)", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async (p) => p === "/dev/ipmi0" ? "ok" : "enoent",
      runIpmitool: async () => ({ stdout: "ipmitool version 1.8.19\n", stderr: "" }),
    });
    expect(cap).toEqual({ available: true, method: "ipmitool_in_band", ipmitool_version: "1.8.19" });
  });

  it("disables IPMI when ipmitool is below 1.8.19 even with a BMC present (CVE-2020-5208)", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async (p) => p === "/dev/ipmi0" ? "ok" : "enoent",
      runIpmitool: async () => ({ stdout: "ipmitool version 1.8.18\n", stderr: "" }),
    });
    expect(cap.available).toBe(false);
    if (!cap.available) {
      expect(cap.reason).toBe("ipmitool_cve_2020_5208");
      expect(cap.detail).toContain("1.8.18");
    }
  });

  it("returns no_bmc_device when ipmitool exists but device is missing AND sensor probe fails", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async () => "enoent",
      runIpmitool: async (args) => {
        if (args[0] === "-V") return { stdout: "ipmitool version 1.8.19", stderr: "" };
        const e: any = new Error("Could not open device");
        e.stderr = "Could not open device at /dev/ipmi0: No such file or directory";
        throw e;
      },
    });
    expect(cap.available).toBe(false);
    if (!cap.available) expect(cap.reason).toBe("no_bmc_device");
  });

  it("returns permission_denied on EACCES", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async () => "eacces",
      runIpmitool: async () => ({ stdout: "ipmitool version 1.8.18", stderr: "" }),
    });
    expect(cap.available).toBe(false);
    if (!cap.available) {
      expect(cap.reason).toBe("permission_denied");
      expect(cap.detail).toContain("ipmi");
    }
  });

  it("VM with ipmitool installed but no virtual BMC: no_bmc_device", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async () => "enoent",
      runIpmitool: async (args) => {
        if (args[0] === "-V") return { stdout: "ipmitool version 1.8.19", stderr: "" };
        const e: any = new Error("could not open");
        e.stderr = "Could not open device";
        throw e;
      },
    });
    expect(cap.available).toBe(false);
    if (!cap.available) expect(cap.reason).toBe("no_bmc_device");
  });

  it("captures ipmitool version when present", async () => {
    const cap = await detectIpmiCapability({
      statDevice: async (p) => p === "/dev/ipmi0" ? "ok" : "enoent",
      runIpmitool: async () => ({ stdout: "ipmitool version 1.8.21-rc1\n", stderr: "" }),
    });
    expect(cap.available).toBe(true);
    if (cap.available) expect(cap.ipmitool_version).toBe("1.8.21-rc1");
  });
});

describe("formatCapabilityLine", () => {
  it("formats available capability", () => {
    expect(formatCapabilityLine({ available: true, method: "ipmitool_in_band", ipmitool_version: "1.8.18" }))
      .toBe("IPMI: available (ipmitool 1.8.18, ipmitool in band)");
  });
  it("formats no ipmitool", () => {
    expect(formatCapabilityLine({ available: false, reason: "no_ipmitool_binary" }))
      .toBe("IPMI: not available (ipmitool not installed)");
  });
  it("formats no BMC", () => {
    expect(formatCapabilityLine({ available: false, reason: "no_bmc_device" }))
      .toBe("IPMI: not available (no /dev/ipmi*, BMC not detected)");
  });
  it("formats permission denied", () => {
    expect(formatCapabilityLine({ available: false, reason: "permission_denied", detail: "/dev/ipmi0 not readable" }))
      .toBe("IPMI: not available (/dev/ipmi0 not readable)");
  });
});
