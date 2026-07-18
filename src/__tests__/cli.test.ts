import { describe, it, expect } from "vitest";
import { parseCliArgs, helpText, DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH, resolveConfigPathWithLegacyFallback } from "../cli.js";

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
  it("lists init in the subcommands section", () => {
    const txt = helpText("0.9.1");
    expect(txt).toContain("init");
  });
});

describe("resolveConfigPathWithLegacyFallback", () => {
  function mkDeps(present: string[]) {
    const warns: string[] = [];
    return {
      deps: {
        existsSync: (p: string) => present.includes(p),
        warn: (m: string) => { warns.push(m); },
      },
      warns,
    };
  }

  it("returns the new default path when it exists (no warn)", () => {
    const { deps, warns } = mkDeps([DEFAULT_CONFIG_PATH]);
    const resolved = resolveConfigPathWithLegacyFallback(DEFAULT_CONFIG_PATH, deps);
    expect(resolved).toBe(DEFAULT_CONFIG_PATH);
    expect(warns).toHaveLength(0);
  });

  it("falls back to legacy path with warn when only the legacy file exists", () => {
    const { deps, warns } = mkDeps([LEGACY_CONFIG_PATH]);
    const resolved = resolveConfigPathWithLegacyFallback(DEFAULT_CONFIG_PATH, deps);
    expect(resolved).toBe(LEGACY_CONFIG_PATH);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("legacy config path");
    expect(warns[0]).toContain(LEGACY_CONFIG_PATH);
    expect(warns[0]).toContain("glassmkr-crucible init");
  });

  it("prefers the new path when both exist (no warn)", () => {
    const { deps, warns } = mkDeps([DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH]);
    const resolved = resolveConfigPathWithLegacyFallback(DEFAULT_CONFIG_PATH, deps);
    expect(resolved).toBe(DEFAULT_CONFIG_PATH);
    expect(warns).toHaveLength(0);
  });

  it("returns input unchanged when neither file exists (config-missing error surfaces downstream from loadConfig)", () => {
    const { deps, warns } = mkDeps([]);
    const resolved = resolveConfigPathWithLegacyFallback(DEFAULT_CONFIG_PATH, deps);
    expect(resolved).toBe(DEFAULT_CONFIG_PATH);
    expect(warns).toHaveLength(0);
  });

  it("never falls back when an explicit --config path was passed (even to a non-existent custom file)", () => {
    const { deps, warns } = mkDeps([LEGACY_CONFIG_PATH]);
    const customPath = "/tmp/somewhere-explicit.yaml";
    const resolved = resolveConfigPathWithLegacyFallback(customPath, deps);
    expect(resolved).toBe(customPath);
    expect(warns).toHaveLength(0);
  });
});

describe("init subcommand parsing", () => {
  it("init without an api key is accepted for repair mode", () => {
    const { result } = parseCliArgs(["init"], "0.9.1");
    expect(result.mode).toBe("init");
    expect(result.init?.apiKey).toBeUndefined();
  });
  it("init --api-key K -> mode=init with the key captured", () => {
    const { result } = parseCliArgs(["init", "--api-key", "gmk_cru_live_abc"], "0.9.1");
    expect(result.mode).toBe("init");
    expect(result.init?.apiKey).toBe("gmk_cru_live_abc");
    expect(result.init?.noStart).toBe(false);
    expect(result.init?.force).toBe(false);
  });
  it("init --api-key=K equals form works", () => {
    const { result } = parseCliArgs(["init", "--api-key=col_xyz"], "0.9.1");
    expect(result.init?.apiKey).toBe("col_xyz");
  });
  it("init --api-key - (stdin marker) is preserved as the literal -", () => {
    const { result } = parseCliArgs(["init", "--api-key", "-"], "0.9.1");
    expect(result.init?.apiKey).toBe("-");
  });
  it("init --no-start --force --no-verify flags toggle correctly", () => {
    const { result } = parseCliArgs(["init", "--api-key", "k", "--no-start", "--force", "--no-verify"], "0.9.1");
    expect(result.init?.noStart).toBe(true);
    expect(result.init?.force).toBe(true);
    expect(result.init?.noVerify).toBe(true);
  });
  it("init --name and --ingest-url and --config-path are captured", () => {
    const { result } = parseCliArgs([
      "init", "--api-key", "k", "--name", "web-01", "--ingest-url", "https://dashboard.example.com/api/v1/ingest", "--config-path", "/etc/x.yaml",
    ], "0.9.1");
    expect(result.init?.name).toBe("web-01");
    expect(result.init?.ingestUrl).toBe("https://dashboard.example.com/api/v1/ingest");
    expect(result.init?.configPath).toBe("/etc/x.yaml");
  });
  it("init --help returns help text instead of running init", () => {
    const { result, output } = parseCliArgs(["init", "--help"], "0.9.1");
    expect(result.mode).toBe("help");
    expect(output).toContain("glassmkr-crucible init");
    expect(output).toContain("--api-key");
    expect(output).toContain("--no-start");
  });
});

describe("enroll endpoint policy parsing", () => {
  it("keeps insecure endpoints disabled by default", () => {
    const { result } = parseCliArgs(["enroll", "--account-key", "fixture"], "0.14.5");
    expect(result.enroll?.allowInsecureEndpoint).toBe(false);
  });

  it("captures explicit insecure and repeatable origin exceptions", () => {
    const { result } = parseCliArgs([
      "enroll",
      "--account-key=fixture",
      "--allow-insecure-endpoint",
      "--allow-endpoint-origin", "https://ingest.example.com",
      "--allow-endpoint-origin=https://backup.example.com",
    ], "0.14.5");
    expect(result.enroll?.allowInsecureEndpoint).toBe(true);
    expect(result.enroll?.allowedEndpointOrigins).toEqual([
      "https://ingest.example.com",
      "https://backup.example.com",
    ]);
  });
});
