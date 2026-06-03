import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseKeyValue, parseKb, readDirSafe, readFileInt, readFileTrim } from "../parse.js";

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
