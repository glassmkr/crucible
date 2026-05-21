import { describe, it, expect } from "vitest";
import { run, runDetailed, looksLikeFieldRenameError } from "../exec.js";

describe("looksLikeFieldRenameError", () => {
  // Real-world fixtures from the two Crucible bugs that motivated this
  // defense. If the heuristic stops recognising these strings, the next
  // driver-version rename will hide for hours again.
  it("matches the v0.13.2 driver-550 clocks_event_reasons rename", () => {
    expect(
      looksLikeFieldRenameError(
        'Field "clocks_event_reasons.hw_power_brake" is not a valid field to query.',
      ),
    ).toBe(true);
  });

  it("matches the v0.13.0 retired_pages.double_bit_ecc typo", () => {
    expect(
      looksLikeFieldRenameError(
        'Field "retired_pages.double_bit_ecc.count" is not a valid field to query.',
      ),
    ).toBe(true);
  });

  it("matches generic 'unknown field' phrasing", () => {
    expect(looksLikeFieldRenameError("ERROR: unknown field 'foo_bar'")).toBe(true);
  });

  it("matches 'no such field' phrasing", () => {
    expect(looksLikeFieldRenameError("no such field: bar")).toBe(true);
  });

  it("matches XML tag-not-found pattern", () => {
    expect(
      looksLikeFieldRenameError(
        "<clocks_throttle_reasons>: not found in driver 550 output",
      ),
    ).toBe(true);
  });

  it("does NOT match empty stderr", () => {
    expect(looksLikeFieldRenameError("")).toBe(false);
  });

  it("does NOT match unrelated permission failures", () => {
    expect(looksLikeFieldRenameError("Permission denied")).toBe(false);
  });

  it("does NOT match real GPU-lost faults (different bug class)", () => {
    expect(
      looksLikeFieldRenameError(
        "Unable to determine the device handle for GPU 0000:00:00.0: GPU is lost.",
      ),
    ).toBe(false);
  });
});

describe("runDetailed", () => {
  it("returns installed=false on ENOENT", async () => {
    const res = await runDetailed("/no/such/binary-9j43k", []);
    expect(res.installed).toBe(false);
    expect(res.stdout).toBeNull();
    expect(res.exitCode).toBeNull();
  });

  it("returns installed=true + exit 0 + stdout for a normal command", async () => {
    const res = await runDetailed("echo", ["hello"]);
    expect(res.installed).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout?.trim()).toBe("hello");
    expect(res.timedOut).toBe(false);
  });

  it("returns exitCode + stderr for a non-zero exit", async () => {
    // `false` is /usr/bin/false on most systems; exits 1 with no output.
    const res = await runDetailed("sh", ["-c", "echo bar >&2; exit 5"]);
    expect(res.installed).toBe(true);
    expect(res.exitCode).toBe(5);
    expect(res.stderr.trim()).toBe("bar");
  });

  it("captures stderr even on exit 0 — the silent-no-op detection path", async () => {
    // This is the v0.13.0 / v0.13.2 shape: tool returns success exit
    // code but stderr says the field is unknown. runDetailed must
    // capture the stderr so the caller can apply looksLikeFieldRenameError.
    const res = await runDetailed(
      "sh",
      ["-c", "echo 'Field \"foo\" is not a valid field to query.' >&2; exit 0"],
    );
    expect(res.installed).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout?.trim()).toBe("");
    expect(looksLikeFieldRenameError(res.stderr)).toBe(true);
  });
});

describe("run (backwards-compat shim)", () => {
  it("returns null when command not installed", async () => {
    expect(await run("/no/such/binary-9j43k", [])).toBeNull();
  });

  it("returns stdout for a normal command", async () => {
    const out = await run("echo", ["hi"]);
    expect(out?.trim()).toBe("hi");
  });
});
