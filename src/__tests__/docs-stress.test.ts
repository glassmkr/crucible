import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptPath = "docs/measurements/2026-05-19/scripts/run_stress.sh";

describe("measurement stress runner hardening", () => {
  it("has valid Bash syntax", () => {
    expect(() => execFileSync("bash", ["-n", scriptPath])).not.toThrow();
  });

  it("uses exclusive output creation inside a verified private directory", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("set -o noclobber");
    expect(script).toContain("install -d -o root -g root -m 0700");
    expect(script).toContain("mktemp --");
    expect(script).toContain("refusing symlink in output path");
    expect(script).toContain("refusing to overwrite existing output");
  });

  it("restores the service from an EXIT and signal cleanup path", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 143' TERM");
    expect(script).toMatch(/if \[ "\$SERVICE_NEEDS_RESTORE" -eq 1 \]; then\s+if ! systemctl start glassmkr-crucible;/);
  });
});
