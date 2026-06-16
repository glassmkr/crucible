import { describe, it, expect } from "vitest";
import { parseSmartctlJson } from "../smart.js";

describe("parseSmartctlJson", () => {
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
    const info = parseSmartctlJson(data, "/dev/sda");
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
    const info = parseSmartctlJson(data, "/dev/sdb");
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
    const info = parseSmartctlJson(data, "/dev/nvme0n1");
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
    }, "/dev/sdb");
    expect(sata.serial).toBe("2308E6A1B2C3");
    expect(sata.firmware).toBe("M3CR046");

    const nvme = parseSmartctlJson({
      model_name: "Samsung 980 PRO",
      serial_number: "S5P2NG0R000001",
      firmware_version: "5B2QGXA7",
      smart_status: { passed: true },
      nvme_smart_health_information_log: { percentage_used: 1 },
    }, "/dev/nvme0n1");
    expect(nvme.serial).toBe("S5P2NG0R000001");
    expect(nvme.firmware).toBe("5B2QGXA7");
  });

  it("leaves serial and firmware undefined when smartctl omits them", () => {
    const info = parseSmartctlJson({ model_name: "X", smart_status: { passed: true } }, "/dev/sda");
    expect(info.serial).toBeUndefined();
    expect(info.firmware).toBeUndefined();
  });

  it("falls back to 'unknown' model when absent", () => {
    const info = parseSmartctlJson({ smart_status: { passed: true } }, "/dev/sdc");
    expect(info.model).toBe("unknown");
  });

  it("treats missing smart_status as FAILED (safer default)", () => {
    const info = parseSmartctlJson({}, "/dev/sdd");
    expect(info.health).toBe("FAILED");
  });
});
