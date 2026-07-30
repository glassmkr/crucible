// Tests for the shared lib/dmesg read + timestamp parser.
//
// readDmesg is exercised with a mocked lib/exec `run` so we can assert
// the two-step argv (iso attempt, then plain fallback) and the
// fall-back-on-empty behaviour both collectors relied on.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
vi.mock("../exec.js", () => ({
  run: (...args: unknown[]) => runMock(...args),
}));

const { readDmesg, parseKernelLogTimestamp } = await import("../dmesg.js");

beforeEach(() => {
  runMock.mockReset();
});

describe("readDmesg", () => {
  it("returns the iso-attempt output when it succeeds (no fallback call)", async () => {
    runMock.mockResolvedValueOnce("iso line\n");
    const out = await readDmesg();
    expect(out).toBe("iso line\n");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).toBe("dmesg");
    expect(runMock.mock.calls[0][1]).toEqual(["--time-format=iso", "--no-pager"]);
  });

  it("appends extraIsoArgs to the iso attempt only", async () => {
    runMock.mockResolvedValueOnce("iso line\n");
    await readDmesg({ extraIsoArgs: ["--ctime"] });
    expect(runMock.mock.calls[0][1]).toEqual(["--time-format=iso", "--no-pager", "--ctime"]);
  });

  it("falls back to plain --no-pager when the iso attempt is null", async () => {
    runMock.mockResolvedValueOnce(null);
    runMock.mockResolvedValueOnce("plain line\n");
    const out = await readDmesg();
    expect(out).toBe("plain line\n");
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock.mock.calls[1][1]).toEqual(["--no-pager"]);
  });

  it("falls back when the iso attempt is an empty string", async () => {
    runMock.mockResolvedValueOnce("");
    runMock.mockResolvedValueOnce("plain line\n");
    const out = await readDmesg();
    expect(out).toBe("plain line\n");
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when both attempts produce nothing", async () => {
    runMock.mockResolvedValueOnce(null);
    runMock.mockResolvedValueOnce(null);
    expect(await readDmesg()).toBeNull();
  });

  it("threads timeoutMs through to both run calls", async () => {
    runMock.mockResolvedValueOnce(null);
    runMock.mockResolvedValueOnce(null);
    await readDmesg({ timeoutMs: 5000 });
    expect(runMock.mock.calls[0][2]).toBe(5000);
    expect(runMock.mock.calls[1][2]).toBe(5000);
  });

  it("omits the timeout arg entirely when timeoutMs is unset (run's default applies)", async () => {
    runMock.mockResolvedValueOnce("x\n");
    await readDmesg();
    // run was called with exactly (cmd, args); no third positional.
    expect(runMock.mock.calls[0].length).toBe(2);
  });
});

describe("parseKernelLogTimestamp", () => {
  it("parses ISO format with comma fractional seconds and timezone", () => {
    const ts = parseKernelLogTimestamp("2026-05-19T12:34:56,789012+00:00 some message");
    expect(ts).not.toBeNull();
    expect(typeof ts).toBe("number");
    // comma-normalised-to-dot must parse to the same instant as the dot form
    expect(ts).toBe(Date.parse("2026-05-19T12:34:56.789012+00:00"));
  });

  it("parses ISO format with Z suffix", () => {
    const ts = parseKernelLogTimestamp("2026-05-19T12:34:56Z kernel: hi");
    expect(ts).toBe(Date.parse("2026-05-19T12:34:56Z"));
  });

  it("parses ctime format from --ctime", () => {
    const ts = parseKernelLogTimestamp("[Mon May 19 12:34:56 2026] some message");
    expect(ts).not.toBeNull();
    expect(ts).toBe(Date.parse("Mon May 19 12:34:56 2026"));
  });

  it("returns null for relative-time format", () => {
    expect(parseKernelLogTimestamp("[12345.678] some message")).toBeNull();
  });

  it("returns null for a line with no leading timestamp", () => {
    expect(parseKernelLogTimestamp("no timestamp here")).toBeNull();
  });
});
