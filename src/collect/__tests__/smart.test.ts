import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSmartctlJson, unpackSeagateCounter, parseScanOpen, mergeDriveResults, collectSmart } from "../smart.js";
import type { SmartInfo } from "../../lib/types.js";
import { isAllowedSmartType, isAllowedSmartDevice } from "../../lib/privileged.js";

describe("parseSmartctlJson", () => {
  it("returns null when smartctl could not interrogate the device (no smart_status)", () => {
    // Real case (agentic-17): /dev/sda is the BMC's virtual-media USB device
    // (AMI Virtual HDisk0, idVendor 0x046b). smartctl exits with "Unknown
    // USB bridge ... Please specify device type" and its JSON carries only
    // the smartctl/device envelope, no smart_status. That must be "no SMART
    // data", never a FAILED health verdict.
    const data = {
      smartctl: { exit_status: 1, messages: [{ string: "Unknown USB bridge [0x046b:0xff31 (0x504)]", severity: "error" }] },
      device: { name: "/dev/sda", type: "scsi", protocol: "SCSI" },
    } as Record<string, unknown>;
    expect(parseSmartctlJson(data, "/dev/sda")).toBeNull();
  });

  it("parses a healthy SATA SSD", () => {
    const data = {
      model_name: "Samsung SSD 970 EVO 1TB",
      smart_status: { passed: true },
      temperature: { current: 38 },
      power_on_time: { hours: 9000 },
      ata_smart_attributes: {
        table: [
          { id: 5, name: "Reallocated_Sector_Ct", raw: { value: 0 } },
          { id: 197, name: "Current_Pending_Sector", raw: { value: 0 } },
        ],
      },
    };
    const info = parseSmartctlJson(data, "/dev/sda")!;
    expect(info).toMatchObject({
      device: "/dev/sda",
      model: "Samsung SSD 970 EVO 1TB",
      health: "PASSED",
      temperature_c: 38,
      power_on_hours: 9000,
      reallocated_sectors: 0,
      pending_sectors: 0,
    });
  });

  it("parses a failing SATA drive with reallocated sectors", () => {
    const data = {
      model_name: "WD Red 4TB",
      smart_status: { passed: false },
      ata_smart_attributes: {
        table: [
          { id: 5, raw: { value: 12 } },
          { id: 197, raw: { value: 3 } },
        ],
      },
    };
    const info = parseSmartctlJson(data, "/dev/sdb")!;
    expect(info.health).toBe("FAILED");
    expect(info.reallocated_sectors).toBe(12);
    expect(info.pending_sectors).toBe(3);
  });

  it("parses an NVMe drive with percentage_used", () => {
    const data = {
      model_name: "Samsung 980 PRO",
      smart_status: { passed: true },
      nvme_smart_health_information_log: { percentage_used: 22, temperature: 41 },
    };
    const info = parseSmartctlJson(data, "/dev/nvme0n1")!;
    expect(info.percentage_used).toBe(22);
    expect(info.temperature_c).toBe(41);
    expect(info.health).toBe("PASSED");
  });

  it("captures serial_number and firmware_version (SATA + NVMe)", () => {
    const sata = parseSmartctlJson({
      model_name: "CT500MX500SSD1",
      serial_number: "2308E6A1B2C3",
      firmware_version: "M3CR046",
      smart_status: { passed: true },
    }, "/dev/sdb")!;
    expect(sata.serial).toBe("2308E6A1B2C3");
    expect(sata.firmware).toBe("M3CR046");

    const nvme = parseSmartctlJson({
      model_name: "Samsung 980 PRO",
      serial_number: "S5P2NG0R000001",
      firmware_version: "5B2QGXA7",
      smart_status: { passed: true },
      nvme_smart_health_information_log: { percentage_used: 1 },
    }, "/dev/nvme0n1")!;
    expect(nvme.serial).toBe("S5P2NG0R000001");
    expect(nvme.firmware).toBe("5B2QGXA7");
  });

  it("leaves serial and firmware undefined when smartctl omits them", () => {
    const info = parseSmartctlJson({ model_name: "X", smart_status: { passed: true } }, "/dev/sda")!;
    expect(info.serial).toBeUndefined();
    expect(info.firmware).toBeUndefined();
  });

  it("falls back to 'unknown' model when absent", () => {
    const info = parseSmartctlJson({ smart_status: { passed: true } }, "/dev/sdc")!;
    expect(info.model).toBe("unknown");
  });

  it("treats missing smart_status as no-SMART-data, not FAILED", () => {
    // This test previously asserted the opposite ("FAILED as the safer
    // default"). agentic-17 disproved that: a device smartctl cannot read
    // (BMC virtual media, unknown USB bridge) produced a phantom critical
    // smart_failing on a 0-byte virtual disk. Unreadable is unreadable.
    expect(parseSmartctlJson({}, "/dev/sdd")).toBeNull();
  });

  it("derives percentage_used from a SATA SSD wear attribute (Crucial MX500 ID 202)", () => {
    // Percent_Lifetime_Remain normalized value 25 = 25% life left = 75% used.
    const info = parseSmartctlJson({
      model_name: "CT500MX500SSD1",
      smart_status: { passed: true },
      ata_smart_attributes: {
        table: [
          { id: 5, name: "Reallocated_Sector_Ct", value: 100, raw: { value: 0 } },
          { id: 202, name: "Percent_Lifetime_Remain", value: 25, raw: { value: 75 } },
        ],
      },
    }, "/dev/sdb")!;
    expect(info.percentage_used).toBe(75);
    expect(info.reallocated_sectors).toBe(0);
  });

  it("reads a fresh SATA SSD wear attribute as 0% used", () => {
    const info = parseSmartctlJson({
      model_name: "Samsung SSD 870 EVO",
      smart_status: { passed: true },
      ata_smart_attributes: { table: [{ id: 177, name: "Wear_Leveling_Count", value: 100, raw: { value: 0 } }] },
    }, "/dev/sda")!;
    expect(info.percentage_used).toBe(0);
  });

  it("does not treat ID 231 Temperature as a wear attribute", () => {
    const info = parseSmartctlJson({
      model_name: "Some SSD",
      smart_status: { passed: true },
      ata_smart_attributes: { table: [{ id: 231, name: "Temperature_Celsius", value: 65, raw: { value: 35 } }] },
    }, "/dev/sda")!;
    expect(info.percentage_used).toBeUndefined();
  });

  it("takes the most-worn wear attribute when several are present", () => {
    const info = parseSmartctlJson({
      model_name: "Intel SSD",
      smart_status: { passed: true },
      ata_smart_attributes: {
        table: [
          { id: 233, name: "Media_Wearout_Indicator", value: 60, raw: { value: 40 } },
          { id: 173, name: "Ave_Block-Erase_Count", value: 30, raw: { value: 70 } },
        ],
      },
    }, "/dev/sda")!;
    expect(info.percentage_used).toBe(70);
  });

  it("parses the expanded early-warning attribute set on an HDD", () => {
    const info = parseSmartctlJson({
      model_name: "WDC WD40EFRX",
      smart_status: { passed: true },
      ata_smart_attributes: {
        table: [
          { id: 5, name: "Reallocated_Sector_Ct", raw: { value: 2 } },
          { id: 10, name: "Spin_Retry_Count", raw: { value: 1 } },
          { id: 187, name: "Reported_Uncorrect", raw: { value: 4 } },
          { id: 188, name: "Command_Timeout", raw: { value: 7 } },
          { id: 189, name: "High_Fly_Writes", raw: { value: 3 } },
          { id: 196, name: "Reallocated_Event_Count", raw: { value: 2 } },
          { id: 197, name: "Current_Pending_Sector", raw: { value: 8 } },
          { id: 198, name: "Offline_Uncorrectable", raw: { value: 5 } },
          { id: 199, name: "UDMA_CRC_Error_Count", raw: { value: 11 } },
        ],
      },
    }, "/dev/sdb")!;
    expect(info).toMatchObject({
      reallocated_sectors: 2,
      spin_retries: 1,
      reported_uncorrectable: 4,
      command_timeout: 7,
      high_fly_writes: 3,
      reallocation_events: 2,
      pending_sectors: 8,
      offline_uncorrectable: 5,
      udma_crc_errors: 11,
    });
  });

  it("unpacks the packed 188 raw ONLY on Seagate; 187/189 stay verbatim", () => {
    // Seagate packs 188 as 16-bit sub-counters; the low 16 bits are the count.
    expect(unpackSeagateCounter(0)).toBe(0);
    expect(unpackSeagateCounter(7)).toBe(7);
    expect(unpackSeagateCounter(0x000100000002)).toBe(2);

    const seagate = parseSmartctlJson({
      model_name: "ST12000NM0007",
      smart_status: { passed: true },
      ata_smart_attributes: {
        table: [
          { id: 188, name: "Command_Timeout", raw: { value: 0x000100000002 } },
          // 187/189 are NOT packed even on Seagate: must pass through verbatim,
          // never truncated by a magnitude heuristic.
          { id: 187, name: "Reported_Uncorrect", raw: { value: 0x000100000002 } },
          { id: 189, name: "High_Fly_Writes", raw: { value: 70000 } },
        ],
      },
    }, "/dev/sdc")!;
    expect(seagate.command_timeout).toBe(2);
    expect(seagate.reported_uncorrectable).toBe(0x000100000002);
    expect(seagate.high_fly_writes).toBe(70000);
  });

  it("leaves a non-Seagate 188 verbatim even above 65535 (no false truncation)", () => {
    // A WD drive reporting a genuine large 188 must not be truncated: the
    // >0xffff heuristic is Seagate-only, or a real count corrupts.
    const wd = parseSmartctlJson({
      model_name: "WDC WD40EFRX",
      smart_status: { passed: true },
      ata_smart_attributes: {
        table: [{ id: 188, name: "Command_Timeout", raw: { value: 70000 } }],
      },
    }, "/dev/sdb")!;
    expect(wd.command_timeout).toBe(70000);
  });

  it("does not read a SATA-SSD id-189 (SSD Health Flags) as high fly writes", () => {
    // Seagate Nytro XF1230 SATA SSD reports id 189 as "SSD_Health_Flags", not
    // head-flying. 189 is name-gated so a flags bitfield never feeds the
    // high-fly-writes burst detector.
    const ssd = parseSmartctlJson({
      model_name: "XF1230-1A0480",
      smart_status: { passed: true },
      ata_smart_attributes: {
        table: [{ id: 189, name: "SSD_Health_Flags", raw: { value: 8 } }],
      },
    }, "/dev/sdb")!;
    expect(ssd.high_fly_writes).toBeUndefined();
  });

  it("summarizes the self-test log, keeping the newest failure separate", () => {
    // Newest entry is a later PASSING short test; the read failure two slots
    // back must still surface via last_failed_* (with its LBA), or a routine
    // short test would mask a genuine surface defect.
    const info = parseSmartctlJson({
      model_name: "TOSHIBA MG07ACA14TE",
      smart_status: { passed: true },
      power_on_time: { hours: 30200 },
      ata_smart_self_test_log: {
        standard: {
          table: [
            { type: { string: "Short offline" }, status: { value: 0, string: "Completed without error", passed: true }, lifetime_hours: 30190 },
            { type: { string: "Extended offline" }, status: { value: 121, string: "Completed: read failure", passed: false }, lifetime_hours: 30157, lba: 234593524 },
            { type: { string: "Short offline" }, status: { value: 0, string: "Completed without error", passed: true }, lifetime_hours: 29000 },
          ],
          error_count_total: 1,
        },
      },
    }, "/dev/sdd")!;
    expect(info.self_test).toEqual({
      last_type: "Short offline",
      last_status: "Completed without error",
      last_passed: true,
      last_lifetime_hours: 30190,
      last_failed_lba: 234593524,
      last_failed_lifetime_hours: 30157,
      error_count_total: 1,
    });
  });

  it("classifies a fatal self-test (nibble 3) as a failure even when smartctl omits `passed`", () => {
    // smartmontools deliberately omits status.passed for nibble 3
    // (fatal/unknown error). Failure detection must rely on the high nibble
    // alone, or a fatal self-test failure is silently dropped.
    const info = parseSmartctlJson({
      model_name: "WDC WD100EFAX",
      smart_status: { passed: true },
      power_on_time: { hours: 500 },
      ata_smart_self_test_log: {
        standard: {
          table: [
            { type: { string: "Extended offline" }, status: { value: 0x30, string: "Completed: unknown failure or in progress" }, lifetime_hours: 480 },
          ],
        },
      },
    }, "/dev/sdf")!;
    expect(info.self_test?.last_failed_lifetime_hours).toBe(480);
  });

  it("does not treat an aborted self-test as a failure", () => {
    // Status nibble 1 = aborted by host. Some smartctl versions mark it
    // passed=false; an abort is an interruption, not a drive failure.
    const info = parseSmartctlJson({
      model_name: "ST4000DM004",
      smart_status: { passed: true },
      ata_smart_self_test_log: {
        standard: {
          table: [
            { type: { string: "Extended offline" }, status: { value: 25, string: "Aborted by host", passed: false }, lifetime_hours: 100 },
          ],
        },
      },
    }, "/dev/sde")!;
    expect(info.self_test?.last_status).toBe("Aborted by host");
    expect(info.self_test?.last_failed_lifetime_hours).toBeUndefined();
    expect(info.self_test?.last_failed_lba).toBeUndefined();
  });

  it("omits self_test when the drive has no self-test log", () => {
    const info = parseSmartctlJson({
      model_name: "X",
      smart_status: { passed: true },
    }, "/dev/sda")!;
    expect(info.self_test).toBeUndefined();
  });

  it("parses NVMe media_errors and num_err_log_entries", () => {
    const info = parseSmartctlJson({
      model_name: "Samsung PM9A3",
      smart_status: { passed: true },
      nvme_smart_health_information_log: {
        percentage_used: 3,
        media_errors: 2,
        num_err_log_entries: 14,
      },
    }, "/dev/nvme0n1")!;
    expect(info.media_errors).toBe(2);
    expect(info.num_err_log_entries).toBe(14);
  });

  it("parses a SATA drive read through a MegaRAID controller (sat+megaraid) unchanged", () => {
    // Captured from val-hdd-destroy-2: HGST 4TB behind an LSI MegaRAID SAS-3
    // 3108, read via `smartctl --json --all -d sat+megaraid,8 /dev/bus/0`. The
    // JSON shape is identical to a direct SATA drive, so parseSmartctlJson must
    // accept it with no special-casing.
    const info = parseSmartctlJson({
      model_name: "HGST HUS726T4TALE6L4",
      serial_number: "V6G84TMR",
      smart_status: { passed: true },
      temperature: { current: 29 },
      power_on_time: { hours: 53940 },
      ata_smart_attributes: {
        table: [
          { id: 5, name: "Reallocated_Sector_Ct", raw: { value: 0 } },
          { id: 197, name: "Current_Pending_Sector", raw: { value: 0 } },
          { id: 199, name: "UDMA_CRC_Error_Count", raw: { value: 0 } },
        ],
      },
    }, "/dev/bus/0[sat+megaraid,8]")!;
    expect(info.device).toBe("/dev/bus/0[sat+megaraid,8]");
    expect(info.serial).toBe("V6G84TMR");
    expect(info.health).toBe("PASSED");
    expect(info.power_on_hours).toBe(53940);
  });
});

describe("parseScanOpen", () => {
  const SCAN = [
    "/dev/sda -d scsi # /dev/sda, SCSI device",
    "/dev/bus/0 -d sat+megaraid,8 # /dev/bus/0 [megaraid_disk_08] [SAT], ATA device",
    "/dev/bus/0 -d sat+megaraid,9 # /dev/bus/0 [megaraid_disk_09] [SAT], ATA device",
    "/dev/bus/0 -d sat+megaraid,10 # /dev/bus/0 [megaraid_disk_10] [SAT], ATA device",
    "/dev/bus/0 -d sat+megaraid,11 # /dev/bus/0 [megaraid_disk_11] [SAT], ATA device",
  ].join("\n");

  it("keeps only controller-passthrough devices, in order", () => {
    expect(parseScanOpen(SCAN)).toEqual([
      { path: "/dev/bus/0", type: "sat+megaraid,8" },
      { path: "/dev/bus/0", type: "sat+megaraid,9" },
      { path: "/dev/bus/0", type: "sat+megaraid,10" },
      { path: "/dev/bus/0", type: "sat+megaraid,11" },
    ]);
  });

  it("skips direct disks (-d scsi/sat/nvme) that /sys/block already covers", () => {
    const direct = [
      "/dev/sda -d scsi # /dev/sda, SCSI device",
      "/dev/sdb -d sat # /dev/sdb [SAT], ATA device",
      "/dev/nvme0 -d nvme # /dev/nvme0, NVMe device",
    ].join("\n");
    expect(parseScanOpen(direct)).toEqual([]);
  });

  it("handles other controller families and empty/garbage input", () => {
    expect(parseScanOpen("/dev/bus/2 -d cciss,3 # x")).toEqual([{ path: "/dev/bus/2", type: "cciss,3" }]);
    expect(parseScanOpen("")).toEqual([]);
    expect(parseScanOpen("not a scan line\n\n")).toEqual([]);
  });
});

describe("isAllowedSmartType (wrapper -d passthrough validation)", () => {
  // Canonical grammar: [sat+]<family>,<single numeric id>. The TS regex and the
  // sh valid_smart_type MUST admit exactly this set (a divergence is a security
  // finding: Codex 2026-07-17). sat+ composes with ANY family.
  it("accepts [sat+]<family>,<numeric-id> for every known family", () => {
    for (const t of [
      "sat+megaraid,8", "megaraid,11", "sat+cciss,0", "cciss,0",
      "3ware,1", "aacraid,0", "areca,1", "marvell,2", "megaraid,255",
    ]) {
      expect(isAllowedSmartType(t)).toBe(true);
    }
  });

  it("rejects injection / unknown / malformed / multi-field selectors", () => {
    for (const t of [
      "megaraid,8;reboot",      // command chars
      "megaraid,8 /dev/sda",    // extra arg / space
      "marvell,1/../../x",      // traversal
      "cciss,/etc/passwd",      // slash / path (sh charset used to admit this)
      "megaraid,abc",           // non-numeric id (sh prefix-glob used to admit)
      "megaraid,8garbage",      // trailing garbage (sh used to admit)
      "aacraid,0,0,0",          // multi-field tuple: intentionally unsupported now
      "areca,1/1",              // enclosure form: intentionally unsupported now
      "megaraid,0,0,0,0",       // long tuple (sh used to admit)
      "scsi", "sat",            // not a passthrough family / bare
      "megaraid,",              // trailing comma / no id
      "-d megaraid,8",          // embedded flag
      "",
    ]) {
      expect(isAllowedSmartType(t)).toBe(false);
    }
  });

  it("still accepts /dev/bus/N as a smart device path (passthrough backing)", () => {
    expect(isAllowedSmartDevice("/dev/bus/0")).toBe(true);
    expect(isAllowedSmartDevice("/dev/bus/0/../../etc/passwd")).toBe(false);
  });
});

describe("mergeDriveResults (direct vs passthrough dedup)", () => {
  const d = (device: string, serial?: string): SmartInfo =>
    ({ device, model: "m", health: "PASSED", ...(serial ? { serial } : {}) }) as SmartInfo;

  it("keeps two direct disks sharing a placeholder serial (never direct-vs-direct dedup)", () => {
    // The Codex 2026-07-17 medium: /dev/sda and /dev/sdb both report
    // "000000000000"; both must survive or a failing one vanishes silently.
    const out = mergeDriveResults([d("/dev/sda", "000000000000"), d("/dev/sdb", "000000000000")], []);
    expect(out.map((r) => r.device)).toEqual(["/dev/sda", "/dev/sdb"]);
  });

  it("drops a passthrough drive that duplicates a direct disk by serial (IT-mode HBA)", () => {
    const out = mergeDriveResults(
      [d("/dev/sda", "SN1")],
      [d("/dev/bus/0[sat+megaraid,8]", "SN1")],
    );
    expect(out.map((r) => r.device)).toEqual(["/dev/sda"]);
  });

  it("keeps a passthrough drive whose serial is not among the direct disks", () => {
    const out = mergeDriveResults([d("/dev/sda", "SN1")], [d("/dev/bus/0[sat+megaraid,8]", "SN2")]);
    expect(out.map((r) => r.serial)).toEqual(["SN1", "SN2"]);
  });

  it("keeps serial-less entries on both sides", () => {
    const out = mergeDriveResults([d("/dev/sda")], [d("/dev/bus/0[sat+megaraid,8]")]);
    expect(out).toHaveLength(2);
  });
});

describe("collectSmart: smart_unreadable blind spot", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "smart-block-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // Create a fake /sys/block/<name> with size (512-byte sectors) + removable.
  async function makeDisk(name: string, size: string, removable: string) {
    const dir = join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "size"), size);
    await fs.writeFile(join(dir, "removable"), removable);
  }

  const SATA_1TB = "1953525168"; // realistic sector count
  const HEALTHY = JSON.stringify({ model_name: "WD Red", smart_status: { passed: true } });
  // smartctl ran but there is no SMART surface (unknown USB bridge / unsupported
  // controller / the controller's own virtual disk): parseSmartctlJson -> null.
  const NO_SURFACE = JSON.stringify({ smartctl: { exit_status: 1 }, device: { name: "x", type: "scsi" } });
  const noScan = async () => null;

  it("flags fixed disks as no_smartctl_output when smartctl produces nothing (destroy-1: smartmontools missing)", async () => {
    await makeDisk("sda", SATA_1TB, "0");
    await makeDisk("sdb", SATA_1TB, "0");
    const res = await collectSmart({ sysBlock: root, probe: async () => null, scan: noScan });
    expect(res.smart).toEqual([]);
    expect(res.unreadable).toEqual([
      { device: "/dev/sda", reason: "no_smartctl_output" },
      { device: "/dev/sdb", reason: "no_smartctl_output" },
    ]);
  });

  it("flags no_smart_data when smartctl runs but exposes no SMART surface (unsupported controller)", async () => {
    await makeDisk("sda", SATA_1TB, "0");
    const res = await collectSmart({ sysBlock: root, probe: async () => NO_SURFACE, scan: noScan });
    expect(res.smart).toEqual([]);
    expect(res.unreadable).toEqual([{ device: "/dev/sda", reason: "no_smart_data" }]);
  });

  it("does NOT flag a readable drive", async () => {
    await makeDisk("sda", SATA_1TB, "0");
    const res = await collectSmart({ sysBlock: root, probe: async () => HEALTHY, scan: noScan });
    expect(res.unreadable).toEqual([]);
    expect(res.smart).toHaveLength(1);
    expect(res.smart[0]!.health).toBe("PASSED");
  });

  it("never flags 0-byte BMC virtual media (not probed, not a blind spot)", async () => {
    await makeDisk("sda", "0", "0");        // AMI Virtual HDisk0
    await makeDisk("sdb", SATA_1TB, "0");   // a real disk, smartctl missing
    const probed: string[] = [];
    const res = await collectSmart({
      sysBlock: root,
      probe: async (dev) => { probed.push(dev); return null; },
      scan: noScan,
    });
    expect(probed).toEqual(["/dev/sdb"]);   // the 0-byte device is never probed
    expect(res.unreadable).toEqual([{ device: "/dev/sdb", reason: "no_smartctl_output" }]);
  });

  it("never flags removable media (USB stick / SD card, removable=1)", async () => {
    await makeDisk("sda", SATA_1TB, "0");   // fixed disk, readable
    await makeDisk("sdc", "30273536", "1"); // USB stick: no SMART surface, but removable
    const res = await collectSmart({
      sysBlock: root,
      probe: async (dev) => (dev === "/dev/sdc" ? NO_SURFACE : HEALTHY),
      scan: noScan,
    });
    expect(res.unreadable).toEqual([]);
    expect(res.smart.map((s) => s.device)).toContain("/dev/sda");
  });

  it("does not flag a size-unreadable device (conservative: may not be a real disk)", async () => {
    // No size/removable files -> reads throw -> device is probed but not eligible.
    await fs.mkdir(join(root, "sda"), { recursive: true });
    const res = await collectSmart({ sysBlock: root, probe: async () => null, scan: noScan });
    expect(res.unreadable).toEqual([]);
  });

  it("suppresses the marker on a healthy HW-RAID box (passthrough drives present => the unreadable /sys/block VD is not a blind spot)", async () => {
    await makeDisk("sda", SATA_1TB, "0"); // the controller's virtual disk: unreadable directly
    const scan = async () =>
      "/dev/bus/0 -d sat+megaraid,8 # /dev/bus/0 [megaraid_disk_08] [SAT], ATA device\n";
    const res = await collectSmart({
      sysBlock: root,
      probe: async (dev, type) => {
        if (dev === "/dev/sda" && !type) return NO_SURFACE;                 // VD: no SMART
        if (dev === "/dev/bus/0" && type === "sat+megaraid,8") return HEALTHY; // physical drive
        return null;
      },
      scan,
    });
    expect(res.smart).toHaveLength(1);   // the passthrough physical drive
    expect(res.unreadable).toEqual([]);  // suppressed
  });
});
