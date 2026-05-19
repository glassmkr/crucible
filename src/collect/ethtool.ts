// ethtool advertised link-mode collection.
//
// network.ts collects current speed via /sys/class/net/<iface>/speed.
// C15 (2026-05-19) adds the advertised modes from `ethtool <iface>` so
// Dashboard's link_speed_mismatch rule can compare current vs highest
// advertised. A 1 Gb/s link on a 10 Gb/s NIC isn't always wrong (the
// switch port might also be 1 Gb/s) but is worth surfacing.
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §1.3.
//
// Capability gating: `ethtool` missing (some containers lack it) ->
// available: false. Per-interface read failures are tolerated; the
// snapshot ships data for whatever interfaces returned cleanly.

import { readdirSync } from "fs";

import { run } from "../lib/exec.js";

export interface EthtoolInterface {
  iface: string;
  advertised_auto_negotiation: boolean | null;
  advertised_link_modes: string[];
}

export interface EthtoolSnapshot {
  available: boolean;
  reason?: string;
  interfaces: EthtoolInterface[];
}

const VIRTUAL_PREFIXES = ["lo", "veth", "docker", "br-", "virbr"];

function listPhysicalInterfaces(): string[] {
  try {
    const all = readdirSync("/sys/class/net");
    return all.filter(
      (iface) =>
        iface !== "lo" &&
        !VIRTUAL_PREFIXES.some((p) => iface.startsWith(p)),
    );
  } catch {
    return [];
  }
}

export async function collectEthtool(): Promise<EthtoolSnapshot> {
  const probe = await run("ethtool", ["--version"]);
  if (!probe) {
    return {
      available: false,
      reason: "ethtool not installed",
      interfaces: [],
    };
  }

  const interfaces = listPhysicalInterfaces();
  if (interfaces.length === 0) {
    return { available: true, interfaces: [] };
  }

  const results: EthtoolInterface[] = [];
  for (const iface of interfaces) {
    const out = await run("ethtool", [iface]);
    if (!out) continue; // per-interface read failure tolerated
    results.push(parseEthtoolOutput(iface, out));
  }
  return { available: true, interfaces: results };
}

/**
 * Parse the relevant subset of `ethtool <iface>` output.
 *
 * The two fields of interest:
 *
 *   Advertised auto-negotiation: Yes|No
 *   Advertised link modes:  10baseT/Half 10baseT/Full
 *                           100baseT/Half 100baseT/Full
 *                           1000baseT/Full
 *
 * Advertised link modes can span multiple lines (continuation lines
 * are indented). We collect everything from the colon to the next
 * non-continuation line.
 */
export function parseEthtoolOutput(
  iface: string,
  raw: string,
): EthtoolInterface {
  const lines = raw.split("\n");
  let auto: boolean | null = null;
  const modes: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*Advertised auto-negotiation:/i.test(line)) {
      const val = line.split(":").slice(1).join(":").trim();
      auto = val.toLowerCase() === "yes";
    } else if (/^\s*Advertised link modes:/i.test(line)) {
      // Continuation lines are indented and have no colon at the
      // expected key position. Walk forward until we hit a line that
      // looks like a new key (Word: at start).
      let buf = line.split(":").slice(1).join(":").trim();
      for (let j = i + 1; j < lines.length; j++) {
        const cont = lines[j];
        if (/^\s*[A-Za-z][^:]*:/.test(cont) && !/^\s/.test(cont)) break;
        if (!/^\s+\S/.test(cont)) break;
        buf += " " + cont.trim();
      }
      for (const token of buf.split(/\s+/)) {
        if (token.length > 0) modes.push(token);
      }
    }
  }

  return {
    iface,
    advertised_auto_negotiation: auto,
    advertised_link_modes: modes,
  };
}

export const __test_only = { parseEthtoolOutput };
