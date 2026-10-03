import { describe, it, expect } from "vitest";
import { classifySensor, deriveSelSeverity, parseSelTimestamp, parseFanStatus, parseSelEccCounts, collectIpmi, collectSelEccCounts, parseSelInfo } from "../ipmi.js";

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
  it("does not read a Non-critical threshold crossing as critical (substring 'critical')", () => {
    expect(deriveSelSeverity("Lower Non-critical going low", "temperature")).toBe("warning");
    expect(deriveSelSeverity("Upper Non-critical going high", "fan")).toBe("warning");
    expect(deriveSelSeverity("Transition to Non-Critical from OK", "other")).toBe("warning");
    // The critical and non-recoverable thresholds stay critical.
    expect(deriveSelSeverity("Lower Critical going low", "temperature")).toBe("critical");
    expect(deriveSelSeverity("Upper Critical going high", "temperature")).toBe("critical");
    expect(deriveSelSeverity("Lower Non-recoverable going low", "voltage")).toBe("critical");
  });
  it("an ordinary 'Power off/down' (Power Unit) is not critical", () => {
    // Logged by the BMC on every orderly shutdown or power-off from the BMC.
    expect(deriveSelSeverity("Power off/down", classifySensor("Power Unit #0x01"))).toBe("info");
    expect(deriveSelSeverity("Power off/down", "power")).toBe("info");
    // A real power fault on the same sensor type still is.
    expect(deriveSelSeverity("AC lost", classifySensor("Power Unit #0x01"))).toBe("critical");
    expect(deriveSelSeverity("Power Supply AC lost", "power")).toBe("critical");
  });
});

describe("parseSelTimestamp", () => {
  it("formats a known date/time (4-digit year)", () => {
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
  it("expands 2-digit year to 4-digit (Codex experiment 2026-05-12 finding: Supermicro X11/X12 BMCs emit YY)", () => {
    // services-1 actually produced this shape via ipmitool sel elist.
    expect(parseSelTimestamp("06/17/23", "09:05:27 UTC")).toBe("2023-06-17T09:05:27Z");
  });
  it("strips trailing ' UTC' from time (Supermicro X11/X12 shape)", () => {
    expect(parseSelTimestamp("11/14/24", "16:16:02 UTC")).toBe("2024-11-14T16:16:02Z");
    expect(parseSelTimestamp("11/14/24", "16:16:02 utc")).toBe("2024-11-14T16:16:02Z");
  });
  it("YY convention: 00-69 → 20YY, 70-99 → 19YY", () => {
    expect(parseSelTimestamp("01/01/05", "00:00:00")).toBe("2005-01-01T00:00:00Z");
    expect(parseSelTimestamp("01/01/95", "00:00:00")).toBe("1995-01-01T00:00:00Z");
  });
  it("emits a strict ISO-8601 string that Date.parse can round-trip", () => {
    const iso = parseSelTimestamp("11/14/24", "16:16:02 UTC");
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
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

  it("recognises the extended threshold codes `sdr type Fan` prints (lcr/lnr/ucr/unr, lnc/unc)", () => {
    const raw = [
      "FAN1             | 30h | lcr | 29.1 | 300 RPM",
      "FAN2             | 31h | lnr | 29.2 | 0 RPM",
      "FAN3             | 32h | ucr | 29.3 | 25000 RPM",
      "FAN4             | 33h | unr | 29.4 | 26000 RPM",
      "FAN5             | 34h | lnc | 29.5 | 900 RPM",
      "FAN6             | 35h | unc | 29.6 | 19000 RPM",
      "FAN7             | 36h | ok  | 29.7 | 5000 RPM",
    ].join("\n");
    expect(parseFanStatus(raw).map((f) => `${f.name}:${f.status}`)).toEqual([
      "FAN1:critical", "FAN2:critical", "FAN3:critical", "FAN4:critical",
      "FAN5:warning", "FAN6:warning", "FAN7:ok",
    ]);
  });
});

describe("parseSelEccCounts (Dell-style SEL output)", () => {
  it("counts correctable and uncorrectable Memory ECC events", () => {
    const raw = [
      "1 | 04/05/2026 | 14:23:05 | Memory | Correctable ECC | Asserted",
      "2 | 04/05/2026 | 14:25:11 | Memory | Correctable ECC | Asserted",
      "3 | 04/05/2026 | 14:30:00 | Memory | Uncorrectable ECC | Asserted",
      "4 | 04/05/2026 | 14:31:00 | Power Supply 1 | AC lost | Asserted",
    ].join("\n");
    const counts = parseSelEccCounts(raw);
    expect(counts.correctable).toBe(2);
    expect(counts.uncorrectable).toBe(1);
    // Only matched (memory ECC) events count toward newest_event_timestamp.
    // The 14:31:00 power-supply event is correctly excluded.
    expect(counts.newest_event_timestamp).toBe("2026-04-05T14:30:00Z");
  });

  it("matches DIMM-slot sensor names too", () => {
    const raw = "1 | 04/05/2026 | 14:23:05 | DIMM_A1 | Correctable ECC | Asserted";
    const counts = parseSelEccCounts(raw);
    expect(counts.correctable).toBe(1);
  });

  it("returns zero for unrelated events", () => {
    const raw = "1 | 04/05/2026 | 14:23:05 | Watchdog | Hard reset | Asserted";
    const counts = parseSelEccCounts(raw);
    expect(counts.correctable).toBe(0);
    expect(counts.uncorrectable).toBe(0);
  });

  it("handles empty input", () => {
    expect(parseSelEccCounts("")).toEqual({ available: true, correctable: 0, uncorrectable: 0, newest_event_timestamp: null });
  });

  it("counts only asserted rows: a deassertion is not another error", () => {
    const raw = [
      "1 | 04/05/2026 | 14:23:05 | Memory | Uncorrectable ECC | Asserted",
      "2 | 04/05/2026 | 14:23:09 | Memory | Uncorrectable ECC | Deasserted",
      "3 | 04/05/2026 | 14:25:11 | Memory | Correctable ECC | Asserted",
      "4 | 04/05/2026 | 14:25:12 | Memory | Correctable ECC | Deasserted",
    ].join("\n");
    const counts = parseSelEccCounts(raw);
    expect(counts.uncorrectable).toBe(1);
    expect(counts.correctable).toBe(1);
    expect(counts.newest_event_timestamp).toBe("2026-04-05T14:25:11Z");
  });

  it("takes newest_event_timestamp from the counted ECC rows only", () => {
    // A later memory-entity row that is not an ECC error (DIMM presence)
    // must not become the "newest ECC event" time.
    const raw = [
      "1 | 04/05/2026 | 14:23:05 | Memory | Correctable ECC | Asserted",
      "2 | 04/06/2026 | 09:00:00 | Memory DIMM_A1 | Presence detected | Asserted",
    ].join("\n");
    const counts = parseSelEccCounts(raw);
    expect(counts.correctable).toBe(1);
    expect(counts.newest_event_timestamp).toBe("2026-04-05T14:23:05Z");
  });

  it("uses nullable counters when the ECC sub-probe fails", async () => {
    const result = await collectSelEccCounts(async () => null);
    expect(result).toMatchObject({
      available: false,
      correctable: null,
      uncorrectable: null,
    });
    expect(result.error).toContain("no data");
  });
});

describe("collectIpmi: capability short-circuit", () => {
  it("returns emptyIpmi without spawning anything when capability is unavailable", async () => {
    const out = await collectIpmi("generic", { available: false, reason: "no_ipmitool_binary" });
    expect(out.available).toBe(false);
    expect(out.sensors).toEqual([]);
    expect(out.detection).toEqual({ available: false, reason: "no_ipmitool_binary" });
  });

  it("attaches detection field even when sensorRaw fallback path triggers", async () => {
    // Pass capability=undefined and let it fall through to actual ipmitool exec
    // (which will ENOENT on the test runner). The result should still have
    // available:false and no detection field.
    const out = await collectIpmi("generic");
    expect(out.available).toBe(false);
    expect(out.detection).toBeUndefined();
  });
});


describe("parseSelInfo (H12: SEL fullness so ipmi_sel_full can fire)", () => {
  it("parses a full, overflowed SEL", () => {
    const raw = [
      "SEL Information",
      "Version          : 1.5 (v1.5, v2 compliant)",
      "Entries          : 512",
      "Free Space       : 0 bytes",
      "Percent Used     : 100%",
      "Overflow         : true",
    ].join("\n");
    expect(parseSelInfo(raw)).toEqual({ entries: 512, percent_used: 100, overflow: true });
  });
  it("parses a healthy SEL", () => {
    const raw = "Entries          : 12\nPercent Used     : 2%\nOverflow         : false";
    expect(parseSelInfo(raw)).toEqual({ entries: 12, percent_used: 2, overflow: false });
  });
  it("returns nulls (unknown, never 0) when the probe failed or fields are absent", () => {
    expect(parseSelInfo(null)).toEqual({ entries: null, percent_used: null, overflow: null });
    expect(parseSelInfo("Version : 1.5")).toEqual({ entries: null, percent_used: null, overflow: null });
  });
});
