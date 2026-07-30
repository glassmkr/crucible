import { describe, it, expect } from "vitest";
import { isPsuSensor, isPsuRedundancySensor, classifyPsuRedundancyState, classifyPsuSensorBitmask } from "../vendor-sensors.js";

describe("isPsuSensor", () => {
  it("matches generic PSU / Power Supply patterns across vendors", () => {
    expect(isPsuSensor("PSU1 Status", "supermicro")).toBe(true);
    expect(isPsuSensor("PSU1 Status", "dell")).toBe(true);
    expect(isPsuSensor("Power Supply 1", "hpe")).toBe(true);
    expect(isPsuSensor("Power Supply 1", "generic")).toBe(true);
  });
  it("matches PS<N> with space or underscore separator across vendors (glassmkr#29)", () => {
    // Fleet data: Supermicro H12SST uses "PS1 Status", Dell iDRAC uses
    // "PS1 Status", Gigabyte MC12-LE0/MZ62-HD0/R292-4S1 use "PS1_Status".
    // The pre-fix regex was Dell-gated which was wrong; all three
    // vendor families use this shape on real BMCs.
    expect(isPsuSensor("PS1 Status", "dell")).toBe(true);
    expect(isPsuSensor("PS1 Status", "supermicro")).toBe(true);
    expect(isPsuSensor("PS1_Status", "supermicro")).toBe(true); // Gigabyte BMC on Supermicro-DMI box (x12qch)
    expect(isPsuSensor("PS2_Status", "generic")).toBe(true);
    expect(isPsuSensor("PS3 Status", "dell")).toBe(true);
  });
  it("does not match PS Redundancy as an individual PSU sensor", () => {
    expect(isPsuSensor("PS Redundancy", "dell")).toBe(false);
  });
  it("rejects unrelated sensors", () => {
    expect(isPsuSensor("CPU1 Temp", "dell")).toBe(false);
    expect(isPsuSensor("Some Random Sensor", "supermicro")).toBe(false);
    // PS without digit
    expect(isPsuSensor("PS", "supermicro")).toBe(false);
  });
});

describe("isPsuRedundancySensor", () => {
  it("matches Dell PS Redundancy", () => {
    expect(isPsuRedundancySensor("PS Redundancy", "dell")).toBe(true);
  });
  it("does not match on other vendors", () => {
    expect(isPsuRedundancySensor("PS Redundancy", "supermicro")).toBe(false);
    expect(isPsuRedundancySensor("PS Redundancy", "generic")).toBe(false);
  });
  it("does not match individual PSU sensors", () => {
    expect(isPsuRedundancySensor("PS1 Status", "dell")).toBe(false);
  });
});

describe("classifyPsuRedundancyState", () => {
  it("recognises fully redundant", () => {
    expect(classifyPsuRedundancyState("Fully Redundant")).toBe("fully_redundant");
    expect(classifyPsuRedundancyState("ok")).toBe("fully_redundant");
  });
  it("recognises lost / degraded", () => {
    expect(classifyPsuRedundancyState("Redundancy Lost")).toBe("redundancy_lost");
    expect(classifyPsuRedundancyState("Redundancy Degraded")).toBe("redundancy_degraded");
  });
  it("returns unknown for unrecognised text", () => {
    expect(classifyPsuRedundancyState("0x42")).toBe("unknown");
  });
});

describe("classifyPsuSensorBitmask (glassmkr#29)", () => {
  // IPMI 2.0 sensor type 0x08 discrete-state bit semantics.
  it("returns 'failed' for bit 1 (Power Supply Failure detected)", () => {
    expect(classifyPsuSensorBitmask("0x02", "0x0180", "supermicro")).toBe("failed");
    expect(classifyPsuSensorBitmask("0x03", "0x0180", "supermicro")).toBe("failed"); // bit 0 + bit 1
  });
  it("returns 'ac_lost' for bit 3/4/5 (input lost / out-of-range)", () => {
    expect(classifyPsuSensorBitmask("0x08", "0x0180", "supermicro")).toBe("ac_lost");
    expect(classifyPsuSensorBitmask("0x10", "0x0180", "supermicro")).toBe("ac_lost");
    expect(classifyPsuSensorBitmask("0x20", "0x0180", "supermicro")).toBe("ac_lost");
  });
  it("returns 'predictive' for bit 2", () => {
    expect(classifyPsuSensorBitmask("0x04", "0x0180", "supermicro")).toBe("predictive");
  });
  it("returns 'ok' for 0x01 (Presence detected, no failure bits)", () => {
    expect(classifyPsuSensorBitmask("0x01", "0x0100", "supermicro")).toBe("ok");
    expect(classifyPsuSensorBitmask("0x01", "0x0181", "supermicro")).toBe("ok");
  });
  it("returns 'ok' on ambiguous 0x0 + mask lacking presence bit (under-report safe default)", () => {
    // mz62hd / x570d4u / x12qch shape: BMC doesn't claim it can report
    // bit 0, so a Reading of 0x0 isn't enough to call PSU absent.
    expect(classifyPsuSensorBitmask("0x00", "0x0180", "generic")).toBe("ok");
    expect(classifyPsuSensorBitmask("0x00", "0x0080", "asrockrack")).toBe("ok");
    expect(classifyPsuSensorBitmask("0x00", "0x0100", "supermicro")).toBe("ok");
  });
  it("returns 'absent' when mask supports bit 0 but Reading lacks it", () => {
    // BMC says "I can report presence" (mask & 0x01 = 1) and Reading is
    // 0x0: PSU is genuinely absent.
    expect(classifyPsuSensorBitmask("0x00", "0x0181", "supermicro")).toBe("absent");
  });
  it("returns 'inactive' for bit 7 alone when mask supports it (backup PSU in standby)", () => {
    expect(classifyPsuSensorBitmask("0x80", "0x0180", "supermicro")).toBe("inactive");
  });
  it("does not return 'inactive' when bit 7 set but mask doesn't include it (and mask doesn't include bit 0 either)", () => {
    // Mask 0x40 has neither presence (bit 0) nor inactive (bit 7), so
    // bit 7 in Reading is not reportable and shouldn't be flagged.
    expect(classifyPsuSensorBitmask("0x80", "0x0040", "supermicro")).toBe("ok");
  });
  it("returns 'unknown' for unparseable Reading", () => {
    expect(classifyPsuSensorBitmask("na", "0x0180", "supermicro")).toBe("unknown");
    expect(classifyPsuSensorBitmask("", "0x0180", "supermicro")).toBe("unknown");
    expect(classifyPsuSensorBitmask("not a hex", "0x0180", "supermicro")).toBe("unknown");
  });
  it("handles missing/'na' mask gracefully", () => {
    // Some sensor outputs omit the mask column entirely; fall through to
    // failure-bit detection without crashing on parseInt(NaN).
    expect(classifyPsuSensorBitmask("0x02", undefined, "supermicro")).toBe("failed");
    expect(classifyPsuSensorBitmask("0x02", "na", "supermicro")).toBe("failed");
    expect(classifyPsuSensorBitmask("0x00", "na", "supermicro")).toBe("ok"); // mask unknown → under-report
  });
});
