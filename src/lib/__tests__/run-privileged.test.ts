import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the fs existsSync (wrapper presence) and the exec run() so we can
// exercise runPrivileged's wrapper-vs-root-direct branching without touching
// the real filesystem or spawning processes. Keep the rest of each module real.
vi.mock("fs", async (orig) => ({ ...(await orig<typeof import("fs")>()), existsSync: vi.fn() }));
vi.mock("../exec.js", async (orig) => ({ ...(await orig<typeof import("../exec.js")>()), run: vi.fn() }));

import { existsSync } from "fs";
import { run } from "../exec.js";
import { runPrivileged, WRAPPER_PATH } from "../privileged.js";

const existsMock = existsSync as unknown as ReturnType<typeof vi.fn>;
const runMock = run as unknown as ReturnType<typeof vi.fn>;

describe("runPrivileged: wrapper vs root-direct fallback", () => {
  beforeEach(() => {
    existsMock.mockReset();
    runMock.mockReset();
    runMock.mockResolvedValue("output");
  });

  it("uses the sudo wrapper when it is installed", async () => {
    existsMock.mockReturnValue(true);
    await runPrivileged("ipmi-sensor");
    expect(runMock).toHaveBeenCalledWith("sudo", ["-n", WRAPPER_PATH, "ipmi-sensor"], expect.any(Number));
  });

  it("falls back to the direct command when the wrapper is absent and we are root", async () => {
    existsMock.mockReturnValue(false);
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    await runPrivileged("ipmi-sensor");
    expect(runMock).toHaveBeenCalledWith("ipmitool", ["sensor"], expect.any(Number));
    getuid.mockRestore();
  });

  it("validates the smart device path on the direct fallback", async () => {
    existsMock.mockReturnValue(false);
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    await runPrivileged("smart", ["/dev/sda"]);
    expect(runMock).toHaveBeenCalledWith("smartctl", ["--json", "--all", "/dev/sda"], expect.any(Number));
    runMock.mockClear();
    const rejected = await runPrivileged("smart", ["/etc/shadow"]);
    expect(rejected).toBeNull();
    expect(runMock).not.toHaveBeenCalled();
    getuid.mockRestore();
  });

  it("returns null when the wrapper is absent and we are NOT root (no escalation)", async () => {
    existsMock.mockReturnValue(false);
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1000);
    const r = await runPrivileged("ipmi-sensor");
    expect(r).toBeNull();
    expect(runMock).not.toHaveBeenCalled();
    getuid.mockRestore();
  });
});
