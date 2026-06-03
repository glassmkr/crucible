import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseColumnarStat,
  parseEqualsKeyValue,
  parseKeyValue,
  parseKb,
  readDirSafe,
  readFileInt,
  readFileTrim,
} from "../parse.js";

describe("parseKeyValue", () => {
  it("parses colon-delimited key/value lines", () => {
    const out = parseKeyValue("Name: foo\nVersion: 1.2.3\n");
    expect(out).toEqual({ Name: "foo", Version: "1.2.3" });
  });
  it("ignores lines with no colon", () => {
    expect(parseKeyValue("no colon here\nA: 1\n")).toEqual({ A: "1" });
  });
  it("trims whitespace around keys and values", () => {
    expect(parseKeyValue("   A   :    1   \n")).toEqual({ A: "1" });
  });
});

describe("parseEqualsKeyValue", () => {
  it("parses equals-delimited key/value lines (systemctl show shape)", () => {
    const out = parseEqualsKeyValue(
      "Result=exit-code\nActiveState=failed\nSubState=failed\nNRestarts=2",
    );
    expect(out).toEqual({
      Result: "exit-code",
      ActiveState: "failed",
      SubState: "failed",
      NRestarts: "2",
    });
  });
  it("ignores lines with no equals sign", () => {
    expect(parseEqualsKeyValue("no equals here\nA=1\n")).toEqual({ A: "1" });
  });
  it("trims whitespace around keys and values", () => {
    expect(parseEqualsKeyValue("   A   =    1   \n")).toEqual({ A: "1" });
  });
  it("splits on the first equals so values may contain equals", () => {
    expect(parseEqualsKeyValue("ExecStart=/bin/sh -c x=1")).toEqual({
      ExecStart: "/bin/sh -c x=1",
    });
  });
  it("returns {} for empty input", () => {
    expect(parseEqualsKeyValue("")).toEqual({});
  });
});

describe("parseColumnarStat", () => {
  // Shape of /proc/net/snmp's Tcp: section.
  const snmp =
    "Tcp: RtoAlgorithm RtoMin InSegs OutSegs RetransSegs\n" +
    "Tcp: 1 200 9876543 8765432 1234\n";

  it("extracts requested columns from the header+value rows", () => {
    expect(parseColumnarStat(snmp, "Tcp:", ["InSegs", "OutSegs", "RetransSegs"])).toEqual({
      InSegs: 9876543,
      OutSegs: 8765432,
      RetransSegs: 1234,
    });
  });
  it("ignores other prefixed sections in the same file", () => {
    const mixed =
      "Ip: Forwarding DefaultTTL\nIp: 1 64\n" + snmp + "Udp: InDatagrams\nUdp: 5\n";
    expect(parseColumnarStat(mixed, "Tcp:", ["InSegs"])).toEqual({ InSegs: 9876543 });
  });
  it("returns null when the section is absent", () => {
    expect(parseColumnarStat("Ip: Forwarding\nIp: 1\n", "Tcp:", ["InSegs"])).toBeNull();
  });
  it("returns null when only the header row is present (no value row)", () => {
    expect(parseColumnarStat("Tcp: InSegs OutSegs\n", "Tcp:", ["InSegs"])).toBeNull();
  });
  it("returns null when a requested column is missing from the header", () => {
    expect(parseColumnarStat(snmp, "Tcp:", ["InSegs", "Nope"])).toBeNull();
  });
  it("returns null when a requested value is non-numeric", () => {
    const bad = "Tcp: InSegs OutSegs\nTcp: 100 notanumber\n";
    expect(parseColumnarStat(bad, "Tcp:", ["OutSegs"])).toBeNull();
  });
  it("strips the prefix token before splitting (longer prefix)", () => {
    const ext =
      "TcpExt: ListenOverflows ListenDrops\nTcpExt: 7 3\n";
    expect(parseColumnarStat(ext, "TcpExt:", ["ListenOverflows", "ListenDrops"])).toEqual({
      ListenOverflows: 7,
      ListenDrops: 3,
    });
  });
});

describe("parseKb", () => {
  it("parses a numeric kB value", () => {
    expect(parseKb("16384 kB")).toBe(16384);
  });
  it("parses without unit", () => {
    expect(parseKb("4096")).toBe(4096);
  });
  it("returns 0 for undefined/bad input", () => {
    expect(parseKb(undefined)).toBe(0);
    expect(parseKb("not a number")).toBe(0);
  });
});

describe("file-read helpers", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crucible-parse-"));
    writeFileSync(join(dir, "value"), "  42\n");
    writeFileSync(join(dir, "text"), "  hello world  \n");
    writeFileSync(join(dir, "empty"), "   \n");
    writeFileSync(join(dir, "notint"), "12x\n");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("readFileTrim", () => {
    it("returns trimmed contents", () => {
      expect(readFileTrim(join(dir, "text"))).toBe("hello world");
    });
    it("returns empty string (not null) for whitespace-only files", () => {
      expect(readFileTrim(join(dir, "empty"))).toBe("");
    });
    it("returns null when the file does not exist", () => {
      expect(readFileTrim(join(dir, "nope"))).toBeNull();
    });
  });

  describe("readFileInt", () => {
    it("parses a non-negative integer", () => {
      expect(readFileInt(join(dir, "value"))).toBe(42);
    });
    it("returns null for non-integer contents", () => {
      expect(readFileInt(join(dir, "notint"))).toBeNull();
      expect(readFileInt(join(dir, "text"))).toBeNull();
      expect(readFileInt(join(dir, "empty"))).toBeNull();
    });
    it("returns null when the file does not exist", () => {
      expect(readFileInt(join(dir, "nope"))).toBeNull();
    });
  });

  describe("readDirSafe", () => {
    it("lists directory entries", () => {
      expect(readDirSafe(dir).sort()).toEqual(["empty", "notint", "text", "value"]);
    });
    it("returns [] for a missing directory", () => {
      expect(readDirSafe(join(dir, "nope"))).toEqual([]);
    });
  });
});
