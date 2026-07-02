import { describe, it, expect } from "vitest";
import {
  isAllowedSmartDevice,
  isAllowedIface,
  WRAPPER_SCRIPT,
  SUDOERS_CONTENT,
  WRAPPER_PATH,
  SUDOERS_PATH,
  SERVICE_USER,
} from "../privileged.js";
import { setupPrivilegeSeparation, type InitDeps } from "../../init.js";

type ExecImpl = (cmd: string, args: string[]) => { stdout: string; status: number | null };

function mockDeps(execImpl: ExecImpl) {
  const files = new Map<string, { data: string; mode: number }>();
  const warns: string[] = [];
  const deps: InitDeps = {
    fs: {
      existsSync: (p) => files.has(p),
      mkdirSync: () => {},
      writeFileSync: (p, data, o) => { files.set(p, { data, mode: o?.mode ?? 0o644 }); },
      chmodSync: (p, mode) => { const f = files.get(p); if (f) f.mode = mode; },
      renameSync: (from, to) => {
        const f = files.get(from); if (!f) throw new Error(`ENOENT: ${from}`);
        files.set(to, f); files.delete(from);
      },
    },
    exec: execImpl,
    hostname: () => "h", log: () => {}, warn: (m) => warns.push(m), error: () => {},
    fetch: async () => ({ status: 200 }), readStdin: async () => "",
  };
  return { deps, files, warns };
}

// A fresh box: `id glassmkr` fails (user absent), everything else succeeds.
const okExec: ExecImpl = (cmd) => cmd === "id"
  ? { stdout: "", status: 1 }
  : { stdout: "", status: 0 };

describe("setupPrivilegeSeparation", () => {
  it("succeeds on a clean box: creates user, installs wrapper 0755 + sudoers 0440", () => {
    const { deps, files } = mockDeps(okExec);
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(true);
    expect(files.get(WRAPPER_PATH)?.mode).toBe(0o755);
    expect(files.get(SUDOERS_PATH)?.mode).toBe(0o440);
    expect(files.has(`${SUDOERS_PATH}.tmp`)).toBe(false); // renamed, not left behind
  });

  it("fail-safe: visudo rejection returns false and never installs the sudoers file", () => {
    const { deps, files } = mockDeps((cmd) =>
      cmd === "id" ? { stdout: "", status: 1 } :
      cmd === "visudo" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
    expect(files.has(SUDOERS_PATH)).toBe(false);
  });

  it("fail-safe: useradd failure returns false (caller keeps User=root)", () => {
    const { deps } = mockDeps((cmd) =>
      cmd === "id" ? { stdout: "", status: 1 } :
      cmd === "useradd" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });
});

describe("isAllowedSmartDevice", () => {
  it("accepts real block/nvme device nodes", () => {
    for (const d of ["/dev/sda", "/dev/sdb", "/dev/sdaa", "/dev/hda", "/dev/nvme0n1", "/dev/nvme12n3", "/dev/nvme0", "/dev/bus/0"]) {
      expect(isAllowedSmartDevice(d)).toBe(true);
    }
  });
  it("rejects traversal, injection, and non-device paths", () => {
    for (const d of ["/etc/shadow", "/dev/../etc/shadow", "/dev/sda; rm -rf /", "/dev/sda foo", "", "sda", "/dev/sda\n/dev/sdb", "/dev/mapper/x"]) {
      expect(isAllowedSmartDevice(d)).toBe(false);
    }
  });
});

describe("isAllowedIface", () => {
  it("accepts real interface names", () => {
    for (const i of ["eth0", "enp1s0", "eno1", "bond0", "bond0.100", "br-lan", "en_p0"]) {
      expect(isAllowedIface(i)).toBe(true);
    }
  });
  it("rejects empty, over-long, spaced, and injection-y names", () => {
    for (const i of ["", "a".repeat(16), "eth0 x", "eth0;rm", "../eth0", "eth0|cat", "$(id)"]) {
      expect(isAllowedIface(i)).toBe(false);
    }
  });
});

describe("WRAPPER_SCRIPT (the sudo facade)", () => {
  it("is POSIX sh with strict mode", () => {
    expect(WRAPPER_SCRIPT.startsWith("#!/bin/sh")).toBe(true);
    expect(WRAPPER_SCRIPT).toContain("set -eu");
  });
  it("has no argument passthrough sink ($@ / $* into a command)", () => {
    // The only $-expansions should be the validated $dev / $ifc / $action /
    // ${#1}. A bare exec of "$@" or "$*" would be a passthrough hole.
    expect(WRAPPER_SCRIPT).not.toMatch(/exec[^\n]*"\$@"/);
    expect(WRAPPER_SCRIPT).not.toMatch(/exec[^\n]*\$\*/);
  });
  it("validates the two parameterised actions before exec", () => {
    expect(WRAPPER_SCRIPT).toContain("valid_device");
    expect(WRAPPER_SCRIPT).toContain("valid_iface");
  });
  it("hard-codes the expected privileged commands", () => {
    expect(WRAPPER_SCRIPT).toContain("exec ipmitool sensor");
    expect(WRAPPER_SCRIPT).toContain("exec smartctl --json --all");
    expect(WRAPPER_SCRIPT).toContain("exec zpool status");
    expect(WRAPPER_SCRIPT).toContain("exec iptables -L -n");
  });
});

describe("SUDOERS_CONTENT", () => {
  it("grants only the wrapper, NOPASSWD, to the service user", () => {
    expect(SUDOERS_CONTENT).toContain(`${SERVICE_USER} ALL=(root) NOPASSWD: ${WRAPPER_PATH}`);
  });
  it("contains no wildcard and resets the environment", () => {
    expect(SUDOERS_CONTENT).not.toContain("*");
    expect(SUDOERS_CONTENT).toContain("env_reset");
    expect(SUDOERS_CONTENT).toContain("secure_path");
  });
});
