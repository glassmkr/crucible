import { describe, it, expect } from "vitest";
import { parseKeyValue, parseKb } from "../parse.js";

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
