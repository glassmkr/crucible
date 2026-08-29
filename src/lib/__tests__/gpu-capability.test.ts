import { describe, it, expect } from "vitest";
import { classifyProbe, isMeasured } from "../gpu-capability.js";

const ok = (over: Partial<Parameters<typeof classifyProbe>[1]> = {}) => ({
  installed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

const nonEmpty = (s: string) => s.trim().length > 0;

describe("classifyProbe", () => {
  it("reports supported when the command produced usable output", () => {
    const c = classifyProbe("nvlink.status", ok({ stdout: "Link 0: 26.562 GB/s" }), nonEmpty);
    expect(c.status).toBe("supported");
    expect(c.detail).toBeNull();
    expect(isMeasured(c)).toBe(true);
  });

  // THE case this module exists for. On our own L4, `nvidia-smi nvlink --status`
  // exits 0 and prints nothing, because the card has no NVLink. Reading that as
  // "supported, zero links" would let a rule conclude every link had failed.
  it("treats exit 0 with empty output as NOT SUPPORTED, never as a zero measurement", () => {
    const c = classifyProbe("nvlink.status", ok({ stdout: "" }), nonEmpty);
    expect(c.status).toBe("not_supported");
    expect(isMeasured(c)).toBe(false);
  });

  it("detects an absent binary", () => {
    const c = classifyProbe("nvlink.status", ok({ installed: false, exitCode: null, stdout: null }), nonEmpty);
    expect(c.status).toBe("tool_absent");
  });

  it("detects a timeout as transient, not as a missing feature", () => {
    const c = classifyProbe("nvlink.status", ok({ timedOut: true, stdout: null, exitCode: null }), nonEmpty);
    expect(c.status).toBe("temporarily_unavailable");
  });

  it("detects a permission failure separately, since a wrapper action could fix it", () => {
    const c = classifyProbe("nvlink.util", ok({ stderr: "Insufficient Permissions" }), nonEmpty);
    expect(c.status).toBe("permission_denied");
  });

  // The silent-rename class: nvidia-smi exits 0 and only stderr says the field is
  // unknown. This hid the v0.13.0 retired_pages typo and the v0.13.2
  // clocks_event_reasons rename for about a day each.
  it("catches a renamed or unknown field even when the command exits 0", () => {
    const c = classifyProbe(
      "gpu.csv",
      ok({ stdout: "some, output", stderr: "Field not found: clocks_throttle_reasons" }),
      nonEmpty,
    );
    expect(c.status).toBe("parse_or_api_mismatch");
    expect(c.detail).toContain("Field not found");
  });

  it("prefers the stderr marker over the exit code", () => {
    const c = classifyProbe("x", ok({ exitCode: 0, stdout: "data", stderr: "NVLink is not supported on this device" }), nonEmpty);
    expect(c.status).toBe("not_supported");
  });

  it("reads a not-supported marker printed to stdout on a nonzero exit", () => {
    const c = classifyProbe("x", ok({ exitCode: 9, stdout: "Feature not supported", stderr: "" }), nonEmpty);
    expect(c.status).toBe("not_supported");
  });

  it("falls back to parse_or_api_mismatch on an unexplained nonzero exit", () => {
    const c = classifyProbe("x", ok({ exitCode: 3, stdout: "", stderr: "" }), nonEmpty);
    expect(c.status).toBe("parse_or_api_mismatch");
    expect(c.detail).toContain("exit 3");
  });

  it("treats a driver/library mismatch as transient", () => {
    const c = classifyProbe("x", ok({ exitCode: 1, stderr: "Driver/library version mismatch" }), nonEmpty);
    expect(c.status).toBe("temporarily_unavailable");
  });

  it("lets the caller decide what counts as usable content", () => {
    // topo -m always prints a legend, so non-empty is not enough for it. But a
    // legend with NO matrix row is output we failed to read, not evidence the
    // feature is absent: a healthy single-GPU host still prints its own row,
    // so legend-only means the format moved under the parser. The earlier
    // expectation here (not_supported) blessed misclassifying a driver format
    // change as absent hardware (Codex 2026-08-29 #15).
    const legendOnly = "Legend:\n  X = Self\n";
    const strict = (s: string) => /GPU\d/.test(s);
    expect(classifyProbe("topo", ok({ stdout: legendOnly }), strict).status).toBe("parse_or_api_mismatch");
    expect(classifyProbe("topo", ok({ stdout: "GPU0\tX\t" }), strict).status).toBe("supported");
  });

  it("keeps EMPTY exit-0 output as not_supported (the verified L4 nvlink shape)", () => {
    const nonEmptyTest = (s: string) => s.trim().length > 0;
    const c = classifyProbe("nvlink", ok({ stdout: "" }), nonEmptyTest);
    expect(c.status).toBe("not_supported");
    expect(c.detail).toBe("no output and no error");
  });

  it("isMeasured rejects null and undefined", () => {
    expect(isMeasured(null)).toBe(false);
    expect(isMeasured(undefined)).toBe(false);
  });
});
