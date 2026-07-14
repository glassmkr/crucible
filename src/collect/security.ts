import { run } from "../lib/exec.js";
import { runPrivileged } from "../lib/privileged.js";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";

export interface SshSecurityStatus {
  permitRootLogin: string;
  passwordAuthentication: string;
  rootPasswordExposed: boolean;
  // False iff the on-disk sshd config is newer than the running daemon's
  // last config load, i.e. an edit is staged but not live. `sshd -T` (and
  // therefore every field above) reflects the FILE, not the running daemon,
  // so without this an operator who edits sshd_config to fix root login but
  // forgets to reload/restart clears the alert while the box stays exposed.
  // Defaults to true whenever we cannot positively prove otherwise, so a
  // missing signal never raises a false "unapplied" alarm.
  configApplied: boolean;
  // Evidence for the ssh_config_unapplied rule (epoch seconds). Null when
  // undeterminable. configLoadedAt is the last sshd start OR reload.
  configMtime?: number | null;
  configLoadedAt?: number | null;
}

export interface FirewallStatus {
  active: boolean;
  source: string;
  details: string;
}

export interface SecurityUpdateStatus {
  distro: string;
  pendingCount: number;
  available: boolean;
}

export interface VulnerabilityStatus {
  name: string;
  status: string;
  mitigated: boolean;
}

export interface KernelRebootStatus {
  running: string;
  installed: string;
  needsReboot: boolean;
}

export interface AutoUpdateStatus {
  configured: boolean;
  mechanism: string;
  details: string;
}

export interface SecurityData {
  ssh: SshSecurityStatus | null;
  firewall: FirewallStatus;
  pending_updates: SecurityUpdateStatus | null;
  kernel_vulns: VulnerabilityStatus[];
  kernel_reboot: KernelRebootStatus | null;
  auto_updates: AutoUpdateStatus;
}

// Cache TTL for the one expensive security check (pending_updates).
// `apt list --upgradable` and `dnf updateinfo list security` both hit
// package metadata and can take seconds; running every collection
// cycle (5 min) is wasteful. Every other check in collectSecurity is
// fast (sshd -T, /sys file reads, systemctl is-active) and should run
// every cycle so a customer's config change (ufw enable, sshd_config
// edit, dnf-automatic install) takes effect on the next snapshot
// rather than on the next hourly window. Pre-fix the entire
// SecurityData was cached for an hour; that masked legitimate
// customer fixes for up to 60 minutes after they applied them.
// Surfaced by `CLEANUP_REPORT_2026-05-13.md`.
const PENDING_UPDATES_TTL_MS = 60 * 60 * 1000;

interface PendingUpdatesCache {
  result: SecurityUpdateStatus | null;
  at: number;
}

let pendingUpdatesCache: PendingUpdatesCache | null = null;

export async function collectSecurity(): Promise<SecurityData> {
  const pendingUpdatesPromise: Promise<SecurityUpdateStatus | null> =
    pendingUpdatesCache !== null && (Date.now() - pendingUpdatesCache.at) < PENDING_UPDATES_TTL_MS
      ? Promise.resolve(pendingUpdatesCache.result)
      : checkSecurityUpdates().then((result) => {
          pendingUpdatesCache = { result, at: Date.now() };
          return result;
        });

  const [ssh, firewall, pendingUpdates, kernelVulns, kernelReboot, autoUpdates] = await Promise.all([
    checkSshConfig(),
    checkFirewall(),
    pendingUpdatesPromise,
    checkKernelVulnerabilities(),
    checkKernelReboot(),
    checkAutoUpdates(),
  ]);

  return { ssh, firewall, pending_updates: pendingUpdates, kernel_vulns: kernelVulns, kernel_reboot: kernelReboot, auto_updates: autoUpdates };
}

/**
 * Test-only: reset the pending_updates cache so tests can exercise
 * the cold-cache + warm-cache paths deterministically.
 */
export function __resetSecurityCacheForTests(): void {
  pendingUpdatesCache = null;
}

// === SSH ===

const SSHD_CONFIG_PATH = "/etc/ssh/sshd_config";
const SSHD_CONFIG_D = "/etc/ssh/sshd_config.d";

// Newest mtime (epoch seconds) among sshd_config and its *.conf drop-ins,
// or null if none is stat-able. mtime only needs directory traversal, not
// file read, so this works even when the config contents are root-only.
function newestSshdConfigMtime(): number | null {
  let newest: number | null = null;
  const consider = (p: string): void => {
    try {
      const secs = Math.floor(statSync(p).mtimeMs / 1000);
      if (newest === null || secs > newest) newest = secs;
    } catch {
      // missing / unreadable: skip
    }
  };
  consider(SSHD_CONFIG_PATH);
  try {
    for (const f of readdirSync(SSHD_CONFIG_D)) {
      if (f.endsWith(".conf")) consider(`${SSHD_CONFIG_D}/${f}`);
    }
  } catch {
    // no drop-in dir: fine
  }
  return newest;
}

// Boot time (epoch seconds) from /proc/stat `btime`, or null off-Linux.
function bootTimeEpoch(): number | null {
  try {
    const m = readFileSync("/proc/stat", "utf-8").match(/^btime\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// Has the running sshd loaded the on-disk config? Compares the newest
// sshd_config* mtime against the last time the sshd unit started OR
// reloaded. We use systemd's StateChangeTimestampMonotonic (microseconds
// since boot) because - unlike the process start time or
// ExecMainStartTimestamp - it advances on a SIGHUP `reload` too, so an
// operator who reloads (the path our own remediation recommends) rather
// than restarts is correctly seen as "applied". Monotonic-since-boot
// avoids wall-clock/timezone skew. Returns applied=true whenever the
// signal is undeterminable so a missing systemctl never false-alarms.
async function sshConfigApplyState(): Promise<{
  applied: boolean;
  configMtime: number | null;
  loadedAt: number | null;
}> {
  const configMtime = newestSshdConfigMtime();
  const btime = bootTimeEpoch();
  if (configMtime === null || btime === null) {
    return { applied: true, configMtime, loadedAt: null };
  }
  let monoUs: number | null = null;
  for (const unit of ["ssh", "sshd"]) {
    const out = await run(
      "systemctl",
      ["show", unit, "-p", "StateChangeTimestampMonotonic", "--value"],
      3000,
    );
    const n = out ? parseInt(out.trim(), 10) : NaN;
    if (Number.isFinite(n) && n > 0) {
      monoUs = n;
      break;
    }
  }
  if (monoUs === null) {
    return { applied: true, configMtime, loadedAt: null };
  }
  const loadedAt = btime + Math.floor(monoUs / 1_000_000); // epoch seconds
  // 2s tolerance covers same-second write-then-reload + rounding.
  return { applied: configMtime <= loadedAt + 2, configMtime, loadedAt };
}

async function checkSshConfig(): Promise<SshSecurityStatus | null> {
  const cfg = await sshConfigApplyState();
  const applyFields = {
    configApplied: cfg.applied,
    configMtime: cfg.configMtime,
    configLoadedAt: cfg.loadedAt,
  };

  // Prefer sshd -T (resolves includes and match blocks)
  const output = await runPrivileged("sshd", [], 5000);
  if (output) {
    const getVal = (key: string): string => {
      const line = output.split("\n").find((l) => l.startsWith(key + " "));
      return line ? line.split(" ")[1].trim() : "";
    };
    const permitRootLogin = getVal("permitrootlogin");
    const passwordAuth = getVal("passwordauthentication");
    const rootPasswordExposed = permitRootLogin === "yes" && passwordAuth !== "no";
    return { permitRootLogin, passwordAuthentication: passwordAuth, rootPasswordExposed, ...applyFields };
  }

  // Fallback: parse sshd_config directly
  try {
    const config = readFileSync(SSHD_CONFIG_PATH, "utf-8");
    const lines = config.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const find = (key: string): string | null => {
      const line = lines.find((l) => l.toLowerCase().startsWith(key.toLowerCase()));
      return line ? line.split(/\s+/)[1] : null;
    };
    const permitRootLogin = find("PermitRootLogin") || "prohibit-password";
    const passwordAuth = find("PasswordAuthentication") || "yes";
    const rootPasswordExposed = permitRootLogin.toLowerCase() === "yes" && passwordAuth.toLowerCase() !== "no";
    return { permitRootLogin, passwordAuthentication: passwordAuth, rootPasswordExposed, ...applyFields };
  } catch {
    return null;
  }
}

// === Firewall ===

async function checkFirewall(): Promise<FirewallStatus> {
  // UFW: if installed, its status is authoritative (ignores Docker iptables chains)
  const ufw = await runPrivileged("ufw", [], 5000);
  if (ufw && ufw.includes("Status:")) {
    const active = ufw.includes("Status: active");
    return { active, source: "ufw", details: active ? "UFW is active" : "UFW is inactive" };
  }

  // firewalld: if installed, its status is authoritative
  const fwd = await runPrivileged("firewall-cmd", [], 5000);
  if (fwd) {
    if (fwd.trim() === "running") {
      return { active: true, source: "firewalld", details: "firewalld is running" };
    }
    if (fwd.includes("not running") || fwd.includes("dead")) {
      return { active: false, source: "firewalld", details: "firewalld is not running" };
    }
  }

  // pve-firewall (Proxmox VE): if installed, its status is authoritative.
  // The service can be running while the firewall itself is disabled (the
  // "disabled/running" status). Treat disabled-firewall as inactive, even
  // when the systemd service is up; only "enabled/running" counts as
  // active. Added 2026-05-18 after a validation Proxmox host was found
  // with `no_firewall` muted as a workaround for missing detection.
  const pve = await runPrivileged("pve-firewall", [], 5000);
  if (pve) {
    // Status line shape: "Status: <state>/<systemd>" e.g.
    //   "Status: enabled/running"
    //   "Status: disabled/running"
    //   "Status: enabled/stopped"
    const m = pve.match(/Status:\s*(\w+)\/(\w+)/);
    if (m) {
      const [, fwState, svcState] = m;
      const active = fwState === "enabled" && svcState === "running";
      return {
        active,
        source: "pve-firewall",
        details: `pve-firewall is ${fwState}/${svcState}`,
      };
    }
  }

  // nftables (only if no managed firewall found)
  const nft = await runPrivileged("nft", [], 5000);
  if (nft) {
    const ruleLines = nft.split("\n").filter((l) => l.trim().match(/^\s*(meta|ip |ip6 |tcp |udp |ct |drop|reject|accept)/));
    if (ruleLines.length > 0) {
      return { active: true, source: "nftables", details: `${ruleLines.length} nftables rules` };
    }
  }

  // iptables fallback: filter out Docker/container chains to avoid false positives
  const ipt = await runPrivileged("iptables", [], 5000);
  if (ipt) {
    const lines = ipt.split("\n").filter((l) =>
      l.trim() &&
      !l.startsWith("Chain ") &&
      !l.startsWith("target ") &&
      !l.includes("DOCKER") &&
      !l.includes("docker") &&
      !l.includes("br-") &&
      !l.includes("f2b-")
    );
    if (lines.length > 0) return { active: true, source: "iptables", details: `${lines.length} user iptables rules` };
    if (ipt.includes("policy DROP") || ipt.includes("policy REJECT")) {
      return { active: true, source: "iptables", details: "Default policy is DROP/REJECT" };
    }
  }

  return { active: false, source: "none", details: "No firewall detected (checked ufw, firewalld, nftables, iptables)" };
}

// === Pending Security Updates ===

async function checkSecurityUpdates(): Promise<SecurityUpdateStatus | null> {
  let osRelease = "";
  try { osRelease = readFileSync("/etc/os-release", "utf-8").toLowerCase(); } catch { return null; }

  if (osRelease.includes("debian") || osRelease.includes("ubuntu") || osRelease.includes("mint")) {
    const output = await run("bash", ["-c", 'apt list --upgradable 2>/dev/null | grep -i "security" | wc -l'], 30000);
    if (output) {
      const count = parseInt(output.trim()) || 0;
      return { distro: osRelease.includes("ubuntu") ? "ubuntu" : "debian", pendingCount: count, available: true };
    }
    return { distro: "debian", pendingCount: 0, available: false };
  }

  if (osRelease.includes("rhel") || osRelease.includes("rocky") || osRelease.includes("alma") || osRelease.includes("fedora") || osRelease.includes("centos")) {
    const cmd = existsSync("/usr/bin/dnf") ? "dnf" : "yum";
    // Count only INSTALLABLE security updates. `updateinfo list security
    // --available` also lists advisories for installonly kernels that are
    // already on disk (installed but not yet booted), which inflates the
    // count and points remediation at a no-op. (val campaign agentic-12,
    // Rocky 10: it reported 8 "pending" that were all the installed-but-
    // unbooted 211.28/211.32 kernels; the truly installable security count
    // was 0, and the real fix is the reboot kernel_needs_reboot already
    // flags, not `dnf update --security`.) `check-update --security` lists
    // only packages with an installable newer NVRA (name.arch  version  repo,
    // three whitespace fields); the informational "Security: ... is an
    // installed/running version" lines have more fields and are excluded by
    // the anchored 3-field match. `|| true` keeps a zero count (grep exit 1)
    // from being read as a command failure.
    const output = await run("bash", ["-c", `${cmd} -q check-update --security 2>/dev/null | grep -cE '^[[:alnum:]][^[:space:]]*[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$' || true`], 60000);
    if (output) {
      const count = parseInt(output.trim()) || 0;
      const distro = osRelease.includes("rocky") ? "rocky" : osRelease.includes("alma") ? "alma" : osRelease.includes("fedora") ? "fedora" : "rhel";
      return { distro, pendingCount: count, available: true };
    }
    return { distro: "rhel", pendingCount: 0, available: false };
  }

  return null;
}

// === Kernel Vulnerabilities ===

function checkKernelVulnerabilities(): VulnerabilityStatus[] {
  const vulnDir = "/sys/devices/system/cpu/vulnerabilities";
  if (!existsSync(vulnDir)) return [];

  try {
    const files = readdirSync(vulnDir);
    return files.map((file) => {
      try {
        const status = readFileSync(`${vulnDir}/${file}`, "utf-8").trim();
        const mitigated = status.includes("Not affected") || status.includes("Mitigation:");
        return { name: file, status, mitigated };
      } catch {
        return { name: file, status: "unknown", mitigated: true };
      }
    });
  } catch {
    return [];
  }
}

// === Kernel Reboot ===

async function checkKernelReboot(): Promise<KernelRebootStatus | null> {
  const running = (await run("uname", ["-r"]))?.trim();
  if (!running) return null;

  // Method 1: reboot-required flag (Debian/Ubuntu)
  if (existsSync("/var/run/reboot-required")) {
    // Filter to versioned images only (e.g. linux-image-6.8.0-107-generic),
    // excluding metapackages like linux-image-generic, linux-image-virtual.
    const installed = (await run("bash", ["-c", 'dpkg -l "linux-image-*" 2>/dev/null | grep "^ii" | awk \'{print $2}\' | grep "linux-image-[0-9]" | sed "s/linux-image-//" | sort -V | tail -1']))?.trim() || "unknown";
    // /var/run/reboot-required fires for ANY package that wants a reboot
    // (libc, systemd, dbus), not just the kernel. For kernel_needs_reboot the
    // authoritative signal is whether a newer kernel is installed than the one
    // running; if the running kernel is already the newest installed, this is
    // a non-kernel reboot flag and the rule should not fire (fleet report rec
    // #4 false positive). Only fall back to trusting the flag when we could
    // not determine the installed kernel.
    return { running, installed, needsReboot: installed === "unknown" ? true : installed !== running };
  }

  // Method 2: Compare packages (Debian/Ubuntu)
  // Same filter: only versioned images, no metapackages.
  const debPkg = (await run("bash", ["-c", 'dpkg -l "linux-image-*" 2>/dev/null | grep "^ii" | awk \'{print $2}\' | grep "linux-image-[0-9]" | sed "s/linux-image-//" | sort -V | tail -1']))?.trim();
  if (debPkg) {
    return { running, installed: debPkg, needsReboot: debPkg !== running };
  }

  // Method 3: RPM-based (RHEL/Fedora/SUSE). Modern RHEL (EL8+) ships the
  // kernel as `kernel-core`, not `kernel`; SUSE uses `kernel-default`.
  // Querying only `kernel` returns the literal "package kernel is not
  // installed" on EL8/9/10, which is truthy and != running, so the rule
  // misfired with that string as the "installed" version (Rocky 10 false
  // positive). Query every package that carries the kernel and keep only
  // real version lines (they start with a digit; "package X is not
  // installed" does not), then take the newest.
  const rpmPkg = (await run("bash", ["-c", 'rpm -q --queryformat "%{VERSION}-%{RELEASE}.%{ARCH}\\n" kernel-core kernel kernel-default 2>/dev/null | grep -E "^[0-9]" | sort -V | tail -1']))?.trim();
  if (rpmPkg) {
    return { running, installed: rpmPkg, needsReboot: rpmPkg !== running };
  }

  return null;
}

// === Auto Updates ===

async function checkAutoUpdates(): Promise<AutoUpdateStatus> {
  // Debian/Ubuntu: unattended-upgrades
  const uuInstalled = await run("bash", ["-c", 'dpkg -l unattended-upgrades 2>/dev/null | grep "^ii"'], 5000);
  if (uuInstalled) {
    // Check config file
    const autoConf = "/etc/apt/apt.conf.d/20auto-upgrades";
    let configEnabled = false;
    if (existsSync(autoConf)) {
      const content = readFileSync(autoConf, "utf-8");
      configEnabled = content.includes('Update-Package-Lists "1"') && content.includes('Unattended-Upgrade "1"');
    }

    // Check systemd service state
    const serviceEnabled = (await run("bash", ["-c", "systemctl is-enabled unattended-upgrades 2>/dev/null"], 5000))?.trim() === "enabled";
    const serviceActive = (await run("bash", ["-c", "systemctl is-active unattended-upgrades 2>/dev/null"], 5000))?.trim() === "active";

    if (configEnabled && serviceEnabled) {
      return { configured: true, mechanism: "unattended-upgrades", details: serviceActive ? "Installed, enabled, and running" : "Installed and enabled (service not active)" };
    }
    if (!configEnabled && !serviceEnabled) {
      return { configured: false, mechanism: "unattended-upgrades", details: "Installed but not configured and service disabled" };
    }
    if (!serviceEnabled) {
      return { configured: false, mechanism: "unattended-upgrades", details: "Installed and configured but service disabled" };
    }
    return { configured: false, mechanism: "unattended-upgrades", details: "Installed but not enabled in 20auto-upgrades" };
  }

  // RHEL/Rocky/Alma: dnf-automatic
  const dnfAuto = await run("bash", ["-c", "rpm -q dnf-automatic 2>/dev/null"], 5000);
  if (dnfAuto && !dnfAuto.includes("not installed")) {
    // Two timers ship with dnf-automatic and they are NOT equivalent:
    //   - dnf-automatic-install.timer applies updates unconditionally.
    //   - dnf-automatic.timer (legacy) and dnf-automatic-download.timer
    //     respect /etc/dnf/automatic.conf: they only apply when
    //     apply_updates = yes; otherwise they download-only and nothing
    //     is ever installed.
    // The old code accepted either timer as "configured", so a
    // download-only host reported configured:true, which suppressed
    // pending_security_updates while Critical patches sat unapplied.
    const installTimer = (await run("bash", ["-c", "systemctl is-enabled dnf-automatic-install.timer 2>/dev/null"], 5000))?.includes("enabled") ?? false;
    const legacyTimer = (await run("bash", ["-c", "systemctl is-enabled dnf-automatic.timer dnf-automatic-download.timer 2>/dev/null"], 5000))?.includes("enabled") ?? false;
    // apply_updates is parsed by Python configparser's getboolean: yes/true/on/1
    // (case-insensitive) all mean "apply". Match the full affirmative set, and
    // anchor the value so `apply_updates = yessir` or a trailing comment is
    // handled correctly. (Codex review 2026-06-06.)
    const applyYes = ((await run("bash", ["-c", "grep -Ei '^[[:space:]]*apply_updates[[:space:]]*=[[:space:]]*(yes|true|on|1)([[:space:]]|#|$)' /etc/dnf/automatic.conf 2>/dev/null"], 5000))?.trim().length ?? 0) > 0;

    if (installTimer || (legacyTimer && applyYes)) {
      return { configured: true, mechanism: "dnf-automatic", details: "Installed and configured to apply updates" };
    }
    if (legacyTimer && !applyYes) {
      return { configured: false, mechanism: "dnf-automatic", details: "Timer enabled but download-only (apply_updates not yes); patches are downloaded but never applied" };
    }
    return { configured: false, mechanism: "dnf-automatic", details: "Installed but no installing timer enabled" };
  }

  return { configured: false, mechanism: "none", details: "No automatic security update mechanism detected" };
}
