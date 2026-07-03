import { describe, it, expect } from "vitest";
import { allRules } from "../rules.js";
import type { Snapshot } from "../../lib/types.js";

const baseThresholds = {
  ram_percent: 90,
  swap_alert: true,
  disk_percent: 85,
  iowait_percent: 20,
  nvme_wear_percent: 85,
  disk_latency_nvme_ms: 50,
  disk_latency_hdd_ms: 200,
  cpu_temp_warning_c: 80,
  cpu_temp_critical_c: 90,
  interface_utilization_percent: 90,
};

function emptySnap(): Snapshot {
  return {
    collector_version: "test",
    timestamp: "2026-01-01T00:00:00Z",
    system: { hostname: "h", ip: "1.2.3.4", os: "linux", kernel: "6.0", uptime_seconds: 1000 },
    cpu: { user_percent: 0, system_percent: 0, iowait_percent: 0, idle_percent: 100, load_1m: 0, load_5m: 0, load_15m: 0 },
    memory: { total_mb: 16384, used_mb: 1000, available_mb: 15000, free_mb: 14000, swap_total_mb: 0, swap_used_mb: 0 },
    disks: [],
    smart: [],
    network: [],
    raid: [],
    ipmi: { available: false, sensors: [], ecc_errors: { correctable: 0, uncorrectable: 0 }, sel_entries_count: 0, sel_events_recent: [], fans: [] },
    os_alerts: { oom_kills_recent: 0, zombie_processes: 0, time_drift_ms: 0 },
  };
}

const diskLatencyRule = allRules.find(r => r.type === "disk_latency_high")!;
const swapHighRule = allRules.find(r => r.type === "swap_high")!;

describe("swap_high (formerly swap_active)", () => {
  it("does not fire when no swap is in use", () => {
    const snap = emptySnap();
    expect(swapHighRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("fires warning when swap is in use", () => {
    const snap = emptySnap();
    snap.memory.swap_used_mb = 128;
    const out = swapHighRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].type).toBe("swap_high");
    expect(out[0].evidence.swap_used_mb).toBe(128);
  });

  it("respects t.swap_alert=false", () => {
    const snap = emptySnap();
    snap.memory.swap_used_mb = 128;
    expect(swapHighRule.evaluate(snap, { ...baseThresholds, swap_alert: false })).toEqual([]);
  });
});
const cpuTempRule = allRules.find(r => r.type === "cpu_temperature_high")!;
const eccRule = allRules.find(r => r.type === "ecc_errors")!;
const psuRule = allRules.find(r => r.type === "psu_redundancy_loss")!;

describe("ecc_errors (Dell-style SEL path)", () => {
  it("fires when SEL ECC counts are higher than named-sensor counts", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true, sensors: [],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      ecc_errors_from_sel: { correctable: 3, uncorrectable: 0, newest_event_timestamp: "2026-04-05T14:31:00Z" },
      sel_entries_count: 3, sel_events_recent: [], fans: [],
    };
    const out = eccRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence.source).toBe("ipmi_sel");
    expect(out[0].evidence.correctable).toBe(3);
  });

  it("uses named-sensor source when those counts exceed SEL", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true, sensors: [],
      ecc_errors: { correctable: 5, uncorrectable: 0 },
      ecc_errors_from_sel: { correctable: 0, uncorrectable: 0, newest_event_timestamp: null },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = eccRule.evaluate(snap, baseThresholds);
    expect(out[0].evidence.source).toBe("ipmi_sensors");
    expect(out[0].evidence.correctable).toBe(5);
  });

  it("does not double-count when both sources are populated; uses max", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true, sensors: [],
      ecc_errors: { correctable: 2, uncorrectable: 0 },
      ecc_errors_from_sel: { correctable: 5, uncorrectable: 0, newest_event_timestamp: "2026-04-05T14:31:00Z" },
      sel_entries_count: 5, sel_events_recent: [], fans: [],
    };
    const out = eccRule.evaluate(snap, baseThresholds);
    expect(out[0].evidence.correctable).toBe(5); // max(2, 5)
  });

  it("escalates to critical on uncorrectable from SEL", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true, sensors: [],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      ecc_errors_from_sel: { correctable: 0, uncorrectable: 1, newest_event_timestamp: "2026-04-05T14:31:00Z" },
      sel_entries_count: 1, sel_events_recent: [], fans: [],
    };
    const out = eccRule.evaluate(snap, baseThresholds);
    expect(out[0].severity).toBe("critical");
  });

  it("does not fire when both sources are zero", () => {
    const snap = emptySnap();
    snap.ipmi.available = true;
    expect(eccRule.evaluate(snap, baseThresholds)).toEqual([]);
  });
});

describe("psu_redundancy_loss (Dell + Supermicro)", () => {
  it("fires from aggregate redundancy state on Dell even if individual PS sensors look OK", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "dell", raw_vendor: "Dell Inc.", product_name: "PowerEdge R740", bios_version: "2.21", bios_date: "2024-08-15", is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1 Status", value: "0x01", unit: "discrete", status: "ok" },
        { name: "PS2 Status", value: "0x01", unit: "discrete", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      psu_redundancy_state: "redundancy_lost",
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.source).toBe("aggregate_sensor");
    expect(out[0].evidence.redundancy_state).toBe("redundancy_lost");
  });

  it("fires from per-PSU status on Dell when redundancy state is not set", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "dell", raw_vendor: "Dell Inc.", product_name: "PowerEdge R740", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1 Status", value: "0x01", unit: "discrete", status: "ok" },
        { name: "PS2 Status", value: "Failure detected", unit: "discrete", status: "failure" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.source).toBe("per_psu_sensors");
    expect(out[0].evidence.vendor).toBe("dell");
  });

  it("fires on Supermicro PSU1 Status critical (no regression from old behaviour)", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "absent", unit: "discrete", status: "absent" },
        { name: "PSU2 Status", value: "OK", unit: "discrete", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.vendor).toBe("supermicro");
  });

  it("does not fire on a VM with no PSU sensors", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "virtual", raw_vendor: "QEMU", product_name: "Standard PC", bios_version: null, bios_date: null, is_virtual: true };
    snap.ipmi = {
      available: true, sensors: [], ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does not fire when fully redundant on Dell", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "dell", raw_vendor: "Dell Inc.", product_name: "PowerEdge R740", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1 Status", value: "0x01", unit: "discrete", status: "ok" },
        { name: "PS2 Status", value: "0x01", unit: "discrete", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      psu_redundancy_state: "fully_redundant",
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });
});

describe("cpu_temperature_high (hwmon path)", () => {
  it("fires from hwmon when no IPMI is available (Pi)", () => {
    const snap = emptySnap();
    snap.thermal = {
      available: true, source: "hwmon",
      cpu_readings: [{ label: "cpu_thermal temp1", value_celsius: 85, source_chip: "cpu_thermal", source: "hwmon" }],
      other_readings: [], max_cpu_celsius: 85,
    };
    const out = cpuTempRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence.source).toBe("hwmon");
    expect(out[0].evidence.chip).toBe("cpu_thermal");
  });

  it("fires critical when value_celsius >= cpu_temp_critical_c", () => {
    const snap = emptySnap();
    snap.thermal = {
      available: true, source: "hwmon",
      cpu_readings: [{ label: "coretemp Package id 0", value_celsius: 95, source_chip: "coretemp", source: "hwmon" }],
      other_readings: [], max_cpu_celsius: 95,
    };
    const out = cpuTempRule.evaluate(snap, baseThresholds);
    expect(out[0].severity).toBe("critical");
  });

  it("does not fire when max_cpu_celsius is null (VM)", () => {
    const snap = emptySnap();
    snap.thermal = { available: true, source: "none", cpu_readings: [], other_readings: [], max_cpu_celsius: null };
    expect(cpuTempRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("falls back to IPMI substring filter when hwmon is unavailable", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true, ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
      sensors: [{ name: "CPU1 Temp", value: 85, unit: "degrees C", status: "ok" }],
    };
    const out = cpuTempRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.source).toBe("ipmi");
  });

  it("hwmon takes priority over IPMI when both are present", () => {
    const snap = emptySnap();
    snap.thermal = {
      available: true, source: "hwmon",
      cpu_readings: [{ label: "coretemp Package id 0", value_celsius: 88, source_chip: "coretemp", source: "hwmon" }],
      other_readings: [], max_cpu_celsius: 88,
    };
    snap.ipmi = {
      available: true, ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
      sensors: [{ name: "CPU1 Temp", value: 99, unit: "degrees C", status: "ok" }],
    };
    const out = cpuTempRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.source).toBe("hwmon");
    expect(out[0].evidence.value).toBe(88);
  });
});

describe("disk_latency_high", () => {
  it("does not fire when io_latency is missing", () => {
    const snap = emptySnap();
    expect(diskLatencyRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does not fire when io_latency is empty", () => {
    const snap = emptySnap();
    snap.io_latency = [];
    expect(diskLatencyRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does not fire on healthy NVMe (1ms)", () => {
    const snap = emptySnap();
    snap.io_latency = [
      { device: "nvme0n1", avg_read_latency_ms: 1, avg_write_latency_ms: 0.5, read_iops: 100, write_iops: 50 },
    ];
    expect(diskLatencyRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("fires on hot NVMe (60ms read on default 50ms threshold)", () => {
    const snap = emptySnap();
    snap.io_latency = [
      { device: "nvme0n1", avg_read_latency_ms: 60, avg_write_latency_ms: 1, read_iops: 100, write_iops: 50 },
    ];
    const out = diskLatencyRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence.device).toBe("nvme0n1");
    expect(out[0].evidence.threshold_ms).toBe(50);
  });

  it("fires on hot SATA HDD (250ms write on default 200ms threshold)", () => {
    const snap = emptySnap();
    snap.io_latency = [
      { device: "sda", avg_read_latency_ms: 10, avg_write_latency_ms: 250, read_iops: 5, write_iops: 20 },
    ];
    const out = diskLatencyRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.device).toBe("sda");
    expect(out[0].evidence.threshold_ms).toBe(200);
  });

  it("does not fire on borderline-cold SATA (180ms vs 200ms threshold)", () => {
    const snap = emptySnap();
    snap.io_latency = [
      { device: "sda", avg_read_latency_ms: 180, avg_write_latency_ms: 50, read_iops: 5, write_iops: 5 },
    ];
    expect(diskLatencyRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("fires once per hot device when multiple devices present", () => {
    const snap = emptySnap();
    snap.io_latency = [
      { device: "nvme0n1", avg_read_latency_ms: 1, avg_write_latency_ms: 1, read_iops: 100, write_iops: 50 }, // healthy
      { device: "sda", avg_read_latency_ms: 300, avg_write_latency_ms: 10, read_iops: 5, write_iops: 5 }, // hot HDD
      { device: "nvme1n1", avg_read_latency_ms: 80, avg_write_latency_ms: 0.5, read_iops: 100, write_iops: 50 }, // hot NVMe
    ];
    const out = diskLatencyRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(2);
    expect(out.map(a => a.evidence.device).sort()).toEqual(["nvme1n1", "sda"]);
  });

  it("skips devices with zero IOPS over the interval (no samples)", () => {
    const snap = emptySnap();
    snap.io_latency = [
      { device: "sda", avg_read_latency_ms: null, avg_write_latency_ms: null, read_iops: 0, write_iops: 0 },
    ];
    expect(diskLatencyRule.evaluate(snap, baseThresholds)).toEqual([]);
  });
});

const sshConfigUnappliedRule = allRules.find(r => r.type === "ssh_config_unapplied")!;

function snapWithSsh(ssh: any): Snapshot {
  const s = emptySnap();
  (s as any).security = {
    ssh,
    firewall: { active: true, source: "ufw", details: "" },
    pending_updates: null,
    kernel_vulns: [],
    kernel_reboot: null,
    auto_updates: { configured: true, mechanism: "", details: "" },
  };
  return s;
}

describe("ssh_config_unapplied (config-vs-runtime false-negative guard)", () => {
  it("fires when the on-disk config is newer than the running daemon", () => {
    const snap = snapWithSsh({ permitRootLogin: "prohibit-password", passwordAuthentication: "no", rootPasswordExposed: false, configApplied: false, configMtime: 200, configLoadedAt: 100 });
    const out = sshConfigUnappliedRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("ssh_config_unapplied");
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence.configLoadedAt).toBe(100);
  });

  it("does not fire once the daemon has reloaded (configApplied true)", () => {
    const snap = snapWithSsh({ permitRootLogin: "prohibit-password", passwordAuthentication: "no", rootPasswordExposed: false, configApplied: true });
    expect(sshConfigUnappliedRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does not fire when configApplied is absent (pre-0.13.16 agents)", () => {
    const snap = snapWithSsh({ permitRootLogin: "yes", passwordAuthentication: "yes", rootPasswordExposed: true });
    expect(sshConfigUnappliedRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does not fire when there is no ssh block", () => {
    expect(sshConfigUnappliedRule.evaluate(emptySnap(), baseThresholds)).toEqual([]);
  });
});

describe("ALL_RULE_IDS export sync", () => {
  it("matches the actual rule definitions in allRules", async () => {
    const { ALL_RULE_IDS } = await import("../rules.js");
    const idsFromArray = allRules.map(r => r.type);
    expect([...ALL_RULE_IDS]).toEqual(idsFromArray);
  });

  it("matches the static rule-ids.json file (npm-published metadata)", async () => {
    const { ALL_RULE_IDS } = await import("../rules.js");
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const json = JSON.parse(await fs.readFile(path.resolve(here, "../../../rule-ids.json"), "utf-8"));
    expect(json.rule_ids).toEqual([...ALL_RULE_IDS]);
  });
});

describe("cpu_temperature_high IPMI fallback unit gate (regression for 0.8.0 P1)", () => {
  it("does NOT fire on CPU_FAN at 2000 RPM (would have alerted as 2000°C critical)", () => {
    const snap = emptySnap();
    // hwmon empty => fallback path runs
    snap.thermal = { available: true, source: "none", cpu_readings: [], other_readings: [], max_cpu_celsius: null };
    snap.ipmi = {
      available: true,
      sensors: [{ name: "CPU_FAN1", value: 2000, unit: "RPM", status: "ok" }],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(cpuTempRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does NOT fire on CPU Vcore at 1.2 V", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true,
      sensors: [{ name: "CPU Vcore", value: 1.2, unit: "Volts", status: "ok" }],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(cpuTempRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("excludes ambient/inlet/PCH/DIMM sensors that read in degrees C", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "Inlet Temp", value: 88, unit: "degrees C", status: "ok" }, // not CPU
        { name: "PCH Temp", value: 92, unit: "degrees C", status: "ok" },
        { name: "DIMM A1 Temp", value: 90, unit: "degrees C", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(cpuTempRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("still fires on legitimate CPU temperature sensor with degrees C unit", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true,
      sensors: [{ name: "CPU1 Temp", value: 88, unit: "degrees C", status: "ok" }],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = cpuTempRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.source).toBe("ipmi");
    expect(out[0].evidence.unit).toBe("degrees C");
  });

  it("accepts the SI 'C' / '°C' unit spellings", () => {
    const snap = emptySnap();
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "Processor 1 Temp", value: 85, unit: "C", status: "ok" },
        { name: "CPU2 Temp", value: 87, unit: "°C", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = cpuTempRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(2);
  });
});

describe("psu_redundancy_loss cr/nr discrete codes (regression for 0.8.0 P1)", () => {
  it("fires on Supermicro PSU1 with status='cr'", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "0x02", unit: "discrete", status: "cr" },
        { name: "PSU2 Status", value: "0x01", unit: "discrete", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.vendor).toBe("supermicro");
  });

  it("fires on Dell PS<N> with status='nr'", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "dell", raw_vendor: "Dell Inc.", product_name: "PowerEdge R740", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1 Status", value: "0x01", unit: "discrete", status: "ok" },
        { name: "PS2 Status", value: "0x02", unit: "discrete", status: "nr" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
  });

  it("does NOT fire on status='nc' (non-critical, e.g. derating)", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "0x01", unit: "discrete", status: "nc" },
        { name: "PSU2 Status", value: "0x01", unit: "discrete", status: "ok" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });
});

describe("psu_redundancy_loss bitmask path (regression for glassmkr#29)", () => {
  // Per IPMI 2.0 spec for sensor type 0x08 (Power Supply):
  //   bit 1 (0x02): Power Supply Failure detected
  //   bit 3 (0x08): Power Supply input lost (AC/DC)
  //
  // The pre-fix rule only matched text "fail"/"absent" and the short
  // status codes "cr"/"nr", so every BMC that reports discrete states
  // as hex bitmask values in the Reading column was a silent
  // false-negative.

  it("fires when bit 1 (Failure detected) is asserted in Reading", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "generic", raw_vendor: "GIGABYTE", product_name: "MC12-LE0", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1_Status", value: "0x02", unit: "discrete", status: "0x0180" },
        { name: "PS2_Status", value: "0x01", unit: "discrete", status: "0x0180" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect(out[0].evidence.source).toBe("per_psu_sensors");
    expect(out[0].evidence.failed).toEqual([
      { name: "PS1_Status", status: "0x0180", value: "0x02" },
    ]);
  });

  it("fires when bit 3 (AC lost) is asserted", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11SSL", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "0x08", unit: "discrete", status: "0x0100" },
        { name: "PSU2 Status", value: "0x01", unit: "discrete", status: "0x0100" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect((out[0].evidence.failed as Array<{ value: string }>)[0].value).toBe("0x08");
  });

  it("does NOT fire on the healthy/ambiguous Reading=0x0 + mask without presence bit (under-report safe default)", () => {
    // mz62hd / x570d4u / x12qch shape: mask doesn't include bit 0, so a
    // Reading of 0x0 is ambiguous between "PSU absent" and "PSU healthy
    // with no events asserted". Crucible prefers under-report.
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "generic", raw_vendor: "GIGABYTE", product_name: "H262-Z63", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1_Status", value: "0x00", unit: "discrete", status: "0x0180" },
        { name: "PS2_Status", value: "0x00", unit: "discrete", status: "0x0180" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("DOES fire when mask supports presence (bit 0) but Reading lacks it (PSU absent)", () => {
    // If a BMC says it can report bit 0 (mask & 0x01) and the Reading
    // is 0x0, the PSU is genuinely absent. Catch it.
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "0x00", unit: "discrete", status: "0x0181" },
        { name: "PSU2 Status", value: "0x01", unit: "discrete", status: "0x0181" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    const out = psuRule.evaluate(snap, baseThresholds);
    expect(out).toHaveLength(1);
    expect((out[0].evidence.failed as Array<{ name: string }>)[0].name).toBe("PSU1 Status");
  });

  it("does NOT fire on healthy 0x01 (Presence detected, no failure bits) on either PSU", () => {
    // Standard healthy shape on Supermicro h12sst, Gigabyte mc12le.
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "H12SST", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PS1 Status", value: "0x01", unit: "discrete", status: "0x0100" },
        { name: "PS2 Status", value: "0x01", unit: "discrete", status: "0x0100" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("does NOT fire on bit 7 (Inactive) alone — backup PSU in standby is not a failure", () => {
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "0x01", unit: "discrete", status: "0x0180" },
        { name: "PSU2 Status", value: "0x80", unit: "discrete", status: "0x0180" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });

  it("predictive failure (bit 2) does not currently fire critical; tracked separately if/when added", () => {
    // Path A only fires on hard-failure states (failed/ac_lost/absent).
    // Predictive deserves a warning-tier path; not implemented in this
    // PR. This test pins the current behaviour.
    const snap = emptySnap();
    snap.dmi = { available: true, vendor: "supermicro", raw_vendor: "Supermicro", product_name: "X11", bios_version: null, bios_date: null, is_virtual: false };
    snap.ipmi = {
      available: true,
      sensors: [
        { name: "PSU1 Status", value: "0x04", unit: "discrete", status: "0x0180" },
        { name: "PSU2 Status", value: "0x01", unit: "discrete", status: "0x0180" },
      ],
      ecc_errors: { correctable: 0, uncorrectable: 0 },
      sel_entries_count: 0, sel_events_recent: [], fans: [],
    };
    expect(psuRule.evaluate(snap, baseThresholds)).toEqual([]);
  });
});
