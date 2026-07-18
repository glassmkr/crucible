import { describe, expect, it } from "vitest";
import { assertSecureConfigStat } from "../config.js";

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

  it("rejects a service-user-owned config even when its mode is restrictive", () => {
    expect(() => assertSecureConfigStat("/etc/glassmkr/crucible.yaml", stat({ uid: 1000 })))
      .toThrow(/not owned by root/);
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
