import { describe, it, expect } from "vitest";
import {
  classifyIpmitoolVersion,
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
  // NB this wrapper collapses "unknown" to false BY DESIGN; the gate itself does not
  // fail open on unknown any more, see classifyIpmitoolVersion and the finding-#1
  // tests below. Do not read this case as "an unparseable version is waved through".
  it("reports false for an unknown/unparseable version (the wrapper's narrow contract)", () => {
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
      runIpmitool: async (_bin: string) => { const e: any = new Error("not found"); e.code = "ENOENT"; throw e; },
      probeSensor: async () => null,
    });
    expect(cap).toEqual({ available: false, reason: "no_ipmitool_binary" });
  });

  it("available when the WRAPPED sensor probe returns BMC data (CVE-safe version)", async () => {
    // §2.1: availability comes from the wrapper (runs as root), not a direct
    // /dev/ipmi0 stat the unprivileged service user can't do.
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.19\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
    });
    expect(cap).toEqual({ available: true, method: "ipmitool_in_band", ipmitool_version: "1.8.19" });
  });

  // REVERSED 2026-07-29. Blocking here was net-negative: `ipmitool -V` reports a
  // bare upstream version (Ubuntu 22.04 ships 1.8.18-11ubuntu2.2 and reports
  // "1.8.18"), so the check cannot see the distro backport that actually fixes the
  // CVE, and it therefore fired on suspicion rather than evidence. On the distros
  // where it fired the package was normally already patched, so it removed all fan,
  // PSU, SEL and IPMI-ECC monitoring while protecting against nothing. Full
  // reasoning in the block comment on MIN_SAFE_IPMITOOL_VERSION.
  // NARROWED 2026-07-30: the advisory now requires POSITIVE evidence of distro
  // origin. Provenance is injected explicitly in every below-floor test below,
  // because the default implementation reads the real filesystem and package
  // database, which would make these tests depend on the machine running them.
  it("COLLECTS when a below-floor ipmitool is owned by a distro package", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.18\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      attributeProvenance: async () => ({
        path: "/usr/bin/ipmitool",
        attributed: true,
        package: "ipmitool 1.8.18-11ubuntu2.2",
        detail: "/usr/bin/ipmitool is owned by dpkg package ipmitool 1.8.18-11ubuntu2.2",
      }),
    });
    expect(cap.available).toBe(true);
    if (cap.available) {
      expect(cap.ipmitool_version).toBe("1.8.18");
      expect(cap.ipmitool_below_cve_floor).toBe(true);
      // The EVR is the evidence for collecting anyway, so it must reach the snapshot.
      expect(cap.ipmitool_package).toBe("ipmitool 1.8.18-11ubuntu2.2");
    }
  });

  it("FAILS CLOSED on a below-floor ipmitool that no distro package owns", async () => {
    // The hole the 2026-07-29 loosening opened (finding #2, 2026-07-30 review):
    // a source or vendor build is genuinely unpatched, and the wrapper would exec
    // it as ROOT every snapshot. Distro backport reasoning does not cover it.
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.18\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      attributeProvenance: async () => ({
        path: "/usr/local/bin/ipmitool",
        attributed: false,
        package: null,
        detail: "/usr/local/bin/ipmitool is not owned by any dpkg or rpm package, so it is a source, vendor or hand-installed build with no distro backport guarantee",
      }),
    });
    expect(cap.available).toBe(false);
    if (!cap.available) {
      expect(cap.reason).toBe("ipmitool_cve_2020_5208");
      // Must name the offending path: /usr/local/bin SHADOWS /usr/bin in sudo's
      // secure_path, and an operator cannot act on this without knowing which file.
      expect(cap.detail).toContain("/usr/local/bin/ipmitool");
      expect(cap.detail).toContain("refusing to run it as root");
      // Must NOT read as the operator's own opt-in; this one is our decision.
      expect(cap.detail).not.toContain("enforce_ipmitool_min_version");
    }
  });

  it("does not consult provenance at all at or above the floor", async () => {
    // Hosts on 1.8.19+ must pay nothing for the gate: no package-manager execs.
    let called = false;
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.19\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      attributeProvenance: async () => {
        called = true;
        return { path: null, attributed: false, package: null, detail: "should not run" };
      },
    });
    expect(cap.available).toBe(true);
    expect(called).toBe(false);
  });

  it("enforcement short-circuits BEFORE provenance, so an opt-in never depends on dpkg", async () => {
    let called = false;
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.18\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      enforceMinVersion: true,
      attributeProvenance: async () => {
        called = true;
        return { path: "/usr/bin/ipmitool", attributed: true, package: "ipmitool 1.8.18-1", detail: "" };
      },
    });
    expect(cap.available).toBe(false);
    expect(called).toBe(false);
  });

  it("does not set the advisory flag at or above the floor, so healthy snapshots are unchanged", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.19\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
    });
    expect(cap.available).toBe(true);
    if (cap.available) expect(cap.ipmitool_below_cve_floor).toBeUndefined();
  });

  it("still fails closed when an operator opts in via enforceMinVersion", async () => {
    // The escape hatch for anyone who genuinely models BMC compromise. Removing a
    // security control with no way to restore it would not be acceptable.
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.18\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      enforceMinVersion: true,
    });
    expect(cap.available).toBe(false);
    if (!cap.available) {
      expect(cap.reason).toBe("ipmitool_cve_2020_5208");
      expect(cap.detail).toContain("1.8.18");
      // Names the setting, so the operator knows this was their choice.
      expect(cap.detail).toContain("enforce_ipmitool_min_version");
    }
  });

  it("enforcement does not fire at or above the floor", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.19\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      enforceMinVersion: true,
    });
    expect(cap.available).toBe(true);
  });

  it("no_bmc_device when the wrapped sensor probe returns nothing (no BMC / VM)", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.19", stderr: "" }),
      probeSensor: async () => null,
    });
    expect(cap.available).toBe(false);
    if (!cap.available) expect(cap.reason).toBe("no_bmc_device");
  });

  it("no_bmc_device on empty (whitespace-only) sensor output", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.19", stderr: "" }),
      probeSensor: async () => "   \n  ",
    });
    expect(cap.available).toBe(false);
    if (!cap.available) expect(cap.reason).toBe("no_bmc_device");
  });

  it("captures ipmitool version when present", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.21-rc1\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
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

describe("detectIpmiCapability: adversarial review 2026-07-30 round 3", () => {
  const attributed = async () => ({
    path: "/usr/bin/ipmitool", attributed: true,
    package: "ipmitool 1.8.18-11ubuntu2.2", detail: "owned",
  });

  it("FINDING #1: an unparseable version must not bypass the gate", async () => {
    // `ipmitool version vendor-build` used to classify as at-or-above the floor, so
    // provenance was skipped and enforcement ignored, handing an unidentifiable
    // vendor build to the root wrapper.
    let provenanceConsulted = false;
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version vendor-build\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      resolveRootPath: () => "/usr/local/bin/ipmitool",
      attributeProvenance: async () => {
        provenanceConsulted = true;
        return { path: "/usr/local/bin/ipmitool", attributed: false, package: null, detail: "owned by nothing" };
      },
    });
    expect(provenanceConsulted).toBe(true);
    expect(cap.available).toBe(false);
    if (!cap.available) expect(cap.reason).toBe("ipmitool_cve_2020_5208");
  });

  it("FINDING #1: an unparseable version is REFUSED under enforcement", async () => {
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version vendor-build\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      enforceMinVersion: true,
      attributeProvenance: async () => { throw new Error("must not be consulted"); },
    });
    expect(cap.available).toBe(false);
    if (!cap.available) expect(cap.detail).toContain("unrecognisable version");
  });

  it("FINDING #1: an unparseable version still collects when distro-owned", async () => {
    // The cost of failing closed must not land on real fleets with odd version strings.
    const cap = await detectIpmiCapability({
      runIpmitool: async (_bin: string) => ({ stdout: "ipmitool version 1.8.18-csv\n", stderr: "" }),
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      attributeProvenance: attributed,
    });
    expect(cap.available).toBe(true);
  });

  it("FINDING #2: probes the version on the binary sudo would run, not $PATH", async () => {
    // The exact scenario: 1.8.19 first on the service PATH, unowned 1.8.18 first on
    // sudo's secure_path. Judging the wrong file passed the gate.
    const seen: string[] = [];
    const cap = await detectIpmiCapability({
      resolveRootPath: () => "/usr/local/bin/ipmitool",
      runIpmitool: async (bin: string) => {
        seen.push(bin);
        return { stdout: bin === "/usr/local/bin/ipmitool" ? "ipmitool version 1.8.18\n" : "ipmitool version 1.8.19\n", stderr: "" };
      },
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
      attributeProvenance: async () => ({ path: "/usr/local/bin/ipmitool", attributed: false, package: null, detail: "owned by nothing" }),
    });
    expect(seen).toEqual(["/usr/local/bin/ipmitool"]);
    expect(cap.available).toBe(false);
  });

  it("FINDING #2: falls back to bare ipmitool only when secure_path has no match", async () => {
    // Root-direct installs (no sudo wrapper) resolve through the agent's own PATH.
    const seen: string[] = [];
    await detectIpmiCapability({
      resolveRootPath: () => null,
      runIpmitool: async (bin: string) => { seen.push(bin); return { stdout: "ipmitool version 1.8.19\n", stderr: "" }; },
      probeSensor: async () => "CPU Temp | 39.000 | degrees C | ok",
    });
    expect(seen).toEqual(["ipmitool"]);
  });
});

describe("classifyIpmitoolVersion: strict parsing (review round 4, finding #2)", () => {
  it("does NOT treat a prerelease OF THE FLOOR as at-or-above", () => {
    // A prerelease PRECEDES its release, so 1.8.19-rc.1 need not contain the fix.
    // split+parseInt compared it equal to 1.8.19 and waved it through.
    expect(classifyIpmitoolVersion("1.8.19-rc.1")).toBe("unknown");
    expect(classifyIpmitoolVersion("1.8.19-beta")).toBe("unknown");
  });

  it("does NOT let a garbage string outrank the floor", () => {
    // parseInt("2vendor") === 2, so this classified as at_or_above.
    expect(classifyIpmitoolVersion("2vendor")).toBe("unknown");
    expect(classifyIpmitoolVersion("vendor-build")).toBe("unknown");
    expect(classifyIpmitoolVersion("1.8")).toBe("unknown");
  });

  it("still accepts a bare release at the floor and anything above it", () => {
    expect(classifyIpmitoolVersion("1.8.19")).toBe("at_or_above");
    expect(classifyIpmitoolVersion("1.8.20")).toBe("at_or_above");
    // Core strictly above the floor is safe even with a suffix: 1.9.0-rc still
    // contains a fix that landed in 1.8.19.
    expect(classifyIpmitoolVersion("1.9.0-rc")).toBe("at_or_above");
  });

  it("still classifies real distro builds below the floor correctly", () => {
    // These are the strings real fleet hosts report, and they must keep collecting.
    expect(classifyIpmitoolVersion("1.8.18")).toBe("below_floor");
    expect(classifyIpmitoolVersion("1.8.18-11ubuntu2.2")).toBe("below_floor");
    expect(classifyIpmitoolVersion("1.8.18-csv")).toBe("below_floor"); // Rocky 9 reports this
  });
});
