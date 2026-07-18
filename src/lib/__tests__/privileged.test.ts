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
  const files = new Map<string, { data: string; mode: number; uid?: number; gid?: number; symlink?: boolean }>();
  files.set("/etc/glassmkr/crucible.yaml", { data: "config", mode: 0o600, uid: 0, gid: 0 });
  const warns: string[] = [];
  const deps: InitDeps = {
    fs: {
      existsSync: (p) => files.has(p),
      mkdirSync: () => {},
      writeFileSync: (p, data, o) => { files.set(p, { data, mode: o?.mode ?? 0o644, uid: 0, gid: 0 }); },
      writeSecureFileSync: (p, data, mode) => { files.set(p, { data, mode, uid: 0, gid: 0 }); },
      chmodSync: (p, mode) => { const f = files.get(p); if (f) f.mode = mode; },
      chownSync: (p, uid, gid) => { const f = files.get(p); if (!f) throw new Error(`ENOENT: ${p}`); f.uid = uid; f.gid = gid; },
      lstatSync: (p) => {
        const f = files.get(p);
        // Untracked path (e.g. the wrapper's parent dir): a normal root-owned 0755 dir.
        if (!f) return { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o755 };
        return { isSymbolicLink: !!f.symlink, uid: f.uid ?? 0, gid: f.gid ?? 0, mode: f.mode };
      },
      realpathSync: (p) => p,
      renameSync: (from, to) => {
        const f = files.get(from); if (!f) throw new Error(`ENOENT: ${from}`);
        files.set(to, f); files.delete(from);
      },
      unlinkSync: (p) => { files.delete(p); },
    },
    exec: execImpl,
    hostname: () => "h", log: () => {}, warn: (m) => warns.push(m), error: () => {},
    fetch: async () => ({ status: 200 }), readStdin: async () => "",
  };
  return { deps, files, warns };
}

// A fresh box: `id -u glassmkr` fails (user absent) so useradd runs; `id -G`
// then succeeds (service user is in the root group only); everything else ok.
const okExec: ExecImpl = (cmd, args) =>
  cmd === "id" && args[0] === "-G" ? { stdout: "0", status: 0 } :
  cmd === "id" ? { stdout: "", status: 1 } :
  { stdout: "", status: 0 };

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

  // Codex re-review 2026-07-18: the wrapper's parent directory is part of the
  // trust boundary. A root-owned wrapper is still swappable if its DIR is
  // writable by the service user (Debian /usr/local/sbin is 2775 root:staff).
  type Stat = { isSymbolicLink: boolean; uid: number; gid: number; mode: number };
  const setDirStat = (deps: InitDeps, dir: Stat) => {
    const original = deps.fs.lstatSync;
    (deps.fs as { lstatSync: (p: string) => Stat }).lstatSync = (p) =>
      p === WRAPPER_PATH
        ? { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o755 } // the wrapper file: fine
        : ["/usr/local/sbin", "/usr/local", "/usr", "/"].includes(p)
          ? dir
          : original(p);
  };

  it("stays on User=root when the wrapper directory is world-writable", () => {
    const { deps } = mockDeps(okExec);
    setDirStat(deps, { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o777 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });

  it("stays on User=root when the dir is group-writable by a group the service user is in", () => {
    const { deps } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 50\n", status: 0 } : // service user in gid 50
      cmd === "id" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    setDirStat(deps, { isSymbolicLink: false, uid: 0, gid: 50, mode: 0o2775 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });

  it("proceeds when the dir is group-writable but the service user is NOT in that group (Debian default)", () => {
    const { deps, files } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 4\n", status: 0 } : // user in 0,4 - not 50 (staff)
      cmd === "id" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    setDirStat(deps, { isSymbolicLink: false, uid: 0, gid: 50, mode: 0o2775 }); // /usr/local/sbin 2775 root:staff
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(true);
    expect(files.get(WRAPPER_PATH)?.uid).toBe(0);
  });

  it("also checks the grandparent directory (/usr/local)", () => {
    const { deps } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 50\n", status: 0 } :
      cmd === "id" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    // /usr/local/sbin is safe, but its parent /usr/local is group-writable by
    // a group the service user is in (a writable grandparent lets the dir be
    // replaced wholesale).
    const original = deps.fs.lstatSync;
    (deps.fs as { lstatSync: (p: string) => Stat }).lstatSync = (p) =>
      p === "/usr/local"
        ? { isSymbolicLink: false, uid: 0, gid: 50, mode: 0o2775 }
        : ["/usr/local/sbin", "/usr", "/"].includes(p)
          ? { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o755 }
          : original(p);
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });

  it("checks every ancestor up to the filesystem root", () => {
    const { deps } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 50\n", status: 0 } :
      cmd === "id" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    const original = deps.fs.lstatSync;
    (deps.fs as { lstatSync: (p: string) => Stat }).lstatSync = (p) =>
      p === "/usr"
        ? { isSymbolicLink: false, uid: 0, gid: 50, mode: 0o2775 }
        : ["/usr/local/sbin", "/usr/local", "/"].includes(p)
          ? { isSymbolicLink: false, uid: 0, gid: 0, mode: 0o755 }
          : original(p);
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });

  it("rejects named ACL entries that grant the service user write access", () => {
    const { deps } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 4\n", status: 0 } :
      cmd === "id" ? { stdout: "", status: 1 } :
      cmd === "getfacl" && args[1] === "/usr/local/sbin"
        ? { stdout: "user::rwx\nuser:1000:rwx\ngroup::r-x\nother::r-x\n", status: 0 }
        : { stdout: "", status: 0 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });

  it("checks the dir against POST-usermod groups (adm-owned writable dir caught)", () => {
    // usermod adds glassmkr to adm (gid 4); the dir is group-writable by adm.
    // The check runs after the group add, so id -G reflects adm and it is caught.
    const { deps } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 4\n", status: 0 } :
      cmd === "id" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    setDirStat(deps, { isSymbolicLink: false, uid: 0, gid: 4, mode: 0o2775 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
  });

  it("revokes an existing sudoers grant + wrapper when it falls back to root (upgrade path)", () => {
    const { deps, files } = mockDeps((cmd, args) =>
      cmd === "id" && args[0] === "-G" ? { stdout: "0 50\n", status: 0 } :
      cmd === "id" ? { stdout: "", status: 1 } :
      { stdout: "", status: 0 });
    // A prior (0.14.2) install already installed the grant + wrapper.
    files.set(SUDOERS_PATH, { data: "stale grant", mode: 0o440, uid: 0, gid: 0 });
    files.set(WRAPPER_PATH, { data: "#!/bin/sh\n", mode: 0o755, uid: 0, gid: 0 });
    // The wrapper dir is now unsafe (service user is in its owning group 50).
    setDirStat(deps, { isSymbolicLink: false, uid: 0, gid: 50, mode: 0o2775 });
    expect(setupPrivilegeSeparation(deps, "/etc/glassmkr/crucible.yaml")).toBe(false);
    // Escalation path closed: both the grant and the wrapper are removed.
    expect(files.has(SUDOERS_PATH)).toBe(false);
    expect(files.has(WRAPPER_PATH)).toBe(false);
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
