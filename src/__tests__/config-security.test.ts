import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoPosixAcl, assertSecureConfigStat, configLoadFailureMessage, loadConfig, unknownCollectionKeys } from "../config.js";

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

describe("assertNoPosixAcl", () => {
  it("passes a normal mode with no ACL suffix", () => {
    expect(() => assertNoPosixAcl("/etc/glassmkr/crucible.yaml",
      () => "-rw-r----- 1 0 1001 42 Jul 24 22:00 /etc/glassmkr/crucible.yaml")).not.toThrow();
  });

  it("rejects a mode whose ls field carries the ACL '+' suffix", () => {
    expect(() => assertNoPosixAcl("/etc/glassmkr/crucible.yaml",
      () => "-rw-r-----+ 1 0 1001 42 Jul 24 22:00 /etc/glassmkr/crucible.yaml"))
      .toThrow(/POSIX ACL/);
  });

  it("fails closed when ls cannot be run", () => {
    expect(() => assertNoPosixAcl("/etc/glassmkr/crucible.yaml", () => { throw new Error("ls: not found"); }))
      .toThrow(/cannot verify ACL state/);
  });

  it("fails closed on unparseable ls output", () => {
    expect(() => assertNoPosixAcl("/etc/glassmkr/crucible.yaml", () => "")).toThrow(/unparseable/);
    expect(() => assertNoPosixAcl("/etc/glassmkr/crucible.yaml", () => "-rw-")).toThrow(/unparseable/);
  });

  it("refuses to load an ACL'd config through loadConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-config-"));
    tempDirs.push(dir);
    const path = join(dir, "crucible.yaml");
    writeFileSync(path, 'server_name: "acl-host"\n', { mode: 0o600 });
    // Inject an ls runner that reports an ACL even though the on-disk file has
    // none, so the reject path is exercised deterministically on any host.
    expect(() => loadConfig(path, { runLs: () => `-rw-r-----+ 1 0 1001 24 Jul 24 22:00 ${path}` }))
      .toThrow(/POSIX ACL/);
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

describe("unknownCollectionKeys (2026-07-30 review finding #4)", () => {
  it("names a typo'd security setting instead of silently dropping it", () => {
    // The reported failure: Zod object schemas STRIP unknown keys, so this parses
    // clean and leaves enforce_ipmitool_min_version at its false default. The
    // operator believes they enabled fail-closed; nothing tells them otherwise.
    expect(unknownCollectionKeys({ enforce_ipmitool_min_versions: true }))
      .toEqual(["enforce_ipmitool_min_versions"]);
  });

  it("accepts every key the schema really defines", () => {
    expect(unknownCollectionKeys({
      ipmi: true,
      enforce_ipmitool_min_version: true,
      smart: true,
      thermal: true,
      dmi: true,
    })).toEqual([]);
  });

  it("reports several strays at once", () => {
    expect(unknownCollectionKeys({ ipmi: true, smrt: true, thermalz: false }).sort())
      .toEqual(["smrt", "thermalz"]);
  });

  it("is quiet on absent, empty or non-object collection blocks", () => {
    expect(unknownCollectionKeys(undefined)).toEqual([]);
    expect(unknownCollectionKeys(null)).toEqual([]);
    expect(unknownCollectionKeys({})).toEqual([]);
    expect(unknownCollectionKeys("nope")).toEqual([]);
    expect(unknownCollectionKeys(["ipmi"])).toEqual([]);
  });
});
