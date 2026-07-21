import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSecureConfigStat, configLoadFailureMessage, loadConfig } from "../config.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stat(opts: { uid?: number; mode?: number; file?: boolean; symlink?: boolean } = {}) {
  return {
    uid: opts.uid ?? 0,
    mode: opts.mode ?? 0o100640,
    isFile: () => opts.file ?? true,
    isSymbolicLink: () => opts.symlink ?? false,
  };
}

describe("assertSecureConfigStat", () => {
  it("accepts a root-owned 0640 regular file", () => {
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat())).not.toThrow();
  });

  it("accepts a restrictive service-user-owned config as transitional", () => {
    expect(assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ uid: 1000, mode: 0o100600 }), 1000)).toBe(true);
  });

  it("rejects a config owned by an unexpected user", () => {
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ uid: 1001 }), 1000))
      .toThrow(/unexpected uid/);
  });

  it("rejects a group-writable transitional config", () => {
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ uid: 1000, mode: 0o100620 }), 1000))
      .toThrow(/group\/other-writable/);
  });

  it.each([0o100660, 0o100644, 0o100641])("rejects unsafe mode %o", (mode) => {
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ mode })))
      .toThrow(/world-accessible|writable/);
  });

  it("rejects symbolic links and non-regular files", () => {
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ symlink: true })))
      .toThrow(/non-regular/);
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ file: false })))
      .toThrow(/non-regular/);
  });
});

describe("loadConfig", () => {
  it("formats integrity failures as explicit refuse-to-start errors", () => {
    expect(configLoadFailureMessage("/etc/glassmkr/crucible.yaml", new Error("unsafe owner")))
      .toContain("Refusing to start: /etc/glassmkr/crucible.yaml failed integrity or schema validation: unsafe owner");
  });

  it("loads a service-owned legacy config, warns once, and sets the migration flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-config-"));
    tempDirs.push(dir);
    const path = join(dir, "crucible.yaml");
    writeFileSync(path, 'server_name: "legacy-host"\n', { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadConfig(path)).toMatchObject({
      server_name: "legacy-host",
      config_migration_required: true,
    });
    loadConfig(path);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("sudo glassmkr-crucible init");
  });

  it("refuses a symlink without reading or changing its target", () => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-config-"));
    tempDirs.push(dir);
    const target = join(dir, "target.yaml");
    const path = join(dir, "crucible.yaml");
    writeFileSync(target, 'server_name: "target"\n', { mode: 0o600 });
    symlinkSync(target, path);

    expect(() => loadConfig(path)).toThrow();
    expect(readFileSync(target, "utf8")).toBe('server_name: "target"\n');
  });
});
