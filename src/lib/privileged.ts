// Privileged-collection facade (security audit §2.1).
//
// Crucible historically ran as root so every collector could invoke
// ipmitool / smartctl / zpool / dmesg / etc. directly. That makes the whole
// collection runtime a root-blast-radius surface (catalog T-201/T-202/T-208).
//
// This module is the boundary that lets the agent run as an unprivileged
// `glassmkr` service user instead: it gains hardware/kernel read access ONLY
// by invoking a single root-owned wrapper via `sudo -n`. The wrapper
// (`/usr/local/sbin/crucible-collect`) dispatches a FIXED action name to a
// hard-coded argv - there is no argument passthrough, so it is not the
// "sudo <binary> $@" anti-pattern. The only variable inputs (a SMART device
// path and an ethtool interface name) are validated against strict allowlists
// in the wrapper before exec.
//
// A single dispatcher (rather than one script per binary) is deliberate: it
// is one small file to audit and one sudoers line, and every privileged
// command is visible in one `case` statement. The wrapper is installed
// root:root 0755 (not writable by `glassmkr`) so the sudo grant cannot be
// hijacked by tampering with the script.

import { run } from "./exec.js";
import { existsSync } from "fs";

export const SERVICE_USER = "glassmkr";
export const WRAPPER_PATH = "/usr/local/sbin/crucible-collect";
export const SUDOERS_PATH = "/etc/sudoers.d/glassmkr-crucible";

// The fixed action set. Each maps to a hard-coded argv in the wrapper.
// `smart` takes a device path; `ethtool` takes an interface name; both are
// validated. Everything else takes no argument.
export type PrivilegedAction =
  | "ipmi-sensor" | "ipmi-sel-info" | "ipmi-sel-elist" | "ipmi-fan"
  | "smart" | "zpool"
  | "raid-perccli" | "raid-storcli" | "raid-ssacli" | "raid-arcconf"
  | "dmesg-errcrit" | "dmesg-io"
  | "iptables" | "nft" | "ufw" | "firewall-cmd" | "pve-firewall"
  | "sshd" | "lvs" | "ethtool" | "last";

/** SMART device paths the wrapper accepts. Mirrors the sh `valid_device`
 *  case in WRAPPER_SCRIPT; kept in TS so it is unit-testable. Blocks path
 *  traversal / arbitrary-file reads via `smartctl -a <path>`. */
export function isAllowedSmartDevice(dev: string): boolean {
  return /^\/dev\/(sd[a-z]+|hd[a-z]+|nvme\d+(n\d+)?|bus\/\d+)$/.test(dev);
}

/** ethtool interface names the wrapper accepts. Linux ifnames are <=15
 *  chars from a restricted set; no slashes/spaces so no arg injection. */
export function isAllowedIface(name: string): boolean {
  return name.length > 0 && name.length <= 15 && /^[A-Za-z0-9._:-]+$/.test(name);
}

/**
 * The real command each action maps to, mirroring WRAPPER_SCRIPT's `case`
 * statement below. Used only for the root fallback in runPrivileged; the
 * parameterized actions re-validate their argument so the fallback is as
 * constrained as the wrapper. Returns null for an action we won't run
 * directly (unknown, or a rejected smart/ethtool argument).
 */
function directCommand(action: PrivilegedAction, args: string[]): { cmd: string; args: string[] } | null {
  switch (action) {
    case "ipmi-sensor": return { cmd: "ipmitool", args: ["sensor"] };
    case "ipmi-sel-info": return { cmd: "ipmitool", args: ["sel", "info"] };
    case "ipmi-sel-elist": return { cmd: "ipmitool", args: ["sel", "elist"] };
    case "ipmi-fan": return { cmd: "ipmitool", args: ["sdr", "type", "Fan"] };
    case "smart": return isAllowedSmartDevice(args[0] ?? "") ? { cmd: "smartctl", args: ["--json", "--all", args[0]] } : null;
    case "zpool": return { cmd: "zpool", args: ["status"] };
    case "raid-perccli": return { cmd: "perccli", args: ["/c0", "show", "all", "J"] };
    case "raid-storcli": return { cmd: "storcli", args: ["/call", "show", "all", "J"] };
    case "raid-ssacli": return { cmd: "ssacli", args: ["ctrl", "all", "show", "status"] };
    case "raid-arcconf": return { cmd: "arcconf", args: ["list"] };
    case "dmesg-errcrit": return { cmd: "dmesg", args: ["--level=err,crit", "--since", "5 min ago"] };
    case "dmesg-io": return { cmd: "sh", args: ["-c", 'dmesg -T --since "10 minutes ago" 2>/dev/null | grep -i "I/O error\\|Buffer I/O error\\|blk_update_request.*error"'] };
    case "iptables": return { cmd: "iptables", args: ["-L", "-n"] };
    case "nft": return { cmd: "nft", args: ["list", "ruleset"] };
    case "ufw": return { cmd: "ufw", args: ["status"] };
    case "firewall-cmd": return { cmd: "firewall-cmd", args: ["--state"] };
    case "pve-firewall": return { cmd: "pve-firewall", args: ["status"] };
    case "sshd": return { cmd: "sshd", args: ["-T"] };
    case "lvs": return { cmd: "lvs", args: ["--reportformat=json", "--options=lv_name,vg_name,lv_attr,data_percent,metadata_percent", "--units=b", "--noheadings"] };
    case "ethtool": return isAllowedIface(args[0] ?? "") ? { cmd: "ethtool", args: [args[0]] } : null;
    case "last": return { cmd: "last", args: ["-x", "-F"] };
    default: return null;
  }
}

/**
 * Invoke a privileged collection action. Preferred path is the fixed-argv
 * sudo wrapper (the unprivileged `glassmkr` service user escalates only
 * through it). Returns the command stdout, or null on any failure - callers
 * treat null as "capability unavailable", so a missing tool degrades
 * gracefully rather than crashing.
 *
 * Root fallback: if the wrapper is NOT installed (e.g. an upgrade via
 * `npm i -g` without re-running `init`, or a host still on User=root that
 * never migrated) AND we are running as root, run the underlying command
 * directly. As root that is exactly what the wrapper would exec, so it
 * restores collection instead of silently returning null for every
 * hardware/security probe. This honors init.ts's documented "User=root
 * never loses collection" invariant, which the wrapper-only path (audit
 * §2.1) had regressed on wrapper-less root hosts. A non-root agent without
 * the wrapper still gets null (it cannot and must not escalate).
 */
export function runPrivileged(
  action: PrivilegedAction,
  args: string[] = [],
  timeoutMs = 10000,
): Promise<string | null> {
  if (existsSync(WRAPPER_PATH)) {
    return run("sudo", ["-n", WRAPPER_PATH, action, ...args], timeoutMs);
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const direct = directCommand(action, args);
    if (direct) return run(direct.cmd, direct.args, timeoutMs);
  }
  return Promise.resolve(null);
}

// The wrapper script, written verbatim to WRAPPER_PATH by init. POSIX sh.
// Every case `exec`s a fixed command; the two parameterised cases validate
// their single argument first. Keep the `valid_device` / `valid_iface` cases
// in sync with the TS validators above.
export const WRAPPER_SCRIPT = `#!/bin/sh
# Glassmkr Crucible privileged-collection facade (audit §2.1).
# Installed root:root 0755. The sole sudo grant for the unprivileged
# 'glassmkr' service user. Fixed action -> fixed argv; no passthrough.
# Managed by glassmkr-crucible init; do not edit by hand.
set -eu

action="\${1:-}"
[ -n "$action" ] || { echo "crucible-collect: missing action" >&2; exit 64; }
shift 2>/dev/null || true

valid_device() {
  case "$1" in
    /dev/sd[a-z]|/dev/sd[a-z][a-z]|/dev/hd[a-z]|/dev/hd[a-z][a-z]) return 0 ;;
    /dev/nvme[0-9]*n[0-9]*|/dev/nvme[0-9]*) return 0 ;;
    /dev/bus/[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}
valid_iface() {
  case "$1" in
    "" | *[!A-Za-z0-9._:-]*) return 1 ;;
    *) [ "\${#1}" -le 15 ] ;;
  esac
}

case "$action" in
  ipmi-sensor)    exec ipmitool sensor ;;
  ipmi-sel-info)  exec ipmitool sel info ;;
  ipmi-sel-elist) exec ipmitool sel elist ;;
  ipmi-fan)       exec ipmitool sdr type Fan ;;
  smart)
    dev="\${1:-}"
    valid_device "$dev" || { echo "crucible-collect: rejected device: $dev" >&2; exit 65; }
    exec smartctl --json --all "$dev" ;;
  zpool)          exec zpool status ;;
  raid-perccli)   exec perccli /c0 show all J ;;
  raid-storcli)   exec storcli /call show all J ;;
  raid-ssacli)    exec ssacli ctrl all show status ;;
  raid-arcconf)   exec arcconf list ;;
  dmesg-errcrit)  exec dmesg --level=err,crit --since "5 min ago" ;;
  dmesg-io)       exec sh -c 'dmesg -T --since "10 minutes ago" 2>/dev/null | grep -i "I/O error\\\\|Buffer I/O error\\\\|blk_update_request.*error"' ;;
  iptables)       exec iptables -L -n ;;
  nft)            exec nft list ruleset ;;
  ufw)            exec ufw status ;;
  firewall-cmd)   exec firewall-cmd --state ;;
  pve-firewall)   exec pve-firewall status ;;
  sshd)           exec sshd -T ;;
  lvs)            exec lvs --reportformat=json --options=lv_name,vg_name,lv_attr,data_percent,metadata_percent --units=b --noheadings ;;
  ethtool)
    ifc="\${1:-}"
    valid_iface "$ifc" || { echo "crucible-collect: rejected iface: $ifc" >&2; exit 65; }
    exec ethtool "$ifc" ;;
  last)           exec last -x -F ;;
  *) echo "crucible-collect: unknown action: $action" >&2; exit 64 ;;
esac
`;

// The sudoers drop-in. Grants the service user NOPASSWD on the single
// wrapper only, with env_reset + a fixed secure_path. No wildcards. Written
// 0440 root:root and validated with `visudo -cf` before install.
export const SUDOERS_CONTENT = `# Glassmkr Crucible (audit §2.1). Managed by glassmkr-crucible init.
# The service user may run ONLY the fixed-argv collection facade as root.
Defaults!${WRAPPER_PATH} env_reset
Defaults!${WRAPPER_PATH} secure_path="/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
${SERVICE_USER} ALL=(root) NOPASSWD: ${WRAPPER_PATH}
`;
