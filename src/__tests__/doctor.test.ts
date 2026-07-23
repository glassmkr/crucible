import { describe, it, expect } from "vitest";
import { formatIpmiDoctor } from "../doctor.js";
import type { IpmiCapability } from "../lib/types.js";

describe("formatIpmiDoctor", () => {
  it("renders the available case with method + version", () => {
    const cap: IpmiCapability = {
      available: true,
      method: "ipmitool_in_band",
      ipmitool_version: "1.8.19",
    };
    const out = formatIpmiDoctor(cap);
    expect(out).toContain("[OK] IPMI detected via ipmitool_in_band");
    expect(out).toContain("1.8.19");
    expect(out).toContain("re-checked once per hour");
  });

  it("renders no_ipmitool_binary with the per-distro install commands", () => {
    const cap: IpmiCapability = { available: false, reason: "no_ipmitool_binary" };
    const out = formatIpmiDoctor(cap);
    expect(out).toContain("[FAIL]");
    expect(out).toContain("no_ipmitool_binary");
    expect(out).toContain("sudo apt install ipmitool");
    expect(out).toContain("sudo dnf install ipmitool");
    expect(out).toContain("sudo pacman -S ipmitool");
    expect(out).toContain("sudo apk add ipmitool");
    // Specifically the "no restart needed" promise — this is the
    // customer-visible payoff of the 0.9.4 re-detect change.
    expect(out).toContain("No agent restart needed");
  });

  it("renders no_bmc_device with modprobe + collection.ipmi: false fallback", () => {
    const cap: IpmiCapability = { available: false, reason: "no_bmc_device", detail: "ipmitool sensor: could not open device" };
    const out = formatIpmiDoctor(cap);
    expect(out).toContain("modprobe ipmi_si");
    expect(out).toContain("collection.ipmi: false");
    expect(out).toContain("could not open device"); // detail surfaced
  });

  it("renders permission_denied with narrow-wrapper repair guidance", () => {
    const cap: IpmiCapability = { available: false, reason: "permission_denied" };
    const out = formatIpmiDoctor(cap);
    expect(out).toContain("privileged collector wrapper");
    expect(out).toContain("crucible-collect ipmi-sensor");
    expect(out).toContain("Do not");
  });

  it("renders execution_failed with a `mc info` reproducer and a safety warning about mc reset cold", () => {
    const cap: IpmiCapability = { available: false, reason: "execution_failed", detail: "exit 1" };
    const out = formatIpmiDoctor(cap);
    expect(out).toContain("sudo ipmitool mc info");
    expect(out).toContain("DO NOT run `sudo ipmitool mc reset cold` without confirming");
  });
});
