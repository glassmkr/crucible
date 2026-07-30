import { describe, it, expect } from "vitest";
import { formatIpmiDoctor, readEnforceFlag } from "../doctor.js";
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
    // Specifically the "no restart needed" promise: this is the
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

describe("formatIpmiDoctor: CVE gate visibility (2026-07-30 review finding #5)", () => {
  it("explains the refusal instead of printing a bare reason code", () => {
    // Before this, `ipmitool_cve_2020_5208` had NO case in the switch at all, so
    // the one command an operator runs when IPMI looks wrong printed the reason
    // and then nothing. That mattered more once the gate could produce this
    // reason by default, not only via an explicit opt-in.
    const out = formatIpmiDoctor({
      available: false,
      reason: "ipmitool_cve_2020_5208",
      detail: "ipmitool 1.8.18 < 1.8.19 and /usr/local/bin/ipmitool is not owned by any dpkg or rpm package, so it is a source, vendor or hand-installed build with no distro backport guarantee; refusing to run it as root",
    } as IpmiCapability);

    expect(out).toContain("/usr/local/bin/ipmitool");
    expect(out).toContain("will not run this ipmitool as root");
    // The shadowing fact is the non-obvious part, and it is why the packaged
    // binary being fine does not save you.
    expect(out).toContain("secure_path");
    // Must not leave the reader thinking distro 1.8.18 is blocked.
    expect(out).toContain("Distro-packaged 1.8.18 is NOT blocked");
    // Actionable, and never suggests a BMC cold reset.
    expect(out).toContain("sudo apt install ipmitool");
    expect(out).not.toMatch(/mc reset/);
  });

  it("surfaces the advisory and the distro EVR when collecting below the floor", () => {
    const out = formatIpmiDoctor({
      available: true,
      method: "ipmitool_in_band",
      ipmitool_version: "1.8.18",
      ipmitool_below_cve_floor: true,
      ipmitool_package: "ipmitool 1.8.18-11ubuntu2.2",
    } as IpmiCapability);

    expect(out).toContain("CVE-2020-5208");
    // The EVR is the whole point: it is what `ipmitool -V` hides.
    expect(out).toContain("ipmitool 1.8.18-11ubuntu2.2");
    expect(out).toContain("distro-owned");
    // Still an OK result, not a failure.
    expect(out).toContain("[OK]");
  });

  it("says nothing about the CVE on a host at or above the floor", () => {
    const out = formatIpmiDoctor({
      available: true,
      method: "ipmitool_in_band",
      ipmitool_version: "1.8.19",
    } as IpmiCapability);
    expect(out).not.toContain("CVE-2020-5208");
  });
});

describe("readEnforceFlag", () => {
  it("passes the operator's fail-closed opt-in through to the probe", () => {
    const { enforce, note } = readEnforceFlag((() => ({
      collection: { enforce_ipmitool_min_version: true },
    })) as any);
    expect(enforce).toBe(true);
    expect(note).toBeNull();
  });

  it("degrades to the default WITH an explanation when config is unreadable", () => {
    // Config is root:glassmkr 0640, so an ordinary user running `doctor ipmi`
    // cannot read it. A diagnostic must still work, and must say why its answer
    // may not match the running agent.
    const { enforce, note } = readEnforceFlag((() => {
      const e: any = new Error("permission denied");
      e.code = "EACCES";
      throw e;
    }) as any);
    expect(enforce).toBe(false);
    expect(note).toContain("re-run with sudo");
  });

  it("degrades on any other config error too", () => {
    const { enforce, note } = readEnforceFlag((() => { throw new Error("bad yaml"); }) as any);
    expect(enforce).toBe(false);
    expect(note).toContain("could not be read");
  });
});
