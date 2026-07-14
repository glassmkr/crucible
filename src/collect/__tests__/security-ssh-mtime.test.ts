// F2-sec: newestSshdConfigMtime must read the sshd_config.d drop-ins through
// the privileged wrapper when a direct readdir fails with EACCES. On RHEL the
// drop-in dir is 0700 root, so an unprivileged (User=glassmkr) agent gets
// EACCES and would otherwise be blind to drop-in edits, leaving the
// ssh_config_unapplied signal wrong. A missing dir (ENOENT) must NOT trigger
// the wrapper, and a world-readable dir (root/Debian) must use the direct path.
import { describe, it, expect, vi, beforeEach } from "vitest";

const statSyncMock = vi.fn();
const readdirSyncMock = vi.fn();

vi.mock("fs", () => ({
  existsSync: () => false,
  readFileSync: () => "",
  readdirSync: (...a: unknown[]) => readdirSyncMock(...a),
  statSync: (...a: unknown[]) => statSyncMock(...a),
}));

const { newestSshdConfigMtime } = await import("../security.js");

const SSHD_CONFIG = "/etc/ssh/sshd_config";
const DROPIN = "/etc/ssh/sshd_config.d";
const err = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  statSyncMock.mockReset();
  readdirSyncMock.mockReset();
});

describe("newestSshdConfigMtime privileged fallback (RHEL 0700 drop-in dir)", () => {
  it("falls back to the privileged reader when the direct readdir throws EACCES", async () => {
    statSyncMock.mockImplementation((p: string) => {
      if (p === SSHD_CONFIG) return { mtimeMs: 1_000_000 }; // 1000s
      throw err("ENOENT");
    });
    readdirSyncMock.mockImplementation(() => { throw err("EACCES"); });
    const reader = vi.fn(async () => "2000"); // a drop-in edited at epoch 2000
    const secs = await newestSshdConfigMtime(reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(secs).toBe(2000); // newest of sshd_config(1000) and the wrapper(2000)
  });

  it("does NOT invoke the privileged reader when the drop-in dir is simply absent (ENOENT)", async () => {
    statSyncMock.mockImplementation((p: string) => {
      if (p === SSHD_CONFIG) return { mtimeMs: 1_500_000 }; // 1500s
      throw err("ENOENT");
    });
    readdirSyncMock.mockImplementation(() => { throw err("ENOENT"); });
    const reader = vi.fn(async () => "9999");
    const secs = await newestSshdConfigMtime(reader);
    expect(reader).not.toHaveBeenCalled();
    expect(secs).toBe(1500); // just sshd_config's mtime, no wrapper call
  });

  it("uses the direct readdir (never the wrapper) when the dir is readable (root/Debian)", async () => {
    statSyncMock.mockImplementation((p: string) => {
      if (p === SSHD_CONFIG) return { mtimeMs: 1_000_000 };            // 1000s
      if (p === `${DROPIN}/50-cloud-init.conf`) return { mtimeMs: 3_000_000 }; // 3000s
      throw err("ENOENT");
    });
    readdirSyncMock.mockReturnValue(["50-cloud-init.conf", "README"]);
    const reader = vi.fn(async () => "9999");
    const secs = await newestSshdConfigMtime(reader);
    expect(reader).not.toHaveBeenCalled();
    expect(secs).toBe(3000); // newest drop-in read directly
  });
});
