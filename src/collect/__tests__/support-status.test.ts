// Tests for collectSupportStatus (currency-monitoring milestone).
//
// The collector is fail-safe: any absent tool / unreadable file / unparseable
// output must degrade to null (or extended_support_active: null), NEVER a
// false positive/negative claim. These tests pin that behaviour plus the two
// real signal paths (Ubuntu Pro esm-infra, RHEL enabled EUS repo).

import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const readFileMock = vi.fn();
const readdirMock = vi.fn();

vi.mock("../../lib/exec.js", () => ({
  run: (...args: unknown[]) => runMock(...args),
}));
vi.mock("fs", () => ({
  readFileSync: (...args: unknown[]) => readFileMock(...args),
  readdirSync: (...args: unknown[]) => readdirMock(...args),
}));

const { collectSupportStatus } = await import("../support-status.js");

// Helper: route readFileSync by path. os-release always returns `osId`;
// callers add repo-file contents via `repoFiles`.
function setup(opts: {
  osId?: string; // ID= value for /etc/os-release (undefined => throw)
  repoFiles?: Record<string, string>; // basename -> contents for /etc/yum.repos.d
  proOutput?: string | null; // stdout of `pro security-status --format json`
}) {
  readFileMock.mockImplementation((path: string) => {
    if (path === "/etc/os-release") {
      if (opts.osId === undefined) throw new Error("ENOENT");
      return `ID=${opts.osId}\n`;
    }
    if (path.startsWith("/etc/yum.repos.d/")) {
      const base = path.slice("/etc/yum.repos.d/".length);
      if (opts.repoFiles && base in opts.repoFiles) return opts.repoFiles[base];
      throw new Error("ENOENT");
    }
    throw new Error(`unexpected read: ${path}`);
  });
  readdirMock.mockImplementation((path: string) => {
    if (path === "/etc/yum.repos.d") {
      if (!opts.repoFiles) throw new Error("ENOENT");
      return Object.keys(opts.repoFiles);
    }
    throw new Error(`unexpected readdir: ${path}`);
  });
  runMock.mockResolvedValue(opts.proOutput ?? null);
}

beforeEach(() => {
  runMock.mockReset();
  readFileMock.mockReset();
  readdirMock.mockReset();
});

describe("collectSupportStatus", () => {
  it("returns null when /etc/os-release is unreadable", async () => {
    setup({ osId: undefined });
    expect(await collectSupportStatus()).toBeNull();
  });

  it("returns null for a distro with no supported mechanism (debian)", async () => {
    setup({ osId: "debian" });
    expect(await collectSupportStatus()).toBeNull();
  });

  // === Ubuntu Pro ===

  it("Ubuntu: esm-infra enabled => extended support active", async () => {
    setup({
      osId: "ubuntu",
      proOutput: JSON.stringify({
        summary: { ua: { attached: true, enabled_services: ["esm-infra", "esm-apps"] } },
      }),
    });
    const r = await collectSupportStatus();
    expect(r).toMatchObject({
      source: "ubuntu-pro",
      extended_support_active: true,
      attached: true,
      esm_infra: true,
      esm_apps: true,
    });
  });

  it("Ubuntu: not attached => extended support NOT active (proven false)", async () => {
    setup({
      osId: "ubuntu",
      proOutput: JSON.stringify({
        summary: { ua: { attached: false, enabled_services: [] } },
      }),
    });
    const r = await collectSupportStatus();
    expect(r?.extended_support_active).toBe(false);
    expect(r?.attached).toBe(false);
    expect(r?.esm_infra).toBe(false);
  });

  it("Ubuntu: pro not installed (run => null) => null", async () => {
    setup({ osId: "ubuntu", proOutput: null });
    expect(await collectSupportStatus()).toBeNull();
  });

  it("Ubuntu: unparseable JSON => null", async () => {
    setup({ osId: "ubuntu", proOutput: "not json" });
    expect(await collectSupportStatus()).toBeNull();
  });

  it("Ubuntu: unknown enrollment shape => extended support undetermined (null)", async () => {
    setup({ osId: "ubuntu", proOutput: JSON.stringify({ summary: {} }) });
    const r = await collectSupportStatus();
    expect(r?.source).toBe("ubuntu-pro");
    expect(r?.extended_support_active).toBeNull();
  });

  // === RHEL EUS ===

  it("RHEL: an enabled *-eus-* repo => extended support active", async () => {
    setup({
      osId: "rocky",
      repoFiles: {
        "rocky-eus.repo": "[rocky-9-eus-baseos]\nbaseurl=https://example/eus\nenabled = 1\n",
      },
    });
    const r = await collectSupportStatus();
    expect(r).toMatchObject({ source: "rhel-eus-repos", extended_support_active: true, eus: true });
  });

  it("RHEL: repos present but none EUS => extended support false", async () => {
    setup({
      osId: "almalinux",
      repoFiles: {
        "almalinux.repo": "[baseos]\nbaseurl=https://example/baseos\nenabled=1\n",
      },
    });
    const r = await collectSupportStatus();
    expect(r?.extended_support_active).toBe(false);
    expect(r?.eus).toBe(false);
  });

  it("RHEL: an EUS section that is DISABLED does not count", async () => {
    setup({
      osId: "rhel",
      repoFiles: {
        "redhat.repo": "[rhel-9-eus-baseos]\nbaseurl=https://example/eus\nenabled=0\n[baseos]\nenabled=1\n",
      },
    });
    const r = await collectSupportStatus();
    expect(r?.extended_support_active).toBe(false);
  });

  it("RHEL: /etc/yum.repos.d unreadable => null (undetermined)", async () => {
    setup({ osId: "rocky" }); // no repoFiles => readdir throws
    expect(await collectSupportStatus()).toBeNull();
  });
});
