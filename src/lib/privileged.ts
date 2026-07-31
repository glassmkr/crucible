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

import { run, runDetailed, type RunDetailedResult } from "./exec.js";
import { resolveIpmitoolPath } from "./ipmitool-provenance.js";
import { existsSync } from "fs";

export const SERVICE_USER = "glassmkr";
export const WRAPPER_PATH = "/usr/local/sbin/crucible-collect";
export const SUDOERS_PATH = "/etc/sudoers.d/glassmkr-crucible";

type DetailedRunner = (
  cmd: string,
  args: string[],
  timeoutMs?: number,
) => Promise<RunDetailedResult>;

/**
 * Prove that the running agent can cross the narrow sudo boundary. The fixed
 * ssh-config-mtime action is available on every supported host and returns a
 * numeric value even when no SSH config exists. Calling this from index.ts
 * makes the result authoritative for the real persistent unit and sandbox.
 */
export async function checkPrivilegedWrapper(
  execute: DetailedRunner = runDetailed,
  wrapperExists: (path: string) => boolean = existsSync,
): Promise<boolean> {
  if (!wrapperExists(WRAPPER_PATH)) return false;
  const result = await execute("sudo", ["-n", WRAPPER_PATH, "ssh-config-mtime"], 10_000);
  return result.installed
    && result.exitCode === 0
    && /^\d+\s*$/.test(result.stdout ?? "");
}

// The fixed action set. Each maps to a hard-coded argv in the wrapper.
// `smart` takes a device path; `ethtool` takes an interface name; both are
// validated. Everything else takes no argument.
export type PrivilegedAction =
  | "ipmi-sensor" | "ipmi-sel-info" | "ipmi-sel-elist" | "ipmi-fan"
  | "smart" | "smart-scan" | "zpool"
  | "raid-perccli" | "raid-storcli" | "raid-ssacli" | "raid-arcconf"
  | "dmesg-errcrit" | "dmesg-io"
  | "iptables" | "nft" | "ufw" | "firewall-cmd" | "pve-firewall"
  | "sshd" | "lvs" | "ethtool" | "last" | "dmidecode-memory" | "proc-fd"
  | "ssh-config-mtime";

// proc-fd scan (added 0.13.20). Runs the per-process FD count + RLIMIT read as
// root so the unprivileged `glassmkr` service user can see root-owned processes
// (a root daemon leaking descriptors was previously invisible: readdir on
// /proc/<root-pid>/fd returns EACCES to a non-root uid). No args, no shell
// metacharacters from outside; a fixed scan. Two cheap passes over /proc, then
// limits for the top 50. Emits `SCANNED <n>` then `pid|fd_count|soft hard|comm`
// lines. `$(cat comm)` strips its own trailing newline, so no \n handling. The
// if/then guards keep it safe under the wrapper's `set -eu`.
const PROC_FD_SH = `c=0
for d in /proc/[0-9]*; do if [ -r "$d/fd" ]; then c=$((c+1)); fi; done
echo "SCANNED $c"
for d in /proc/[0-9]*; do [ -r "$d/fd" ] || continue; p=$(basename "$d"); n=$(ls "$d/fd" 2>/dev/null | wc -l); echo "$n $p"; done | sort -rn | head -50 | while read n p; do comm=$(cat /proc/$p/comm 2>/dev/null); lim=$(awk '/^Max open files/{print $4" "$5}' /proc/$p/limits 2>/dev/null); if [ -n "$comm" ]; then echo "$p|$n|$lim|$comm"; fi; done`;

// ssh-config-mtime scan (added for the RHEL drop-in visibility fix). Prints the
// newest mtime (epoch seconds) among /etc/ssh/sshd_config and its *.conf
// drop-ins, so the unprivileged `glassmkr` service user can still tell whether
// an sshd edit is staged-but-unapplied even when /etc/ssh/sshd_config.d is
// 0700 root (RHEL default), where a direct readdir returns EACCES. Strictly
// read-only + fixed-path: it only ever stats those two locations, never reads
// contents and never writes. `stat -c %Y` is Linux/coreutils (the wrapper only
// ever runs on Linux hosts). if/then guards keep it safe under `set -eu`; a
// non-matching glob stays literal and is skipped by the `[ -e ]` test.
const SSH_CONFIG_MTIME_SH = `newest=0
m=$(stat -c %Y /etc/ssh/sshd_config 2>/dev/null || echo 0)
if [ "$m" -gt "$newest" ]; then newest=$m; fi
for f in /etc/ssh/sshd_config.d/*.conf; do
  if [ -e "$f" ]; then
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    if [ "$m" -gt "$newest" ]; then newest=$m; fi
  fi
done
echo "$newest"`;

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

/** smartctl `-d TYPE` passthrough selectors the wrapper accepts, for reading
 *  physical drives behind a hardware RAID/HBA controller (e.g.
 *  `sat+megaraid,8`). Mirrors the sh `valid_smart_type` case. The selector is
 *  derived from `smartctl --scan-open` output, but is validated here anyway as
 *  the last gate before a root exec. Restricted to a known controller-family
 *  prefix plus a comma-separated numeric tuple; no other chars, so nothing can
 *  inject an extra smartctl flag or a path. */
export function isAllowedSmartType(type: string): boolean {
  // Canonical grammar: an optional `sat+` prefix, a known controller family, a
  // comma, and a SINGLE numeric id. Deliberately narrow so the sh mirror
  // (valid_smart_type) can be provably identical - a divergence between the two
  // gates would either leak a broader value to the root smartctl exec or
  // silently reject a real scan selector. This covers MegaRAID (our hardware)
  // and the single-id form of the other families. Multi-field selectors
  // (aacraid H,L,ID; areca N/E) are intentionally unsupported until we have
  // that hardware + a tested tuple grammar on both sides.
  return /^(sat\+)?(megaraid|cciss|3ware|aacraid|areca|marvell),\d+$/.test(type);
}

/**
 * The real command each action maps to, mirroring WRAPPER_SCRIPT's `case`
 * statement below. Used only for the root fallback in runPrivileged; the
 * parameterized actions re-validate their argument so the fallback is as
 * constrained as the wrapper. Returns null for an action we won't run
 * directly (unknown, or a rejected smart/ethtool argument).
 */
export function directCommand(action: PrivilegedAction, args: string[]): { cmd: string; args: string[] } | null {
  // ipmitool is invoked by ABSOLUTE PATH here, resolved the same way the CVE gate
  // resolves it. On a root-direct host (no wrapper) this fallback used to exec a
  // bare "ipmitool" through root's ambient PATH, while the gate validated the first
  // match in SECURE_PATH_DIRS. With, say, PATH=/opt/vendor/bin:/usr/bin and a
  // vulnerable /opt/vendor/bin/ipmitool, the gate approved /usr/bin/ipmitool and
  // this ran the vendor one as root: the check and the execution naming different
  // files, which is the same defect as the previous round's version-probe hole, on
  // the other execution path. Adversarial review round 4, finding #1.
  //
  // The wrapper path needs no equivalent change: it execs under sudo, whose
  // secure_path is exactly the list SECURE_PATH_DIRS mirrors.
  //
  // Falling back to the bare name when nothing is found keeps behaviour unchanged on
  // a host with no ipmitool in those directories, where the exec fails either way.
  const ipmitool = resolveIpmitoolPath() ?? "ipmitool";
  switch (action) {
    case "ipmi-sensor": return { cmd: ipmitool, args: ["sensor"] };
    case "ipmi-sel-info": return { cmd: ipmitool, args: ["sel", "info"] };
    case "ipmi-sel-elist": return { cmd: ipmitool, args: ["sel", "elist"] };
    case "ipmi-fan": return { cmd: ipmitool, args: ["sdr", "type", "Fan"] };
    case "smart-scan": return { cmd: "smartctl", args: ["--scan-open"] };
    case "smart": {
      const dev = args[0] ?? "";
      if (!isAllowedSmartDevice(dev)) return null;
      const type = args[1];
      if (type != null && type !== "") {
        return isAllowedSmartType(type)
          ? { cmd: "smartctl", args: ["--json", "--all", "-d", type, dev] }
          : null;
      }
      return { cmd: "smartctl", args: ["--json", "--all", dev] };
    }
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
    case "dmidecode-memory": return { cmd: "dmidecode", args: ["-t", "17"] };
    case "proc-fd": return { cmd: "sh", args: ["-c", PROC_FD_SH] };
    case "ssh-config-mtime": return { cmd: "sh", args: ["-c", SSH_CONFIG_MTIME_SH] };
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
 * Root compatibility: a legacy root unit, or an operator who explicitly
 * accepted GLASSMKR_ALLOW_ROOT_FALLBACK during init, can run the same fixed
 * commands directly when the wrapper is absent. The default unit is
 * unprivileged, so wrapper failure returns null and cannot silently escalate.
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
  # Mirror the anchored TS isAllowedSmartDevice. POSIX 'case' patterns treat
  # the operand as a plain string, so a trailing '*' matches '/' too; that let
  # /dev/nvme0/../../etc/shadow and /dev/bus/0/../../etc/passwd slip through the
  # old '/dev/nvme[0-9]*' / '/dev/bus/[0-9]*' arms. Reject any '..' outright,
  # then constrain the variable tail of each arm to the allowed characters
  # (digits, and a single 'n' for nvme) so no post-stem '/' survives.
  case "$1" in *..*) return 1 ;; esac
  case "$1" in
    /dev/sd[a-z]|/dev/sd[a-z][a-z]|/dev/hd[a-z]|/dev/hd[a-z][a-z]) return 0 ;;
    /dev/nvme[0-9]*n[0-9]*|/dev/nvme[0-9]*)
      case "\${1#/dev/nvme}" in *[!0-9n]*) return 1 ;; *) return 0 ;; esac ;;
    /dev/bus/[0-9]*)
      case "\${1#/dev/bus/}" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac ;;
    *) return 1 ;;
  esac
}
valid_iface() {
  case "$1" in
    "" | *[!A-Za-z0-9._:-]*) return 1 ;;
    *) [ "\${#1}" -le 15 ] ;;
  esac
}
valid_smart_type() {
  # Provably identical to the TS isAllowedSmartType regex
  # ^(sat\\+)?(family),[0-9]+$ . Decompose rather than glob-match so the two
  # gates cannot drift: strip an optional 'sat+' prefix, split on the single
  # comma, check the family against the allowlist, and require the id to be
  # non-empty all-digits. A single numeric id only - no multi-field tuples, no
  # slashes, no extra separators - so nothing broader than the declared grammar
  # can reach the root smartctl exec.
  t="$1"
  case "$t" in sat+*) t="\${t#sat+}" ;; esac
  fam="\${t%%,*}"
  id="\${t#*,}"
  # Exactly one comma, and it is not at either end.
  [ "$fam,$id" = "$t" ] || return 1
  case "$fam" in
    megaraid|cciss|3ware|aacraid|areca|marvell) ;;
    *) return 1 ;;
  esac
  case "$id" in "" | *[!0-9]*) return 1 ;; esac
  return 0
}

case "$action" in
  ipmi-sensor)    exec ipmitool sensor ;;
  ipmi-sel-info)  exec ipmitool sel info ;;
  ipmi-sel-elist) exec ipmitool sel elist ;;
  ipmi-fan)       exec ipmitool sdr type Fan ;;
  smart-scan)     exec smartctl --scan-open ;;
  smart)
    dev="\${1:-}"
    typ="\${2:-}"
    valid_device "$dev" || { echo "crucible-collect: rejected device: $dev" >&2; exit 65; }
    if [ -n "$typ" ]; then
      valid_smart_type "$typ" || { echo "crucible-collect: rejected smart type: $typ" >&2; exit 65; }
      exec smartctl --json --all -d "$typ" "$dev"
    fi
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
  dmidecode-memory) exec dmidecode -t 17 ;;
  lvs)            exec lvs --reportformat=json --options=lv_name,vg_name,lv_attr,data_percent,metadata_percent --units=b --noheadings ;;
  ethtool)
    ifc="\${1:-}"
    valid_iface "$ifc" || { echo "crucible-collect: rejected iface: $ifc" >&2; exit 65; }
    exec ethtool "$ifc" ;;
  last)           exec last -x -F ;;
  proc-fd)
${PROC_FD_SH}
    exit 0 ;;
  ssh-config-mtime)
${SSH_CONFIG_MTIME_SH}
    exit 0 ;;
  *) echo "crucible-collect: unknown action: $action" >&2; exit 64 ;;
esac
`;

// The sudoers drop-in. Grants the service user NOPASSWD on the single
// wrapper only, with env_reset + a fixed secure_path. No wildcards. Written
// 0440 root:root and validated with `visudo -cf` before install.
export const SUDOERS_CONTENT = `# Glassmkr Crucible (audit §2.1). Managed by glassmkr-crucible init.
# The service user may run ONLY the fixed-argv collection facade as root.
Defaults!${WRAPPER_PATH} env_reset
Defaults!${WRAPPER_PATH} secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${SERVICE_USER} ALL=(root) NOPASSWD: ${WRAPPER_PATH}
`;
