// Chassis power provenance: `ipmitool chassis status` + `chassis restart_cause`.
//
// WHY THIS EXISTS. The reboot root-cause rollup (fit-study gap P0-1, sized at ~26
// customers and 40-60+ incidents per 12 months) needs to say WHY a server restarted.
// Commissioned research on 2026-08-01 identified these two commands as the highest
// value signals available to us, and we collected neither.
//
// THIS MODULE REPORTS FACTS AND DELIBERATELY FORMS NO VERDICT. That is not timidity,
// it is the research's central finding: attribution collapses three separate
// questions (what went wrong, what actually reset the machine, why it is on again)
// and over-claims when they are merged. Collection lands first, gets validated across
// real platforms, and only then may a dashboard rule interpret it.
//
// Two traps from that research are already visible on our own fleet, measured
// 2026-08-01 across three vendors:
//
//   1. `Last Power Event` read as a verdict. It is a FIVE-BIT FIELD; several bits can
//      be set at once. One healthy ASRock box reports `ac-failed` right now, with no
//      outage. "ac-failed therefore the data centre lost power" is the single most
//      dangerous inference in this area. We record the decoded set and nothing more.
//   2. `restart_cause` read as intent. All three sampled boxes return the same generic
//      `chassis power control command` (1h), which the spec says identifies the
//      management PATH, not the actor. That path also serves automation, PEF, fencing
//      daemons, remote APIs and stolen credentials.
//
// Neither value carries a portable retention guarantee across BMC reset, BMC firmware
// update, or loss of standby power, so both are corroboration and never a sole
// verdict until a platform has been calibrated.

import { runPrivileged } from "../lib/privileged.js";
import type { ChassisInfo, LastPowerEvent, RestartCause } from "../lib/types.js";

/** The five documented Get Chassis Status power-event bits, as ipmitool renders them. */
export const LAST_POWER_EVENT_TOKENS = ["ac-failed", "overload", "interlock", "fault", "command"] as const;

/**
 * Decode the `Last Power Event` line.
 *
 * The value is a SET, not a scalar. Real fleet output includes an empty value, a
 * single token, and tokens with trailing whitespace, so we tokenise on whitespace and
 * ignore anything we do not recognise rather than guessing at it.
 *
 * `present: false` means the BMC reported no last power event at all, which is
 * different from "no bits we understand" and different again from "we could not ask".
 */
export function parseLastPowerEvent(raw: string | null): LastPowerEvent | null {
  if (raw === null) return null;
  const value = raw.trim();
  const tokens = value.length === 0 ? [] : value.split(/\s+/);
  const known = tokens.filter((t): t is (typeof LAST_POWER_EVENT_TOKENS)[number] =>
    (LAST_POWER_EVENT_TOKENS as readonly string[]).includes(t));
  const unknown = tokens.filter((t) => !(LAST_POWER_EVENT_TOKENS as readonly string[]).includes(t));
  return {
    raw: value,
    present: tokens.length > 0,
    ac_failed: known.includes("ac-failed"),
    power_overload: known.includes("overload"),
    power_interlock: known.includes("interlock"),
    power_fault: known.includes("fault"),
    // "Last power-on was via an IPMI command." Note this is a POWER-ON bit, unlike the
    // other four which describe the last power-DOWN. Keeping the distinction visible
    // matters because they answer different causal layers.
    powered_on_by_command: known.includes("command"),
    ...(unknown.length > 0 ? { unrecognised_tokens: unknown } : {}),
  };
}

/**
 * ipmitool's `System restart cause:` strings mapped back to the IPMI numeric codes.
 *
 * We keep BOTH the raw string and the code. The code is what the spec defines; the raw
 * string is what this ipmitool build actually printed, and vendors and versions word
 * these differently. Recording the raw text is what will let us calibrate platforms
 * later without re-rolling the fleet.
 */
const RESTART_CAUSE_CODES: Array<{ code: number; label: string; match: RegExp }> = [
  { code: 0x0, label: "unknown", match: /\bunknown\b/i },
  { code: 0x1, label: "chassis_control_command", match: /chassis (power )?control command/i },
  { code: 0x2, label: "reset_via_pushbutton", match: /reset via pushbutton/i },
  { code: 0x3, label: "power_on_via_pushbutton", match: /power(-| )?up via power pushbutton|power on via power pushbutton/i },
  { code: 0x4, label: "watchdog_expiration", match: /watchdog/i },
  { code: 0x5, label: "oem", match: /\boem\b/i },
  { code: 0x6, label: "auto_power_on_always_restore", match: /always restore|always-restore/i },
  { code: 0x7, label: "auto_power_on_restore_previous", match: /restore previous|previous state/i },
  { code: 0x8, label: "reset_via_pef", match: /reset via pef/i },
  { code: 0x9, label: "power_cycle_via_pef", match: /power(-| )?cycle via pef/i },
  { code: 0xa, label: "soft_reset", match: /soft reset/i },
  { code: 0xb, label: "rtc_wakeup", match: /rtc wake/i },
];

/**
 * Parse `ipmitool chassis restart_cause`.
 *
 * Unrecognised wording yields code null with the raw string preserved, because a
 * vendor phrasing we have not seen must not be silently mapped onto a code that would
 * later be read as evidence.
 */
export function parseRestartCause(raw: string | null): RestartCause | null {
  if (raw === null) return null;
  const line = raw.split("\n").find((l) => /restart cause/i.test(l)) ?? raw;
  const value = line.replace(/^.*restart cause\s*:\s*/i, "").trim();
  if (value.length === 0) return null;
  const hit = RESTART_CAUSE_CODES.find((c) => c.match.test(value));
  return {
    raw: value,
    code: hit ? hit.code : null,
    label: hit ? hit.label : "unrecognised",
  };
}

/** Pull a `Key : value` line out of `ipmitool chassis status` output. */
function field(raw: string | null, key: string): string | null {
  if (raw === null) return null;
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === key.toLowerCase()) {
      return line.slice(idx + 1).trim();
    }
  }
  return null;
}

/**
 * Collect chassis power provenance. Returns null when the host cannot answer at all,
 * which keeps "no BMC" distinguishable from "BMC said nothing".
 */
export async function collectChassis(
  read: (action: "ipmi-chassis-status" | "ipmi-chassis-restart-cause") => Promise<string | null> =
    (a) => runPrivileged(a),
): Promise<ChassisInfo | null> {
  const statusRaw = await read("ipmi-chassis-status");
  const causeRaw = await read("ipmi-chassis-restart-cause");
  if (statusRaw === null && causeRaw === null) return null;

  // Read each field INDEPENDENTLY and let an absent one stay null.
  //
  // The previous shape keyed everything off "statusRaw is not null", which conflated
  // "the BMC answered and said no" with "the BMC did not answer this". Two ways that
  // produced an affirmative false claim from an absence: `field(...) ?? ""` turned a
  // missing Last Power Event into a decoded empty bit set, reported as present:false;
  // and `field(...) === "true"` turned every missing or unrecognised fault field into
  // a confident false. Neither is hypothetical, because run() preserves stdout on a
  // NONZERO exit, so `Get Chassis Status command failed: Invalid command` arrives as a
  // non-null statusRaw containing no fields at all, and the host then reported no
  // power event and no faults of any kind. A truncated or localised response does the
  // same. Nothing consumes these yet, which is exactly why this is the moment to fix
  // the shape. Adversarial review round 5, finding #3.
  const boolField = (name: string): boolean | null => {
    const v = field(statusRaw, name);
    if (v === null) return null;
    if (v === "true") return true;
    if (v === "false") return false;
    // Present but not a value we recognise: still not a licence to say "false".
    return null;
  };

  const lastPowerEventRaw = field(statusRaw, "Last Power Event");

  const info: ChassisInfo = {
    last_power_event: lastPowerEventRaw !== null ? parseLastPowerEvent(lastPowerEventRaw) : null,
    restart_cause: parseRestartCause(causeRaw),
    // The power-restore policy is the "why is it on again" layer, and it is what makes
    // an auto-power-on restart cause interpretable at all.
    power_restore_policy: field(statusRaw, "Power Restore Policy"),
    // Current-state faults, distinct from the last-event bits above. A live fault is a
    // present-tense fact; the event bits are historical.
    power_overload_now: boolField("Power Overload"),
    main_power_fault_now: boolField("Main Power Fault"),
    power_control_fault_now: boolField("Power Control Fault"),
  };
  return info;
}
