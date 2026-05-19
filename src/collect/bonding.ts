// LACP partner state from /proc/net/bonding.
//
// Per CC_SPEC_CRUCIBLE_C7_C10_NETWORK_PROCESS_COLLECTION_2026-05-19.md §2.
//
// Existing network.ts has bond-master discovery (which interface is
// slaved to which bond); this collector parses the bond protocol-level
// state that bond_slave_down's MII check doesn't surface. A bond's
// MII layer can report up while its LACP partner has timed out.
//
// LACP port state bitfield (IEEE 802.3ad clause 43.4.2.2):
//   bit 0 (0x01): LACP Activity
//   bit 1 (0x02): LACP Timeout
//   bit 2 (0x04): Aggregation
//   bit 3 (0x08): Synchronization
//   bit 4 (0x10): Collecting
//   bit 5 (0x20): Distributing
//   bit 6 (0x40): Defaulted
//   bit 7 (0x80): Expired
//
// A healthy partner reports Synchronization + Collecting + Distributing
// (bits 3,4,5 set; aggregation usually also set). Loss of synchronization
// is the signal this collector surfaces.

import { readdirSync } from "fs";

import { readProcFile } from "../lib/parse.js";

export interface BondSlave {
  name: string;
  mii_status: string;
  link_failure_count: number;
  permanent_hw_addr: string;
  aggregator_id: number | null;
  partner_churn_state: string | null;
  partner_lacp_port_state: number | null;
  partner_lacp_synchronized: boolean | null;
}

export interface BondAggregator {
  id: number;
  number_of_ports: number;
  actor_key: number | null;
  partner_key: number | null;
  partner_mac_address: string | null;
}

export interface Bond {
  name: string;
  mode: string;
  is_lacp: boolean;
  lacp_rate: string | null;
  slaves: BondSlave[];
  configured_port_count: number;
  active_aggregator: BondAggregator | null;
}

export interface BondingSnapshot {
  available: boolean;
  reason?: string;
  bonds: Bond[];
}

const LACP_SYNCHRONIZATION_BIT = 0x08;

export function collectBonding(): BondingSnapshot {
  let entries: string[];
  try {
    entries = readdirSync("/proc/net/bonding");
  } catch (err) {
    return {
      available: false,
      reason: bondReason(err),
      bonds: [],
    };
  }

  const bondNames = entries.filter((e) => /^bond/.test(e));
  if (bondNames.length === 0) {
    return { available: false, reason: "no bond interfaces", bonds: [] };
  }

  const bonds: Bond[] = [];
  for (const name of bondNames) {
    const raw = readProcFile(`/proc/net/bonding/${name}`);
    if (!raw) continue;
    const parsed = parseBondFile(name, raw);
    if (parsed) bonds.push(parsed);
  }
  return { available: true, bonds };
}

function bondReason(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code === "ENOENT") return "bonding module not loaded";
    if (typeof code === "string") {
      return `/proc/net/bonding not accessible: ${code}`;
    }
  }
  return "/proc/net/bonding not accessible";
}

export function parseBondFile(name: string, raw: string): Bond | null {
  const lines = raw.split("\n");

  // Parse the global bond-level block first (the part before any
  // "Slave Interface:" block).
  const slaveSectionStart = lines.findIndex((l) =>
    l.startsWith("Slave Interface:"),
  );
  const globalLines = slaveSectionStart === -1 ? lines : lines.slice(0, slaveSectionStart);

  let mode = "";
  let lacpRate: string | null = null;
  for (const line of globalLines) {
    if (line.startsWith("Bonding Mode:")) {
      mode = line.slice("Bonding Mode:".length).trim();
    } else if (line.startsWith("LACP rate:")) {
      lacpRate = line.slice("LACP rate:".length).trim();
    }
  }
  const isLacp = mode.includes("802.3ad");

  // Optional Active Aggregator block (LACP only).
  const activeAggregator = isLacp ? parseActiveAggregator(globalLines) : null;

  // Per-slave blocks.
  const slaves: BondSlave[] = [];
  if (slaveSectionStart !== -1) {
    let block: string[] = [];
    for (let i = slaveSectionStart; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("Slave Interface:")) {
        if (block.length > 0) {
          const slave = parseSlaveBlock(block);
          if (slave) slaves.push(slave);
        }
        block = [line];
      } else {
        block.push(line);
      }
    }
    if (block.length > 0) {
      const slave = parseSlaveBlock(block);
      if (slave) slaves.push(slave);
    }
  }

  return {
    name,
    mode,
    is_lacp: isLacp,
    lacp_rate: lacpRate,
    slaves,
    configured_port_count: slaves.length,
    active_aggregator: activeAggregator,
  };
}

function parseActiveAggregator(lines: string[]): BondAggregator | null {
  const start = lines.findIndex((l) =>
    l.trim().startsWith("Active Aggregator Info"),
  );
  if (start === -1) return null;

  // Indented key:value lines follow until a blank line or a non-indented
  // line (typically the next section header).
  let id: number | null = null;
  let numberOfPorts: number | null = null;
  let actorKey: number | null = null;
  let partnerKey: number | null = null;
  let partnerMac: string | null = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || /^\S/.test(line)) {
      // End of indented block (blank line or new top-level section).
      if (line.startsWith("Slave Interface")) break;
      if (line === "") {
        // Indented block can include blank lines in some kernel versions;
        // tolerate one blank but bail if the next line is non-indented.
        continue;
      }
      break;
    }
    const m = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === "Aggregator ID") id = parseIntSafe(val);
    else if (key === "Number of ports") numberOfPorts = parseIntSafe(val);
    else if (key === "Actor Key") actorKey = parseIntSafe(val);
    else if (key === "Partner Key") partnerKey = parseIntSafe(val);
    else if (key === "Partner Mac Address") partnerMac = val;
  }

  if (id === null || numberOfPorts === null) return null;
  return {
    id,
    number_of_ports: numberOfPorts,
    actor_key: actorKey,
    partner_key: partnerKey,
    partner_mac_address: partnerMac,
  };
}

function parseSlaveBlock(lines: string[]): BondSlave | null {
  let name = "";
  let miiStatus = "";
  let linkFailureCount = 0;
  let hwAddr = "";
  let aggregatorId: number | null = null;
  let partnerChurn: string | null = null;
  let partnerPortState: number | null = null;

  let inPartnerPdu = false;
  for (const line of lines) {
    if (line.startsWith("Slave Interface:")) {
      name = line.slice("Slave Interface:".length).trim();
      inPartnerPdu = false;
      continue;
    }
    if (line.startsWith("MII Status:")) {
      miiStatus = line.slice("MII Status:".length).trim();
      inPartnerPdu = false;
      continue;
    }
    if (line.startsWith("Link Failure Count:")) {
      linkFailureCount = parseIntSafe(line.slice("Link Failure Count:".length).trim()) ?? 0;
      inPartnerPdu = false;
      continue;
    }
    if (line.startsWith("Permanent HW addr:")) {
      hwAddr = line.slice("Permanent HW addr:".length).trim();
      inPartnerPdu = false;
      continue;
    }
    if (line.startsWith("Aggregator ID:")) {
      aggregatorId = parseIntSafe(line.slice("Aggregator ID:".length).trim());
      inPartnerPdu = false;
      continue;
    }
    if (line.startsWith("Partner Churn State:")) {
      partnerChurn = line.slice("Partner Churn State:".length).trim();
      inPartnerPdu = false;
      continue;
    }
    if (/^\s*details partner lacp pdu:/.test(line)) {
      inPartnerPdu = true;
      continue;
    }
    if (/^\s*details actor lacp pdu:/.test(line)) {
      inPartnerPdu = false;
      continue;
    }
    if (inPartnerPdu) {
      const m = line.match(/^\s*port state:\s*(\d+)/);
      if (m) {
        partnerPortState = parseIntSafe(m[1]);
      }
    }
  }

  if (!name) return null;

  const synchronized =
    partnerPortState !== null
      ? (partnerPortState & LACP_SYNCHRONIZATION_BIT) !== 0
      : null;

  return {
    name,
    mii_status: miiStatus,
    link_failure_count: linkFailureCount,
    permanent_hw_addr: hwAddr,
    aggregator_id: aggregatorId,
    partner_churn_state: partnerChurn,
    partner_lacp_port_state: partnerPortState,
    partner_lacp_synchronized: synchronized,
  };
}

function parseIntSafe(v: string): number | null {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export const __test_only = {
  parseBondFile,
  LACP_SYNCHRONIZATION_BIT,
};
