// Parsers for chassis power provenance. Every fixture below is REAL output captured
// from our own fleet on 2026-08-01 across three vendors, not invented, because the
// whole point of this collector is that vendors differ and the research warned that
// assuming a shape is how this goes wrong.

import { describe, it, expect } from "vitest";
import { parseLastPowerEvent, parseRestartCause, collectChassis } from "../chassis.js";

// Captured verbatim from crucible-val-asrock-2026. Note the TRAILING SPACE after
// ac-failed, and note this host is perfectly healthy.
const ASROCK_STATUS = `System Power         : on
Power Overload       : false
Power Interlock      : inactive
Main Power Fault     : false
Power Control Fault  : false
Power Restore Policy : previous
Last Power Event     : ac-failed 
Chassis Intrusion    : inactive
Front-Panel Lockout  : inactive
Drive Fault          : false
Cooling/Fan Fault    : false`;

// crucible-val-hdd-destroy-3-2026: Last Power Event is EMPTY.
const EMPTY_EVENT_STATUS = ASROCK_STATUS.replace("Last Power Event     : ac-failed ", "Last Power Event     : ");
// crucible-val-epyc9355p-full.
const COMMAND_STATUS = ASROCK_STATUS
  .replace("Last Power Event     : ac-failed ", "Last Power Event     : command")
  .replace("Power Restore Policy : previous", "Power Restore Policy : always-on");

describe("parseLastPowerEvent: it is a BIT SET, not a verdict", () => {
  it("decodes ac-failed from a healthy host, with its real trailing space", () => {
    // The dangerous inference the research names: ac-failed therefore the DC lost
    // power. This host is fine. We record the bit and form no verdict.
    const e = parseLastPowerEvent("ac-failed ")!;
    expect(e.present).toBe(true);
    expect(e.ac_failed).toBe(true);
    expect(e.power_overload).toBe(false);
    expect(e.powered_on_by_command).toBe(false);
    expect(e.raw).toBe("ac-failed");
  });

  it("decodes MULTIPLE simultaneous bits, which a scalar reading would lose", () => {
    const e = parseLastPowerEvent("ac-failed overload fault")!;
    expect([e.ac_failed, e.power_overload, e.power_fault]).toEqual([true, true, true]);
    expect(e.power_interlock).toBe(false);
  });

  it("distinguishes EMPTY (no event reported) from no bits understood", () => {
    const e = parseLastPowerEvent("")!;
    expect(e.present).toBe(false);
    expect(e.ac_failed).toBe(false);
    expect(e.unrecognised_tokens).toBeUndefined();
  });

  it("keeps a vendor token we do not know rather than discarding it", () => {
    const e = parseLastPowerEvent("ac-failed weirdvendorthing")!;
    expect(e.ac_failed).toBe(true);
    expect(e.unrecognised_tokens).toEqual(["weirdvendorthing"]);
  });

  it("treats the power-on bit as distinct from the four power-down bits", () => {
    const e = parseLastPowerEvent("command")!;
    expect(e.powered_on_by_command).toBe(true);
    expect(e.ac_failed || e.power_overload || e.power_interlock || e.power_fault).toBe(false);
  });

  it("returns null only when we could not ask at all", () => {
    expect(parseLastPowerEvent(null)).toBeNull();
  });
});

describe("parseRestartCause", () => {
  it("maps the string all three sampled boxes actually return", () => {
    // Every host we sampled returns this same generic value, which is exactly the
    // research's warning that it identifies a management PATH, not an actor.
    const c = parseRestartCause("System restart cause: chassis power control command")!;
    expect(c.code).toBe(0x1);
    expect(c.label).toBe("chassis_control_command");
  });

  it("maps watchdog expiry, the high-value mechanism signal", () => {
    expect(parseRestartCause("System restart cause: watchdog expiration")!.code).toBe(0x4);
  });

  it("maps the two auto-power-on-after-AC codes, which explain power-on only", () => {
    expect(parseRestartCause("System restart cause: power up via always restore policy")!.code).toBe(0x6);
    expect(parseRestartCause("System restart cause: power up via restore previous state")!.code).toBe(0x7);
  });

  it("preserves unrecognised vendor wording rather than guessing a code", () => {
    const c = parseRestartCause("System restart cause: something we have never seen")!;
    expect(c.code).toBeNull();
    expect(c.label).toBe("unrecognised");
    expect(c.raw).toBe("something we have never seen");
  });

  it("returns null when we could not ask, or the value was empty", () => {
    expect(parseRestartCause(null)).toBeNull();
    expect(parseRestartCause("System restart cause: ")).toBeNull();
  });
});

describe("collectChassis", () => {
  it("parses a real ASRock host end to end", async () => {
    const c = (await collectChassis(async (a) =>
      a === "ipmi-chassis-status" ? ASROCK_STATUS : "System restart cause: chassis power control command"))!;
    expect(c.last_power_event!.ac_failed).toBe(true);
    expect(c.restart_cause!.code).toBe(0x1);
    expect(c.power_restore_policy).toBe("previous");
    expect(c.power_overload_now).toBe(false);
    expect(c.main_power_fault_now).toBe(false);
  });

  it("parses the empty-event and always-on hosts", async () => {
    const a = (await collectChassis(async (x) => x === "ipmi-chassis-status" ? EMPTY_EVENT_STATUS : null))!;
    expect(a.last_power_event!.present).toBe(false);
    expect(a.restart_cause).toBeNull();
    const b = (await collectChassis(async (x) => x === "ipmi-chassis-status" ? COMMAND_STATUS : null))!;
    expect(b.last_power_event!.powered_on_by_command).toBe(true);
    expect(b.power_restore_policy).toBe("always-on");
  });

  it("returns null when the host cannot answer either command", async () => {
    expect(await collectChassis(async () => null)).toBeNull();
  });

  it("still reports the half it CAN read when one command fails", async () => {
    const c = (await collectChassis(async (a) =>
      a === "ipmi-chassis-status" ? null : "System restart cause: watchdog expiration"))!;
    expect(c.last_power_event).toBeNull();
    expect(c.restart_cause!.code).toBe(0x4);
  });
});
