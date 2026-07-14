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

  // Real ASRock (Ryzen 5950X) shape: bare "DIMM 0"/"DIMM 1" locators (no
  // channel letter) so the channel MUST come from the "P0 CHANNEL A" bank
  // locator (space separator). Both channels have a DIMM => healthy.
  const ASROCK = `Memory Device
\tSize: No Module Installed
\tLocator: DIMM 0
\tBank Locator: P0 CHANNEL A
Memory Device
\tSize: 32 GB
\tLocator: DIMM 1
\tBank Locator: P0 CHANNEL A
\tSpeed: 3200 MT/s
\tConfigured Memory Speed: 3200 MT/s
Memory Device
\tSize: No Module Installed
\tLocator: DIMM 0
\tBank Locator: P0 CHANNEL B
Memory Device
\tSize: 32 GB
\tLocator: DIMM 1
\tBank Locator: P0 CHANNEL B
\tSpeed: 3200 MT/s
\tConfigured Memory Speed: 3200 MT/s`;

  it("parses ASRock's bare 'DIMM 0' locator via the 'P0 CHANNEL A' bank locator", () => {
    const t = parseDmidecodeMemory(ASROCK)!;
    expect(t.total_slots).toBe(4);
    expect(t.populated_slots).toBe(2);
    expect(t.available_channels).toBe(2); // A + B, from bank locator only
    expect(t.populated_channels).toBe(2); // one DIMM per channel => healthy
    const populated = t.dimms.filter((d) => d.populated);
    expect(populated.map((d) => d.channel).sort()).toEqual(["A", "B"]);
    expect(populated.every((d) => d.socket === 0)).toBe(true);
  });

  it("reads the channel through an underscore separator (Channel_A)", () => {
    const raw = ASROCK.replace(/P0 CHANNEL A/g, "P0_Channel_A").replace(/P0 CHANNEL B/g, "P0_Channel_B");
    const t = parseDmidecodeMemory(raw)!;
    expect(t.available_channels).toBe(2);
    expect(t.dimms.filter((d) => d.populated).map((d) => d.channel).sort()).toEqual(["A", "B"]);
  });

  // Real dual EPYC 7302 (Gigabyte): locator "DIMM_P0_A0", bank "BANK 0" (no
  // channel). 8 channels/socket (P0: A-H, P1: I-P), 1 DPC. Populated A,B,E,F
  // on socket 0 and I,J,M,N on socket 1 = 4 of 8 channels per socket. The
  // channel MUST come from the locator's post-P<n>_ letter, not "P".
  function gigabyteEpyc(): string {
    const p0 = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const p1 = ["I", "J", "K", "L", "M", "N", "O", "P"];
    const pop = new Set(["A", "B", "E", "F", "I", "J", "M", "N"]);
    const slot = (sock: number, ch: string, i: number) => {
      const filled = pop.has(ch);
      return `Handle 0x0${sock}${i}0, DMI type 17, 92 bytes
Memory Device
\tSize: ${filled ? "16 GiB" : "No Module Installed"}
\tLocator: DIMM_P${sock}_${ch}0
\tBank Locator: BANK 0${filled ? "\n\tType: DDR4\n\tSpeed: 3200 MT/s\n\tPart Number: M393A2K43DB3-CWE\n\tRank: 2\n\tConfigured Memory Speed: 3200 MT/s" : ""}`;
    };
    return [...p0.map((c, i) => slot(0, c, i)), ...p1.map((c, i) => slot(1, c, i))].join("\n");
  }

  it("parses dual EPYC 7302 (DIMM_P0_A0) channels from the locator, not the socket letter", () => {
    const t = parseDmidecodeMemory(gigabyteEpyc())!;
    expect(t.total_slots).toBe(16);
    expect(t.populated_slots).toBe(8);
    expect(t.available_channels).toBe(16); // A-P across 2 sockets
    expect(t.populated_channels).toBe(8);  // 4 per socket => under-populated
    const chans = t.dimms.filter((d) => d.populated).map((d) => d.channel).sort();
    expect(chans).toEqual(["A", "B", "E", "F", "I", "J", "M", "N"]);
    expect(chans).not.toContain("P"); // regression guard: not the socket letter
    // per-socket split the dashboard rule will use
    const s0 = t.dimms.filter((d) => d.populated && d.socket === 0).map((d) => d.channel).sort();
    const s1 = t.dimms.filter((d) => d.populated && d.socket === 1).map((d) => d.channel).sort();
    expect(s0).toEqual(["A", "B", "E", "F"]);
    expect(s1).toEqual(["I", "J", "M", "N"]);
  });

  // Regression: a dual-socket box that labels channels the SAME on both sockets
  // (DIMM_P0_A0 and DIMM_P1_A0 -> both channel "A", sockets 0 and 1). Counting
  // distinct channel LABELS alone collapses the two physical channels to one;
  // channels must be qualified by socket. Both are populated => 2 available and
  // 2 populated channels, not 1.
  it("keeps same-letter channels on different sockets distinct (socket-qualified count)", () => {
    const raw = `Memory Device
\tSize: 32 GiB
\tLocator: DIMM_P0_A0
\tBank Locator: BANK 0
\tType: DDR4
\tSpeed: 3200 MT/s
\tConfigured Memory Speed: 3200 MT/s
Memory Device
\tSize: 32 GiB
\tLocator: DIMM_P1_A0
\tBank Locator: BANK 0
\tType: DDR4
\tSpeed: 3200 MT/s
\tConfigured Memory Speed: 3200 MT/s`;
    const t = parseDmidecodeMemory(raw)!;
    expect(t.total_slots).toBe(2);
    expect(t.populated_slots).toBe(2);
    expect(t.dimms.map((d) => d.channel)).toEqual(["A", "A"]); // same label
    expect(t.dimms.map((d) => d.socket)).toEqual([0, 1]);      // different socket
    expect(t.available_channels).toBe(2); // NOT collapsed to 1
    expect(t.populated_channels).toBe(2);
  });

  // Real EPYC 9754 (ASUS): locator "CPU1_DIMM_A2", bank "P0 CHANNEL A". 12
  // channels (A-L), 2 DPC. 8 channels populated in slot 2 => 8 of 12.
  function asusEpyc9754(): string {
    const chans = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const pop = new Set(["A", "B", "C", "E", "G", "H", "I", "K"]);
    const out: string[] = [];
    chans.forEach((ch, ci) => {
      for (const dpc of [1, 2]) {
        const filled = pop.has(ch) && dpc === 2;
        out.push(`Handle 0x${ci}${dpc}00, DMI type 17, 92 bytes
Memory Device
\tSize: ${filled ? "64 GiB" : "No Module Installed"}
\tLocator: CPU1_DIMM_${ch}${dpc}
\tBank Locator: P0 CHANNEL ${ch}${filled ? "\n\tType: DDR5\n\tSpeed: 4800 MT/s\n\tPart Number: HMCG94AGBRA\n\tRank: 2\n\tConfigured Memory Speed: 4800 MT/s" : ""}`);
      }
    });
    return out.join("\n");
  }

  it("parses EPYC 9754 (CPU1_DIMM_A2) as 8 of 12 channels populated", () => {
    const t = parseDmidecodeMemory(asusEpyc9754())!;
    expect(t.total_slots).toBe(24);
    expect(t.populated_slots).toBe(8);
    expect(t.available_channels).toBe(12); // A-L
    expect(t.populated_channels).toBe(8);  // under-populated on a 12-ch CPU
    expect(t.dimms.filter((d) => d.populated).map((d) => d.channel).sort())
      .toEqual(["A", "B", "C", "E", "G", "H", "I", "K"]);
  });

  // Negative controls from the two FULLY-populated val boxes: the rule input
  // must read populated == available so the dashboard rule stays silent on
  // correctly-built servers.
  it("EPYC 7443 with all 8 channels populated reads 8/8 (negative control)", () => {
    const chans = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const raw = chans.map((c, i) => `Memory Device
\tSize: 32 GiB
\tLocator: DIMM${c}1
\tBank Locator: P0_Node0_Channel${i}_Dimm0
\tType: DDR4
\tSpeed: 3200 MT/s
\tPart Number: M393A4K40EB3-CWE
\tRank: 2
\tConfigured Memory Speed: 3200 MT/s`).join("\n");
    const t = parseDmidecodeMemory(raw)!;
    expect(t.available_channels).toBe(8);
    expect(t.populated_channels).toBe(8);
    expect(t.downclocked).toBe(false);
  });

  it("EPYC 9355P with all 12 channels populated reads 12/12 (negative control)", () => {
    const chans = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const raw = chans.flatMap((c) => [1, 2].map((dpc) => `Memory Device
\tSize: ${dpc === 2 ? "64 GiB" : "No Module Installed"}
\tLocator: CPU1_DIMM_${c}${dpc}
\tBank Locator: P0 CHANNEL ${c}${dpc === 2 ? "\n\tType: DDR5\n\tSpeed: 4800 MT/s\n\tPart Number: M321R8GA0BB0\n\tRank: 2\n\tConfigured Memory Speed: 4800 MT/s" : ""}`)).join("\n");
    const t = parseDmidecodeMemory(raw)!;
    expect(t.total_slots).toBe(24);
    expect(t.available_channels).toBe(12);
    expect(t.populated_channels).toBe(12);
  });

  it("flags mixed part numbers across populated DIMMs", () => {
    const raw = AGENTIC12.replace("9965745-039.A00G\n\tRank: 2\n\tConfigured Memory Speed: 3200 MT/s\nHandle 0x003B", "OTHER-PART-XYZ\n\tRank: 2\n\tConfigured Memory Speed: 3200 MT/s\nHandle 0x003B");
    const t = parseDmidecodeMemory(raw)!;
    expect(t.mixed_parts).toBe(true);
  });
});
