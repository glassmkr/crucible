// Tests for the systemd collector. Verifies:
//   - The happy path: no failed units, no journalctl calls
//   - Failed units are listed
//   - journal_excerpts is populated per failed unit (Codex
//     experiment 2026-05-12 P2: closes the seam between "service
//     failed" and "what went wrong" without forcing the customer
//     to SSH to the box)

import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const runDetailedMock = vi.fn();
vi.mock("../../lib/exec.js", () => ({
  run: (...args: unknown[]) => runMock(...args),
  runDetailed: (...args: unknown[]) => runDetailedMock(...args),
}));

const {
  collectSystemd,
  redactJournalLine,
  sanitizeJournalLines,
  JOURNAL_MAX_LINE_CHARS,
  JOURNAL_MAX_TOTAL_CHARS,
} = await import("../systemd.js");

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

describe("journal excerpt data boundary", () => {
  it("redacts authorization, password, collector-key, and JWT shapes", () => {
    const collectorKey = ["gmk", "cru", "live", "EXAMPLEEXAMPLE000000", "ex01"].join("_");
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const raw = `Authorization: Bearer top.secret password=hunter2 api_key=${collectorKey} token=${jwt} authorization=opaque`;
    const redacted = redactJournalLine(raw);
    expect(redacted).not.toContain("top.secret");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain(collectorKey);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("opaque");
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes URL userinfo and sensitive query values", () => {
    const redacted = redactJournalLine("failed postgresql://alice:swordfish@example.test/db?token=secret-value&page=1");
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("swordfish");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("%5BREDACTED%5D");
  });

  it("does not redact query keys that merely contain sensitive substrings", () => {
    const raw = "https://example.test/?design=blue&assignee=alice&session_id=public-id";
    expect(redactJournalLine(raw)).toBe(raw);
  });

  it("does not redact assignment keys that merely end in key", () => {
    expect(redactJournalLine("monkey=banana hockey-key=public")).toBe("monkey=banana hockey-key=public");
  });

  it.each([
    "token",
    "key",
    "apikey",
    "passphrase",
    "auth",
    "secret_key",
    "secret-key",
    "private_key",
    "private-key",
    "access_key",
    "access-key",
    "aws_secret_access_key",
  ])("redacts opaque values assigned to %s", (key) => {
    const opaque = "plainOpaqueValue";
    const redacted = redactJournalLine(`${key}=${opaque}`);
    expect(redacted).not.toContain(opaque);
    expect(redacted).toContain("[REDACTED]");
  });

  it.each([
    "DATABASE_PASSWORD",
    "SMTP_PASSWORD",
    "MY_API_KEY",
    "app.secret",
    "x_secret_key",
  ])("redacts secrets under prefixed env-var names like %s", (key) => {
    const opaque = "plainOpaqueValue";
    const redacted = redactJournalLine(`service crashed: ${key}=${opaque}`);
    expect(redacted).not.toContain(opaque);
    expect(redacted).toContain("[REDACTED]");
  });

  it("turns control characters into separators before bearer redaction", () => {
    const redacted = redactJournalLine("request failed: Bearer\u0000plainOpaqueValue");
    expect(redacted).not.toContain("plainOpaqueValue");
    expect(redacted).toContain("Bearer [REDACTED]");
  });

  it("caps each line and the aggregate excerpt budget", () => {
    const lines = sanitizeJournalLines(Array(5).fill("x".repeat(2000)), 1000);
    expect(lines.every((line) => line.length <= JOURNAL_MAX_LINE_CHARS)).toBe(true);
    expect(lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(1000);
    expect(JOURNAL_MAX_TOTAL_CHARS).toBe(4096);
  });
});
