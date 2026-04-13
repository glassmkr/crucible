import { describe, it, expect } from "vitest";
import { parseCliArgs, helpText, DEFAULT_CONFIG_PATH } from "../cli.js";

describe("parseCliArgs", () => {
  it("--version returns version string and mode=version", () => {
    const { result, output } = parseCliArgs(["--version"], "1.2.3");
    expect(result.mode).toBe("version");
    expect(output).toBe("glassmkr-crucible v1.2.3");
  });

  it("-v aliases --version", () => {
    const { result, output } = parseCliArgs(["-v"], "1.2.3");
    expect(result.mode).toBe("version");
    expect(output).toBe("glassmkr-crucible v1.2.3");
  });

  it("--help returns help text and mode=help", () => {
    const { result, output } = parseCliArgs(["--help"], "1.2.3");
    expect(result.mode).toBe("help");
    expect(output).toContain("glassmkr-crucible v1.2.3");
    expect(output).toContain("Usage:");
    expect(output).toContain("--version");
    expect(output).toContain("--help");
    expect(output).toContain("--config");
  });

  it("-h aliases --help", () => {
    const { result } = parseCliArgs(["-h"], "1.2.3");
    expect(result.mode).toBe("help");
  });

  it("no args returns mode=run with the default config path", () => {
    const { result, output } = parseCliArgs([], "1.2.3");
    expect(result.mode).toBe("run");
    expect(result.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(output).toBeNull();
  });

  it("-c accepts a path in the next argument", () => {
    const { result } = parseCliArgs(["-c", "/tmp/a.yaml"], "1.2.3");
    expect(result.configPath).toBe("/tmp/a.yaml");
  });

  it("--config accepts a path in the next argument", () => {
    const { result } = parseCliArgs(["--config", "/tmp/b.yaml"], "1.2.3");
    expect(result.configPath).toBe("/tmp/b.yaml");
  });

  it("--config=PATH form works", () => {
    const { result } = parseCliArgs(["--config=/tmp/c.yaml"], "1.2.3");
    expect(result.configPath).toBe("/tmp/c.yaml");
  });

  it("legacy positional argument still sets config path", () => {
    const { result } = parseCliArgs(["/tmp/legacy.yaml"], "1.2.3");
    expect(result.configPath).toBe("/tmp/legacy.yaml");
  });

  it("--version wins over a provided config path (no collector start)", () => {
    const { result } = parseCliArgs(["--config", "/tmp/x.yaml", "--version"], "1.2.3");
    expect(result.mode).toBe("version");
  });
});

describe("helpText", () => {
  it("mentions the binary name, default config path, and both flags", () => {
    const txt = helpText("0.6.1");
    expect(txt).toContain("glassmkr-crucible v0.6.1");
    expect(txt).toContain(DEFAULT_CONFIG_PATH);
    expect(txt).toContain("-v, --version");
    expect(txt).toContain("-h, --help");
    expect(txt).toContain("-c, --config");
  });
});
