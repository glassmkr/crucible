import { describe, it, expect } from "vitest";
import { parseDmidecodeMemory } from "../memory-topology.js";

// Real `dmidecode -t 17` shape from agentic-12 (Supermicro SYS-530MT-H8TNR,
// Xeon E-2388G): 2 channels x 2 slots; DIMMA2 + DIMMB2 populated (one per
// channel) -> fully-populated channels, running at rated speed. The healthy
// baseline the rule must NOT fire on.
const AGENTIC12 = `Handle 0x0037, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x0035
\tSize: No Module Installed
\tForm Factor: DIMM
\tLocator: DIMMA1
\tBank Locator: P0_Node0_Channel0_Dimm0
\tType: Unknown
Handle 0x0039, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x0035
\tSize: 32 GiB
\tForm Factor: DIMM
\tLocator: DIMMA2
\tBank Locator: P0_Node0_Channel0_Dimm1
\tType: DDR4
\tSpeed: 3200 MT/s
\tManufacturer: Kingston
\tPart Number: 9965745-039.A00G
\tRank: 2
\tConfigured Memory Speed: 3200 MT/s
Handle 0x003B, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x0035
\tSize: No Module Installed
\tForm Factor: DIMM
\tLocator: DIMMB1
\tBank Locator: P0_Node0_Channel1_Dimm0
\tType: Unknown
Handle 0x003D, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x0035
\tSize: 32 GiB
\tForm Factor: DIMM
\tLocator: DIMMB2
\tBank Locator: P0_Node0_Channel1_Dimm1
\tType: DDR4
\tSpeed: 3200 MT/s
\tManufacturer: Kingston
\tPart Number: 9965745-039.A00G
\tRank: 2
\tConfigured Memory Speed: 3200 MT/s`;

// Synthetic 8-channel (EPYC-style, letter locators, no explicit "Channel<N>"
// in bank) with only 4 channels populated -> under-populated.
function eightChannelHalf(): string {
  const chans = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const populated = new Set(["A", "C", "E", "G"]);
  return chans
    .map((c, i) => {
      const filled = populated.has(c);
      return `Handle 0x00${i}0, DMI type 17, 92 bytes
Memory Device
\tArray Handle: 0x0035
\tSize: ${filled ? "32 GB" : "No Module Installed"}
\tLocator: DIMM${c}1
\tBank Locator: P0_CHANNEL_${c}
\tType: ${filled ? "DDR4" : "Unknown"}${filled ? "\n\tSpeed: 3200 MT/s\n\tPart Number: MTA18\n\tRank: 2\n\tConfigured Memory Speed: 3200 MT/s" : ""}`;
    })
    .join("\n");
}

describe("parseDmidecodeMemory", () => {
  it("returns null for empty / non-Type-17 output (VM, no perms)", () => {
    expect(parseDmidecodeMemory(null)).toBeNull();
    expect(parseDmidecodeMemory("")).toBeNull();
    expect(parseDmidecodeMemory("# no memory devices here")).toBeNull();
  });

  it("parses the agentic-12 baseline as fully-populated channels, at rated speed", () => {
    const t = parseDmidecodeMemory(AGENTIC12)!;
    expect(t).not.toBeNull();
    expect(t.total_slots).toBe(4);
    expect(t.populated_slots).toBe(2);
    expect(t.available_channels).toBe(2); // Channel0 + Channel1
    expect(t.populated_channels).toBe(2); // both channels have a DIMM => healthy
    expect(t.downclocked).toBe(false);
    expect(t.mixed_parts).toBe(false);
    const a2 = t.dimms.find((d) => d.locator === "DIMMA2")!;
    expect(a2.populated).toBe(true);
    expect(a2.channel).toBe("0");
    expect(a2.size_mb).toBe(32 * 1024);
    expect(a2.speed_mts).toBe(3200);
    expect(a2.configured_mts).toBe(3200);
    const a1 = t.dimms.find((d) => d.locator === "DIMMA1")!;
    expect(a1.populated).toBe(false);
    expect(a1.channel).toBe("0"); // empty slot still maps to its channel
  });

  it("flags an 8-channel box with only 4 channels populated (letter-locator fallback)", () => {
    const t = parseDmidecodeMemory(eightChannelHalf())!;
    expect(t.total_slots).toBe(8);
    expect(t.populated_slots).toBe(4);
    expect(t.available_channels).toBe(8); // A..H from DIMM<letter>
    expect(t.populated_channels).toBe(4); // A,C,E,G => under-populated
  });

  it("detects a 2DPC/rank downclock (configured < rated)", () => {
    const raw = AGENTIC12.replace(/Configured Memory Speed: 3200 MT\/s/g, "Configured Memory Speed: 2933 MT/s");
    const t = parseDmidecodeMemory(raw)!;
    expect(t.downclocked).toBe(true);
  });

  it("flags mixed part numbers across populated DIMMs", () => {
    const raw = AGENTIC12.replace("9965745-039.A00G\n\tRank: 2\n\tConfigured Memory Speed: 3200 MT/s\nHandle 0x003B", "OTHER-PART-XYZ\n\tRank: 2\n\tConfigured Memory Speed: 3200 MT/s\nHandle 0x003B");
    const t = parseDmidecodeMemory(raw)!;
    expect(t.mixed_parts).toBe(true);
  });
});
