// Tests for the systemd collector. Verifies:
//   - The happy path: no failed units, no journalctl calls
//   - Failed units are listed
//   - journal_excerpts is populated per failed unit (Codex
//     experiment 2026-05-12 P2 — closes the seam between "service
//     failed" and "what went wrong" without forcing the customer
//     to SSH to the box)

import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const runDetailedMock = vi.fn();
vi.mock("../../lib/exec.js", () => ({
  run: (...args: unknown[]) => runMock(...args),
  runDetailed: (...args: unknown[]) => runDetailedMock(...args),
}));

const { collectSystemd } = await import("../systemd.js");

beforeEach(() => {
  runMock.mockReset();
  runDetailedMock.mockReset();
});

function listResult(stdout: string) {
  return { installed: true, exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("collectSystemd", () => {
  it("happy path: no failed units, no journalctl calls", async () => {
    runDetailedMock.mockResolvedValueOnce(listResult(""));
    const out = await collectSystemd();
    expect(out.failed_units).toEqual([]);
    expect(out.failed_count).toBe(0);
    expect(out.journal_excerpts).toBeUndefined();
    // Single call to list-units; no journalctl.
    expect(out.available).toBe(true);
    expect(runDetailedMock).toHaveBeenCalledTimes(1);
    expect(runDetailedMock.mock.calls[0][0]).toBe("systemctl");
  });

  it("populates journal_excerpts per failed unit (Codex experiment 2026-05-12)", async () => {
    // list-units output (2 failed services)
    runDetailedMock.mockResolvedValueOnce(listResult(
      "fail2ban.service          loaded failed failed Fail2Ban Service\n" +
      "nginx.service             loaded failed failed nginx web server\n"
    ));
    // Per-unit iteration: journalctl then systemctl-show, twice.
    // C12 (2026-05-19) added the systemctl-show calls.
    runMock.mockResolvedValueOnce(
      "Have not found any log file for sshd jail\n" +
      "Async configuration of server failed\n" +
      "fail2ban.service: Main process exited"
    );
    runMock.mockResolvedValueOnce(
      "Result=exit-code\nActiveState=failed\nSubState=failed\nNRestarts=2"
    );
    runMock.mockResolvedValueOnce(
      "nginx: [emerg] bind() to 0.0.0.0:80 failed\n" +
      "nginx.service: Failed with result 'exit-code'"
    );
    runMock.mockResolvedValueOnce(
      "Result=exit-code\nActiveState=failed\nSubState=failed\nNRestarts=1"
    );

    const out = await collectSystemd();
    expect(out.failed_units).toEqual(["fail2ban.service", "nginx.service"]);
    expect(out.failed_count).toBe(2);
    expect(out.journal_excerpts).toBeDefined();
    expect(out.journal_excerpts!["fail2ban.service"][0]).toMatch(/sshd jail/);
    expect(out.journal_excerpts!["nginx.service"][0]).toMatch(/bind/);
    // C12 details present.
    expect(out.failed_unit_details).toBeDefined();
    expect(out.failed_unit_details!["fail2ban.service"].result).toBe("exit-code");
    expect(out.failed_unit_details!["fail2ban.service"].n_restarts).toBe(2);
  });

  it("empty journal output yields empty array, not missing field, for that unit", async () => {
    runDetailedMock.mockResolvedValueOnce(listResult(
      "some-unit.service           loaded failed failed example\n"
    ));
    runMock.mockResolvedValueOnce(""); // journalctl returned nothing
    runMock.mockResolvedValueOnce("Result=unknown\nActiveState=failed\nSubState=failed\nNRestarts=0");
    const out = await collectSystemd();
    expect(out.journal_excerpts!["some-unit.service"]).toEqual([]);
  });

  it("skips DEFAULT_EXCLUDES units (systemd-networkd-wait-online by default)", async () => {
    runDetailedMock.mockResolvedValueOnce(listResult(
      "systemd-networkd-wait-online.service  loaded failed failed wait-online\n" +
      "real.service                          loaded failed failed real\n"
    ));
    runMock.mockResolvedValueOnce("real journal line");
    runMock.mockResolvedValueOnce("Result=exit-code\nActiveState=failed\nSubState=failed\nNRestarts=0");
    const out = await collectSystemd();
    expect(out.failed_units).toEqual(["real.service"]);
  });

  it("reports command failure as unavailable instead of zero failed units", async () => {
    runDetailedMock.mockResolvedValueOnce({
      installed: true,
      exitCode: 1,
      stdout: "",
      stderr: "Failed to connect to bus",
      timedOut: false,
    });
    const out = await collectSystemd();
    expect(out.available).toBe(false);
    expect(out.failed_count).toBeNull();
    expect(out.error).toContain("Failed to connect to bus");
  });

  it("distinguishes a timeout and missing binary", async () => {
    runDetailedMock.mockResolvedValueOnce({ installed: true, exitCode: null, stdout: null, stderr: "", timedOut: true });
    expect((await collectSystemd()).error).toContain("timed out");
    runDetailedMock.mockResolvedValueOnce({ installed: false, exitCode: null, stdout: null, stderr: "", timedOut: false });
    expect((await collectSystemd()).error).toContain("not installed");
  });
});
