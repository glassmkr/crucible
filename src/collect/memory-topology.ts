// Memory population topology from SMBIOS Type 17 (dmidecode -t 17).
//
// Reports the physical DIMM layout: which slots/channels exist, which are
// populated, and whether populated DIMMs run below their rated speed. The
// dashboard uses this to flag under-populated memory channels (a silent
// bandwidth killer on multi-channel CPUs) and, via a CPU-family map it holds
// server-side, controller/quadrant imbalance.
//
// This collector emits COLLECTED FACTS ONLY. It does not judge "optimal" - the
// channel-count-vs-populated comparison and the controller-balance heuristic
// live in the dashboard so the CPU-family maps can change without an agent
// re-release. Returns null when dmidecode is unavailable or reports no Type 17
// records (VMs, missing perms, stale sudo wrapper) so the rule simply never
// fires rather than acting on garbage.

import { runPrivileged } from "../lib/privileged.js";
import type { MemoryTopology, MemoryDimm } from "../lib/types.js";

/** "32 GiB" / "32 GB" / "16384 MB" -> MB. dmidecode uses 1024-based units
 *  (older builds print "GB" but mean GiB). "No Module Installed" -> null. */
function parseSizeMb(raw: string | undefined): number | null {
  if (!raw || /no module/i.test(raw)) return null;
  const m = raw.match(/([\d.]+)\s*(Ti?B|Gi?B|Mi?B)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("t")) return Math.round(n * 1024 * 1024);
  if (unit.startsWith("g")) return Math.round(n * 1024);
  if (unit.startsWith("m")) return Math.round(n);
  return null;
}

/** "3200 MT/s" -> 3200. "Unknown" / "" -> null. */
function parseMts(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\s*MT\/s/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Channel identity, normalized. Prefer the explicit "Channel<N>" in the bank
 *  locator (unambiguous); fall back to the letter in the locator (DIMM<A-H>).
 *  Returns uppercase so "a" and "A" collapse. */
function parseChannel(locator: string, bank: string | null): string | null {
  if (bank) {
    const m = bank.match(/Channel\s*([0-9A-Za-z]+)/i);
    if (m) return m[1].toUpperCase();
  }
  const m = locator.match(/DIMM[_ ]?([A-H])(?:\d|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function parseSocket(locator: string, bank: string | null): number | null {
  const src = `${bank ?? ""} ${locator}`;
  const m = src.match(/(?:^|[^A-Za-z])(?:P|CPU|Proc(?:essor)?)\s*_?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** DPC index within the channel (0/1), from "Dimm<N>" in the bank locator or
 *  the trailing digit of the locator. Advisory only. */
function parseSlotIndex(locator: string, bank: string | null): number | null {
  if (bank) {
    const m = bank.match(/Dimm\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  const m = locator.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse `dmidecode -t 17` output into a MemoryTopology. Exported for tests.
 * Returns null when there are no Memory Device records (nothing to report).
 */
export function parseDmidecodeMemory(raw: string | null): MemoryTopology | null {
  if (!raw) return null;

  // Each "Memory Device" line begins one record; indented "Key: Value" lines
  // follow until the next record / blank separator. Split on the header.
  const blocks = raw.split(/^Memory Device\s*$/m).slice(1);
  if (blocks.length === 0) return null;

  const dimms: MemoryDimm[] = [];
  for (const block of blocks) {
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^\s+([^:]+):\s?(.*)$/);
      if (m) fields[m[1].trim()] = m[2].trim();
    }
    // A block with no Locator is not a real slot record (defensive).
    const locator = fields["Locator"];
    if (locator === undefined) continue;

    const sizeRaw = fields["Size"];
    const populated = !!sizeRaw && !/no module/i.test(sizeRaw);
    const bank = fields["Bank Locator"] || null;

    dimms.push({
      locator,
      bank_locator: bank,
      socket: parseSocket(locator, bank),
      channel: parseChannel(locator, bank),
      slot: parseSlotIndex(locator, bank),
      populated,
      size_mb: populated ? parseSizeMb(sizeRaw) : null,
      rank: populated ? parseIntOrNull(fields["Rank"]) : null,
      type: populated ? (fields["Type"] || null) : null,
      speed_mts: populated ? parseMts(fields["Speed"]) : null,
      configured_mts: populated ? parseMts(fields["Configured Memory Speed"] || fields["Configured Clock Speed"]) : null,
      manufacturer: populated ? (fields["Manufacturer"] || null) : null,
      part_number: populated ? (fields["Part Number"]?.trim() || null) : null,
    });
  }

  if (dimms.length === 0) return null;

  const populatedDimms = dimms.filter((d) => d.populated);
  const distinct = (vals: (string | null)[]) => new Set(vals.filter((v): v is string => v !== null)).size;

  const downclocked = populatedDimms.some(
    (d) => d.configured_mts !== null && d.speed_mts !== null && d.configured_mts < d.speed_mts,
  );
  const mixed_parts = distinct(populatedDimms.map((d) => d.part_number)) > 1;

  return {
    source: "dmidecode",
    total_slots: dimms.length,
    populated_slots: populatedDimms.length,
    available_channels: distinct(dimms.map((d) => d.channel)),
    populated_channels: distinct(populatedDimms.map((d) => d.channel)),
    downclocked,
    mixed_parts,
    dimms,
  };
}

export async function collectMemoryTopology(): Promise<MemoryTopology | null> {
  const raw = await runPrivileged("dmidecode-memory");
  return parseDmidecodeMemory(raw);
}
