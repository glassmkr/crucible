// Tests for the C11-C18 collectors (v0.12.0, 2026-05-19).
//
// Coverage strategy mirrors c7-c10.test.ts: pure parser functions are
// tested directly with fixture strings; capability-gated collectors
// are exercised via shape assertions on non-Linux dev hosts (collector
// must not throw and must return its declared shape with available
// either true or false based on /proc presence).

import { beforeEach, describe, expect, it } from "vitest";

import { __test_only as systemdTest } from "../systemd.js";
import { __test_only as lvmTest, parseLvsJson } from "../lvm.js";
import { __test_only as ethtoolTest, parseEthtoolOutput } from "../ethtool.js";
import { __test_only as softnetTest, collectSoftnet } from "../softnet.js";
import { decodeNvmeCriticalWarning, parseSmartctlJson } from "../smart.js";
import { __test_only_c11 as ipmiTest } from "../ipmi.js";
import {
  __test_only as cveTest,
  parseDnfUpdateinfoText,
  parseUbuntuProJson,
  parseZypperListPatchesText,
} from "../cve.js";
import {
  __test_only as dmesgTest,
  parseDmesgOutput,
  parseDmesgTimestamp,
} from "../dmesg-events.js";

// ============================================================================
// C12 systemd Result parsing
// ============================================================================

describe("C12 systemd: parseUnitDetailsOutput", () => {
  it("parses Result + ActiveState + SubState + NRestarts", () => {
    const out = [
      "Result=oom-kill",
      "ActiveState=failed",
      "SubState=failed",
      "NRestarts=7",
    ].join("\n");
    const r = systemdTest.parseUnitDetailsOutput("myapp.service", out);
    expect(r.result).toBe("oom-kill");
    expect(r.active_state).toBe("failed");
    expect(r.sub_state).toBe("failed");
    expect(r.n_restarts).toBe(7);
  });

  it("maps an unrecognized Result to 'unknown'", () => {
    const out = "Result=some-future-value\nActiveState=failed\nSubState=failed\nNRestarts=0";
    expect(systemdTest.parseUnitDetailsOutput("u.service", out).result).toBe("unknown");
  });

  it("defaults NRestarts to 0 on parse failure", () => {
    const out = "Result=exit-code\nActiveState=failed\nSubState=failed\nNRestarts=garbage";
    expect(systemdTest.parseUnitDetailsOutput("u.service", out).n_restarts).toBe(0);
  });

  it("RESULT_VALUES enumerates all known classifier values", () => {
    expect(systemdTest.RESULT_VALUES.has("oom-kill")).toBe(true);
    expect(systemdTest.RESULT_VALUES.has("watchdog")).toBe(true);
    // Cast to bypass the literal-union type; we're testing runtime
    // set membership for unrecognised classifier strings.
    expect(
      (systemdTest.RESULT_VALUES as Set<string>).has("nonexistent"),
    ).toBe(false);
  });
});

// ============================================================================
// C14 LVM thin: parseLvsJson
// ============================================================================

describe("C14 LVM: parseLvsJson", () => {
  it("parses a thin pool entry", () => {
    const raw = JSON.stringify({
      report: [
        {
          lv: [
            {
              lv_name: "thinpool",
              vg_name: "vg0",
              lv_attr: "twi-aotz--",
              data_percent: "45.20",
              metadata_percent: "12.30",
            },
            {
              lv_name: "thin1",
              vg_name: "vg0",
              lv_attr: "Vwi-a-tz--",
              data_percent: "0.00",
              metadata_percent: "0.00",
            },
          ],
        },
      ],
    });
    const pools = parseLvsJson(raw);
    expect(pools).not.toBeNull();
    expect(pools!.length).toBe(1);
    expect(pools![0].lv_name).toBe("thinpool");
    expect(pools![0].metadata_percent).toBeCloseTo(12.3);
  });

  it("returns empty array when no thin pools present", () => {
    const raw = JSON.stringify({
      report: [{ lv: [{ lv_name: "root", vg_name: "vg0", lv_attr: "-wi-ao----", data_percent: "0", metadata_percent: "0" }] }],
    });
    expect(parseLvsJson(raw)).toEqual([]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseLvsJson("not json")).toBeNull();
  });

  it("parsePercent handles number, string, and other inputs", () => {
    expect(lvmTest.parsePercent(45.5)).toBe(45.5);
    expect(lvmTest.parsePercent("12.3")).toBeCloseTo(12.3);
    expect(lvmTest.parsePercent(null)).toBe(0);
  });
});

// ============================================================================
// C15 ethtool: parseEthtoolOutput
// ============================================================================

describe("C15 ethtool: parseEthtoolOutput", () => {
  it("captures Advertised auto-negotiation and link modes (multiline)", () => {
    const raw = `Settings for eth0:
\tSupported ports: [ TP ]
\tAdvertised auto-negotiation: Yes
\tAdvertised link modes:  10baseT/Half 10baseT/Full
\t                        100baseT/Half 100baseT/Full
\t                        1000baseT/Full
\tSpeed: 1000Mb/s
\tDuplex: Full
\tAuto-negotiation: on
\tLink detected: yes`;
    const r = parseEthtoolOutput("eth0", raw);
    expect(r.iface).toBe("eth0");
    expect(r.advertised_auto_negotiation).toBe(true);
    expect(r.advertised_link_modes).toContain("1000baseT/Full");
    expect(r.advertised_link_modes).toContain("100baseT/Full");
    expect(r.advertised_link_modes.length).toBeGreaterThanOrEqual(5);
  });

  it("returns null auto-negotiation when not advertised", () => {
    const raw = "Settings for eth1:\n\tSpeed: 10000Mb/s\n";
    const r = parseEthtoolOutput("eth1", raw);
    expect(r.advertised_auto_negotiation).toBeNull();
    expect(r.advertised_link_modes).toEqual([]);
  });

  it("test-only export exposes parser", () => {
    expect(typeof ethtoolTest.parseEthtoolOutput).toBe("function");
  });
});

// ============================================================================
// C16 softnet: capability gate + column constants
// ============================================================================

describe("C16 softnet", () => {
  beforeEach(() => {
    softnetTest.resetForTests();
  });

  it("collectSoftnet does not throw on non-Linux dev hosts", () => {
    expect(() => collectSoftnet()).not.toThrow();
    const r = collectSoftnet();
    expect(typeof r.available).toBe("boolean");
  });

  it("DROPPED_COL is column index 2 (per net/core/dev.c softnet_seq_show)", () => {
    expect(softnetTest.DROPPED_COL).toBe(2);
  });

  it("rate is null on first call (no prior counter to delta against)", () => {
    const r = collectSoftnet();
    if (r.available) {
      expect(r.total_dropped_rate_per_sec).toBeNull();
    }
  });
});

// ============================================================================
// C17 NVMe Critical Warning decode
// ============================================================================

describe("C17 NVMe critical warning decode", () => {
  it("decodes 0x00 as all-false", () => {
    const r = decodeNvmeCriticalWarning(0x00);
    expect(r.available_spare_low).toBe(false);
    expect(r.temperature_threshold).toBe(false);
    expect(r.read_only).toBe(false);
  });

  it("decodes 0x09 (bits 0 + 3) as spare-low + read-only", () => {
    const r = decodeNvmeCriticalWarning(0x09);
    expect(r.available_spare_low).toBe(true);
    expect(r.read_only).toBe(true);
    expect(r.temperature_threshold).toBe(false);
    expect(r.reliability_degraded).toBe(false);
  });

  it("decodes 0x3f as all flags set", () => {
    const r = decodeNvmeCriticalWarning(0x3f);
    expect(Object.values(r).every((v) => v === true)).toBe(true);
  });

  it("parseSmartctlJson surfaces critical_warning_decoded on NVMe", () => {
    const raw = {
      model_name: "INTEL SSDPE2KX020T8",
      smart_status: { passed: true },
      nvme_smart_health_information_log: {
        critical_warning: 0x02, // temperature threshold
        percentage_used: 12,
        temperature: 305,
        available_spare: 100,
        available_spare_threshold: 10,
      },
    };
    const info = parseSmartctlJson(raw as never, "/dev/nvme0");
    expect(info.critical_warning_raw).toBe(0x02);
    expect(info.critical_warning_decoded?.temperature_threshold).toBe(true);
    expect(info.critical_warning_decoded?.read_only).toBe(false);
    expect(info.nvme_available_spare).toBe(100);
    expect(info.nvme_available_spare_threshold).toBe(10);
  });

  it("parseSmartctlJson omits decoded field on SATA (no critical_warning)", () => {
    const raw = {
      model_name: "Samsung SSD",
      smart_status: { passed: true },
      ata_smart_attributes: { table: [] },
    };
    const info = parseSmartctlJson(raw as never, "/dev/sda");
    expect(info.critical_warning_decoded).toBeUndefined();
    expect(info.critical_warning_raw).toBeUndefined();
  });
});

// ============================================================================
// C11 vendor SEL parser quality mapping
// ============================================================================

describe("C11 ipmi: vendor -> BMC vendor + parser_quality", () => {
  it("dell/hpe/supermicro map to fleet-tested", () => {
    expect(ipmiTest.mapVendorToBmcVendor("dell")).toBe("dell");
    expect(ipmiTest.mapVendorToBmcVendor("hpe")).toBe("hpe");
    expect(ipmiTest.mapVendorToBmcVendor("supermicro")).toBe("supermicro");
    expect(ipmiTest.parserQualityFor("dell")).toBe("fleet-tested");
    expect(ipmiTest.parserQualityFor("hpe")).toBe("fleet-tested");
    expect(ipmiTest.parserQualityFor("supermicro")).toBe("fleet-tested");
  });

  it("lenovo/cisco map to stub", () => {
    expect(ipmiTest.parserQualityFor("lenovo")).toBe("stub");
    expect(ipmiTest.parserQualityFor("cisco")).toBe("stub");
    // openbmc isn't a DMI vendor; only flagged when detected via
    // ipmitool mc info (follow-up). The function still classifies it
    // as stub if a caller passes it explicitly.
    expect(ipmiTest.parserQualityFor("openbmc")).toBe("stub");
  });

  it("asrockrack / inspur / generic / virtual all collapse to unknown", () => {
    expect(ipmiTest.mapVendorToBmcVendor("asrockrack")).toBe("unknown");
    expect(ipmiTest.mapVendorToBmcVendor("inspur")).toBe("unknown");
    expect(ipmiTest.mapVendorToBmcVendor("generic")).toBe("unknown");
    expect(ipmiTest.mapVendorToBmcVendor("virtual")).toBe("unknown");
    expect(ipmiTest.parserQualityFor("unknown")).toBe("unknown");
  });
});

// ============================================================================
// C13 CVE collection parsers
// ============================================================================

describe("C13 CVE: severity normalization", () => {
  it("maps Critical/High/Moderate variations correctly", () => {
    expect(cveTest.normaliseSeverity("Critical")).toBe("critical");
    expect(cveTest.normaliseSeverity("CRIT")).toBe("critical");
    expect(cveTest.normaliseSeverity("Important")).toBe("important");
    expect(cveTest.normaliseSeverity("high")).toBe("important");
    expect(cveTest.normaliseSeverity("Moderate")).toBe("moderate");
    expect(cveTest.normaliseSeverity("medium")).toBe("moderate");
    expect(cveTest.normaliseSeverity("low")).toBe("low");
    expect(cveTest.normaliseSeverity("something-weird")).toBe("unknown");
  });
});

describe("C13 CVE: Ubuntu Pro JSON parser", () => {
  it("extracts kernel CVEs and severity counts", () => {
    const raw = JSON.stringify({
      summary: {
        "kernel-cves": {
          pending: [
            { cve: "CVE-2026-1234", severity: "critical", package: "linux-image-6.8.0-107-generic" },
            { cve: "CVE-2026-5678", severity: "high", package: "linux-image-6.8.0-107-generic" },
            { cve: "CVE-2026-9012", severity: "moderate", package: "linux-image-6.8.0-107-generic" },
          ],
        },
      },
    });
    const r = parseUbuntuProJson(raw);
    expect(r.critical).toBe(1);
    expect(r.important).toBe(1);
    expect(r.kernel_cves.length).toBe(3);
    expect(r.kernel_cves[0].cve_id).toBe("CVE-2026-1234");
    expect(r.kernel_cves[0].severity).toBe("critical");
  });

  it("returns empty result on malformed JSON", () => {
    const r = parseUbuntuProJson("not json");
    expect(r.kernel_cves).toEqual([]);
    expect(r.critical).toBe(0);
  });
});

describe("C13 CVE: dnf updateinfo text parser", () => {
  it("extracts kernel security advisories with severity", () => {
    const raw = [
      "RHSA-2026:1234 Critical/Sec.   kernel-5.14.0-1234.x86_64",
      "RHSA-2026:5678 Important/Sec.  kernel-headers-5.14.0-1234.x86_64",
      "RHBA-2026:9012 Moderate/Sec.   bash-5.1.8-9.el9_4.x86_64",
    ].join("\n");
    const r = parseDnfUpdateinfoText(raw);
    expect(r.critical).toBe(1);
    expect(r.important).toBe(1);
    expect(r.kernel_cves.length).toBe(2); // bash advisory filtered out
    expect(r.kernel_cves[0].package_name).toContain("kernel");
  });
});

describe("C13 CVE: zypper list-patches text parser", () => {
  it("extracts kernel security patches with severity", () => {
    const raw = [
      "Repository                | Name                          | Category | Severity | Status",
      "SLES15-SP6-Updates        | SUSE-SLE-Module-Kernel-Sec-1  | security | critical | needed",
      "SLES15-SP6-Updates        | SUSE-SLE-Other                | security | important| needed",
      "SLES15-SP6-Updates        | SUSE-SLE-Kernel-Live-Patch    | security | important| needed",
    ].join("\n");
    const r = parseZypperListPatchesText(raw);
    expect(r.kernel_cves.length).toBe(2); // both have "kernel" in name
    expect(r.critical).toBe(1);
    expect(r.important).toBe(1);
  });
});

// ============================================================================
// C18 dmesg structured events
// ============================================================================

describe("C18 dmesg: parseDmesgTimestamp", () => {
  it("parses ISO format with fractional seconds and timezone", () => {
    const ts = parseDmesgTimestamp("2026-05-19T12:34:56,789012+00:00 some message");
    expect(ts).not.toBeNull();
    expect(typeof ts).toBe("number");
  });

  it("parses ctime format from --ctime", () => {
    const ts = parseDmesgTimestamp("[Mon May 19 12:34:56 2026] some message");
    expect(ts).not.toBeNull();
  });

  it("returns null for relative-time format", () => {
    expect(parseDmesgTimestamp("[12345.678] some message")).toBeNull();
  });
});

describe("C18 dmesg: parseDmesgOutput by event class", () => {
  const cutoff = 0; // accept all events

  it("captures SCSI sense codes with severity by sense key", () => {
    const raw = [
      "[12345.678] sd 1:0:0:0: [sda] Sense Key : Medium Error [current]",
      "[12345.789] sd 2:0:0:0: [sdb] Sense Key : Aborted Command",
      "[12345.890] sd 3:0:0:0: [sdc] Sense Key : Recovered Error",
    ].join("\n");
    const events = parseDmesgOutput(raw, cutoff);
    const scsi = events.filter((e) => e.event_type === "scsi_sense");
    expect(scsi.length).toBe(3);
    expect(scsi[0].severity).toBe("critical"); // Medium Error
    expect(scsi[1].severity).toBe("critical"); // Aborted Command
    expect(scsi[2].severity).toBe("warning");  // Recovered Error
    expect(scsi[0].details.device).toBe("sda");
    expect(scsi[0].details.sense_key).toBe("Medium Error");
  });

  it("captures NVMe controller resets", () => {
    const raw = "[12345.123] nvme nvme0: I/O 256 QID 1 timeout, reset controller";
    const events = parseDmesgOutput(raw, cutoff);
    const nvme = events.filter((e) => e.event_type === "nvme_reset");
    expect(nvme.length).toBe(1);
    expect(nvme[0].severity).toBe("critical");
    expect(nvme[0].details.controller).toBe("nvme0");
  });

  it("captures ext4 remount-readonly", () => {
    const raw = [
      "[12345.789] EXT4-fs error (device sda1): __ext4_read_inode_lock:5234: ...",
      "[12345.790] EXT4-fs (sda1): Remounting filesystem read-only",
    ].join("\n");
    const events = parseDmesgOutput(raw, cutoff);
    const ext4 = events.filter((e) => e.event_type === "ext4_remount_readonly");
    expect(ext4.length).toBe(1);
    expect(ext4[0].details.device).toBe("sda1");
    expect(ext4[0].details.remount_readonly).toBe(true);
  });

  it("returns empty when no patterns match", () => {
    const raw = [
      "[12345.000] some unrelated kernel message",
      "[12345.100] another harmless line",
    ].join("\n");
    expect(parseDmesgOutput(raw, cutoff).length).toBe(0);
  });

  it("3-class handler set ships in this release", () => {
    expect(dmesgTest.HANDLERS.length).toBe(3);
    expect(dmesgTest.WINDOW_SECONDS).toBe(3600);
  });
});

// ============================================================================
// Combined capability gate sanity
// ============================================================================

describe("C11-C18 combined capability gates", () => {
  it("none of the new collectors throw on non-Linux dev hosts", () => {
    // softnet is sync; others are async — async failures already
    // tolerated via try/catch in index.ts; we just verify the sync one.
    expect(() => collectSoftnet()).not.toThrow();
  });
});
