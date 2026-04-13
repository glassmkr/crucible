import { describe, it, expect } from "vitest";
import { classifySensor, deriveSelSeverity, parseSelTimestamp, parseFanStatus } from "../ipmi.js";

describe("classifySensor", () => {
  it("recognizes memory sensors", () => {
    expect(classifySensor("DIMM_A1")).toBe("memory");
    expect(classifySensor("Memory ECC")).toBe("memory");
  });
  it("recognizes power supplies", () => {
    expect(classifySensor("PSU1 Status")).toBe("power");
    expect(classifySensor("Power Supply 1")).toBe("power");
  });
  it("recognizes fans, watchdog, processors, temps, voltage, storage, chassis", () => {
    expect(classifySensor("Fan1")).toBe("fan");
    expect(classifySensor("Watchdog")).toBe("watchdog");
    expect(classifySensor("Processor 0")).toBe("processor");
    // CPU-named temperature sensors classify as processor (cpu check wins over temp).
    expect(classifySensor("CPU1 Temp")).toBe("processor");
    expect(classifySensor("Inlet Temp")).toBe("temperature");
    expect(classifySensor("VCore Voltage")).toBe("voltage");
    expect(classifySensor("Drive Slot 1")).toBe("storage");
    expect(classifySensor("Chassis Intrusion")).toBe("chassis");
  });
  it("falls back to 'other'", () => {
    expect(classifySensor("Weird Sensor")).toBe("other");
  });
});

describe("deriveSelSeverity", () => {
  it("treats uncorrectable, thermal trip, AC lost as critical", () => {
    expect(deriveSelSeverity("Uncorrectable ECC", "memory")).toBe("critical");
    expect(deriveSelSeverity("Thermal trip", "processor")).toBe("critical");
    expect(deriveSelSeverity("AC lost", "power")).toBe("critical");
    expect(deriveSelSeverity("Machine check", "processor")).toBe("critical");
  });
  it("treats correctable ECC and redundancy lost as warning", () => {
    expect(deriveSelSeverity("Correctable ECC", "memory")).toBe("warning");
    expect(deriveSelSeverity("Redundancy lost", "power")).toBe("warning");
  });
  it("treats presence detected as info", () => {
    expect(deriveSelSeverity("Presence detected", "memory")).toBe("info");
  });
  it("defaults to warning for memory/power/fan/processor sensor types", () => {
    expect(deriveSelSeverity("Some odd event", "memory")).toBe("warning");
    expect(deriveSelSeverity("Some odd event", "fan")).toBe("warning");
  });
  it("defaults to info for other sensor types", () => {
    expect(deriveSelSeverity("Some odd event", "other")).toBe("info");
  });
});

describe("parseSelTimestamp", () => {
  it("formats a known date/time", () => {
    expect(parseSelTimestamp("04/05/2026", "14:23:05")).toBe("2026-04-05T14:23:05Z");
  });
  it("pads single digit month/day", () => {
    expect(parseSelTimestamp("4/5/2026", "09:00:00")).toBe("2026-04-05T09:00:00Z");
  });
  it("returns an ISO string for bad input (does not crash)", () => {
    const out = parseSelTimestamp("", "");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(10);
  });
});

describe("parseFanStatus", () => {
  it("parses healthy fan output", () => {
    const raw = [
      "FAN1       | 30h | ok  |  7.1 | 5000 RPM",
      "FAN2       | 31h | ok  |  7.2 | 5100 RPM",
    ].join("\n");
    const fans = parseFanStatus(raw);
    expect(fans).toHaveLength(2);
    expect(fans[0]).toMatchObject({ name: "FAN1", rpm: 5000, status: "ok" });
    expect(fans[1].rpm).toBe(5100);
  });

  it("marks critical fans (cr/nr) as critical", () => {
    const raw = "FAN1 | 30h | cr  | 7.1 | 0 RPM";
    const fans = parseFanStatus(raw);
    expect(fans[0].status).toBe("critical");
  });

  it("marks absent/no-reading fans as absent", () => {
    const raw = "FAN3 | 30h | ns  | 7.1 | no reading";
    const fans = parseFanStatus(raw);
    expect(fans[0].status).toBe("absent");
    expect(fans[0].rpm).toBe(0);
  });

  it("treats 0 RPM with no explicit status as critical", () => {
    const raw = "FAN1 | 30h | 7.1 | 0 RPM";
    const fans = parseFanStatus(raw);
    expect(fans[0].status).toBe("critical");
  });
});
