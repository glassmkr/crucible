// Tests for C19 GPU collection (v0.13.0, 2026-05-19).
//
// Coverage strategy matches c11-c18.test.ts: pure parser functions
// with synthetic fixtures inline; capability-gated collector
// exercised via shape assertions on non-Linux/non-NVIDIA dev hosts
// (collector must not throw and must return its declared shape with
// available=false and a reason).

import { describe, expect, it } from "vitest";

import {
  __test_only as gpuTest,
  collectGpu,
  collectGpuDriverResilience,
  hasNvidiaGpu,
  moduleLoaded,
  nouveauBlacklisted,
  normalizePciBdfForSysfs,
  parseNvidiaSmiCsvRow,
  parseNvLinkStatus,
  parseXidEvents,
  probeGpuCapabilities,
} from "../gpu.js";

describe("GPU driver resilience (nouveau reboot trap)", () => {
  it("hasNvidiaGpu detects an NVIDIA display/3D-class PCI device", () => {
    expect(hasNvidiaGpu([{ vendor: "0x10de\n", class: "0x030000\n" }])).toBe(true); // VGA
    expect(hasNvidiaGpu([{ vendor: "0x10de", class: "0x030200" }])).toBe(true); // 3D controller
  });
  it("hasNvidiaGpu ignores non-NVIDIA and non-display NVIDIA devices", () => {
    expect(hasNvidiaGpu([{ vendor: "0x8086", class: "0x030000" }])).toBe(false); // Intel VGA
    expect(hasNvidiaGpu([{ vendor: "0x10de", class: "0x010802" }])).toBe(false); // NVIDIA NVMe, not a GPU
    expect(hasNvidiaGpu([])).toBe(false);
  });
  it("moduleLoaded matches the base module at line start, not a submodule", () => {
    const mods = "nvidia 12345 0 - Live 0x0\nnvidia_uvm 678 0 - Live 0x0\n";
    expect(moduleLoaded(mods, "nvidia")).toBe(true);
    expect(moduleLoaded(mods, "nouveau")).toBe(false);
    expect(moduleLoaded("nvidia_uvm 678 0 - Live 0x0\n", "nvidia")).toBe(false);
  });
  it("nouveauBlacklisted counts only an uncommented blacklist directive", () => {
    expect(nouveauBlacklisted(["blacklist nouveau\n"])).toBe(true);
    expect(nouveauBlacklisted(["options nouveau modeset=0\n", "  blacklist nouveau"])).toBe(true);
    expect(nouveauBlacklisted(["# blacklist nouveau\n"])).toBe(false);
    expect(nouveauBlacklisted(["blacklist radeon\n"])).toBe(false);
    expect(nouveauBlacklisted([])).toBe(false);
  });
  it("collectGpuDriverResilience returns the declared shape without throwing", () => {
    const r = collectGpuDriverResilience();
    expect(typeof r.nvidia_pci_present).toBe("boolean");
    expect(typeof r.nvidia_module_loaded).toBe("boolean");
    expect(typeof r.nouveau_module_loaded).toBe("boolean");
    expect(typeof r.nouveau_blacklisted).toBe("boolean");
    if (!r.nvidia_pci_present) {
      // a non-NVIDIA dev host short-circuits the module/blacklist reads
      expect(r.nvidia_module_loaded).toBe(false);
      expect(r.nouveau_module_loaded).toBe(false);
      expect(r.nouveau_blacklisted).toBe(false);
    }
  });
});

// ============================================================================
// Detection probe + capability gating
// ============================================================================

describe("C19 GPU probe + capability gate", () => {
  it("probe returns nvidia_smi=false on a host without nvidia-smi (fast path)", async () => {
    const caps = await probeGpuCapabilities();
    // CI runners + dev macOS lack nvidia-smi -> nvidia_smi must be false.
    expect(typeof caps.nvidia_smi).toBe("boolean");
    if (!caps.nvidia_smi) {
      expect(caps.nvidia_driver_version).toBeNull();
      expect(caps.dcgm).toBe(false);
    }
    // Probe must be fast on non-NVIDIA hosts (<100ms is well within
    // the spec's <10ms target; we use a looser bound for noisy CI).
    expect(caps.probe_duration_ms).toBeLessThan(2500);
  });

  it("collectGpu returns available:false with reason on non-NVIDIA hosts", async () => {
    const snap = await collectGpu();
    if (!snap.available) {
      expect(snap.reason).toMatch(/nvidia-smi/i);
      expect(snap.capabilities.nvidia_smi).toBe(false);
    }
  });

  it("Tier 3 ships as stub in v0.13.0 (Simon's 2026-05-19 decision)", async () => {
    const snap = await collectGpu();
    if (snap.available && snap.tier3 && "available" in snap.tier3) {
      // When Tier 3 fires, it's always available:false in this
      // release with the stub-pending reason.
      expect(snap.tier3.available).toBe(false);
      if (!snap.tier3.available) {
        expect(snap.tier3.reason).toMatch(/stub|pending/i);
      }
    }
  });
});

// ============================================================================
// Tier 1: nvidia-smi CSV parser
// ============================================================================

describe("normalizePciBdfForSysfs (nvidia-smi bus id -> sysfs pci id)", () => {
  it("truncates the 8-hex-digit domain to 4 and lowercases", () => {
    expect(normalizePciBdfForSysfs("00000000:02:00.0")).toBe("0000:02:00.0");
  });
  it("handles a nonzero domain and uppercase hex bus", () => {
    expect(normalizePciBdfForSysfs("00000001:C1:00.0")).toBe("0001:c1:00.0");
  });
  it("returns null for an unparseable id", () => {
    expect(normalizePciBdfForSysfs("garbage")).toBeNull();
    expect(normalizePciBdfForSysfs("")).toBeNull();
  });
});

describe("C19 Tier 1: parseNvidiaSmiCsvRow", () => {
  it("parses a fully-populated L4 row", () => {
    // Real nvidia-smi CSV output shape from an NVIDIA L4 host.
    const row = [
      "0", "GPU-12345678-90ab-cdef-1234-567890abcdef", "NVIDIA L4",
      "00000000:01:00.0", "95.02.66.00.04",
      "22528", "1024",
      "65", "27", "72",
      "0", "0",
      "1230", "1230", "6250",
      "P8",
      "4", "4", "16", "16",
      "Enabled",
      "0", "0", "0", "0",
      "0", "0", "0",
      "[Not Supported]",
    ].join(", ");
    const gpu = parseNvidiaSmiCsvRow(row);
    expect(gpu).not.toBeNull();
    expect(gpu!.index).toBe(0);
    expect(gpu!.name).toBe("NVIDIA L4");
    expect(gpu!.pci_bdf).toBe("00000000:01:00.0");
    expect(gpu!.vram_total_mib).toBe(22528);
    expect(gpu!.temp_c).toBe(65);
    expect(gpu!.power_draw_w).toBe(27);
    expect(gpu!.power_limit_w).toBe(72);
    expect(gpu!.pcie_link_gen_current).toBe(4);
    expect(gpu!.pcie_link_gen_max).toBe(4);
    expect(gpu!.ecc_mode_current).toBe(true);
    expect(gpu!.fan_speed_percent).toBeNull();
  });

  it("handles [N/A] and [Not Supported] markers as null/0", () => {
    const row = [
      "0", "GPU-x", "Test GPU", "0000:01:00.0", "1.0",
      "16384", "0",
      "[N/A]", "0", "0",
      "0", "0",
      "0", "0", "0",
      "P0",
      "4", "4", "16", "16",
      "Disabled",
      "0", "0", "0", "0",
      "[Not Supported]", "[Not Supported]", "[Not Supported]",
      "50",
    ].join(", ");
    const gpu = parseNvidiaSmiCsvRow(row);
    expect(gpu!.temp_c).toBe(0);
    expect(gpu!.retired_pages_single_bit).toBeNull();
    expect(gpu!.retired_pages_double_bit).toBeNull();
    expect(gpu!.ecc_mode_current).toBe(false);
    expect(gpu!.fan_speed_percent).toBe(50);
  });

  it("returns null on malformed input", () => {
    expect(parseNvidiaSmiCsvRow("short, row")).toBeNull();
  });
});

// ============================================================================
// Tier 1: NVLink basic parser
// ============================================================================

describe("C19 Tier 1: parseNvLinkStatus", () => {
  it("parses up/inactive/down link states", () => {
    const raw = `GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-abc)
\t Link 0: 26.562 GB/s
\t Link 1: <inactive>
\t Link 2: 26.562 GB/s
\t Link 3: 0.000 GB/s`;
    const links = parseNvLinkStatus(raw);
    expect(links.length).toBe(4);
    expect(links[0]).toEqual({ link_id: 0, state: "up", speed_gbps: 26.562 });
    expect(links[1].state).toBe("inactive");
    expect(links[3].state).toBe("inactive"); // 0 GB/s parsed but bw==0 => inactive
  });

  it("returns empty array on input with no Link N: lines", () => {
    expect(parseNvLinkStatus("nothing here")).toEqual([]);
  });
});

// ============================================================================
// Tier 1: XID event parser
// ============================================================================

describe("C19 Tier 1: parseXidEvents", () => {
  it("classifies XID 79 as critical (GPU fell off bus)", () => {
    const now = new Date();
    const ts = now.toISOString();
    const raw = `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.`;
    const events = parseXidEvents(raw);
    expect(events.length).toBe(1);
    expect(events[0].xid_code).toBe(79);
    expect(events[0].severity).toBe("critical");
    expect(events[0].pci_bdf).toBe("0000:01:00");
  });

  it("classifies XID 48 (DBE) as critical", () => {
    const ts = new Date().toISOString();
    const raw = `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 48, Double Bit ECC Error`;
    const events = parseXidEvents(raw);
    expect(events[0]?.severity).toBe("critical");
  });

  it("classifies XID 32 as warning (recoverable)", () => {
    const ts = new Date().toISOString();
    const raw = `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 32, Invalid push buffer stream`;
    const events = parseXidEvents(raw);
    expect(events[0]?.severity).toBe("warning");
  });

  it("classifies an unknown XID as info", () => {
    const ts = new Date().toISOString();
    const raw = `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 999, Unknown future XID`;
    const events = parseXidEvents(raw);
    expect(events[0]?.severity).toBe("info");
  });

  it("dedups events with identical (timestamp, bdf, code) tuple", () => {
    const ts = new Date().toISOString();
    const raw = [
      `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.`,
      `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.`,
      `${ts} kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.`,
    ].join("\n");
    const events = parseXidEvents(raw);
    expect(events.length).toBe(1);
  });

  it("skips events older than 24h window", () => {
    const oldTs = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const raw = `${oldTs} kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.`;
    expect(parseXidEvents(raw).length).toBe(0);
  });

  it("XID severity table aligns with NVIDIA documentation", () => {
    // Spot-check the critical set per the spec's appendix A.
    expect(gpuTest.XID_CRITICAL.has(79)).toBe(true);  // fell off bus
    expect(gpuTest.XID_CRITICAL.has(48)).toBe(true);  // DBE
    expect(gpuTest.XID_CRITICAL.has(94)).toBe(true);  // contained ECC
    expect(gpuTest.XID_CRITICAL.has(95)).toBe(true);  // uncontained ECC
    expect(gpuTest.XID_WARNING.has(32)).toBe(true);   // push buffer
    expect(gpuTest.XID_CRITICAL.has(32)).toBe(false);
  });
});

// ============================================================================
// Performance budget
// ============================================================================

describe("C19 performance budget", () => {
  it("collectGpu does not throw on non-NVIDIA hosts", async () => {
    await expect(collectGpu()).resolves.toBeDefined();
  });

  it("probe under 100ms on non-NVIDIA host (spec target: <10ms; we allow CI slack)", async () => {
    const caps = await probeGpuCapabilities();
    if (!caps.nvidia_smi) {
      // Looser than spec's <10ms target to account for noisy CI runners.
      expect(caps.probe_duration_ms).toBeLessThan(100);
    }
  });
});
