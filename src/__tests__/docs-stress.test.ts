import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("docs/measurements/2026-05-19/scripts/run_stress.sh");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-stress-test-"));
  tempDirs.push(dir);
  return dir;
}

function runSourced(body: string, env: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    ["-c", 'RUN_STRESS_SOURCE_ONLY=1 source "$1"; shift; eval "$1"', "bash", scriptPath, body],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("measurement stress runner hardening", () => {
  it("has valid Bash syntax", () => {
    expect(() => execFileSync("bash", ["-n", scriptPath])).not.toThrow();
  });

  it("rejects a symlinked output path component", () => {
    const root = makeTempDir();
    const target = join(root, "target");
    const link = join(root, "linked");
    writeFileSync(target, "not used");
    symlinkSync(target, link);
    const result = runSourced('reject_symlink_components "$OUTPUT_DIR"', { OUTPUT_DIR: link });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing symlink in output path");
  });

  it("refuses to clobber an existing output", () => {
    const existing = join(makeTempDir(), "existing.csv");
    writeFileSync(existing, "evidence");
    const result = runSourced('require_new_output "$TARGET"', { TARGET: existing });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to overwrite existing output");
    expect(readFileSync(existing, "utf8")).toBe("evidence");
  });

  it("rejects non-normalized and control-character output paths", () => {
    const nonNormalized = runSourced("validate_output_dir_syntax", { OUTPUT_DIR: "/var/lib/example/../escape" });
    expect(nonNormalized.status).not.toBe(0);
    expect(nonNormalized.stderr).toContain("normalized absolute path");

    const controlCharacter = runSourced("validate_output_dir_syntax", { OUTPUT_DIR: "/var/lib/example\nother" });
    expect(controlCharacter.status).not.toBe(0);
    expect(controlCharacter.stderr).toContain("control characters");
  });

  it("ignores a second termination signal while restoring the service", () => {
    const marker = join(makeTempDir(), "restored");
    const result = runSourced(
      'SERVICE_NEEDS_RESTORE=1; systemctl() { kill -TERM $$; printf restored > "$RESTORE_MARKER"; }; cleanup',
      { RESTORE_MARKER: marker },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("restored");
  });

  it.skipIf(!existsSync("/usr/bin/flock") && !existsSync("/bin/flock"))(
    "refuses a concurrent Profile B lock",
    () => {
      const lock = join(makeTempDir(), "profile-b.lock");
      const result = runSourced(
        'exec 9>"$LOCK_PATH"; flock -n 9; if acquire_profile_b_lock "$LOCK_PATH"; then exit 9; fi',
        { LOCK_PATH: lock },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("another Profile B run holds");
    },
  );
});
