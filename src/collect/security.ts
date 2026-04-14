import { run } from "../lib/exec.js";
import { readFileSync, existsSync, readdirSync } from "fs";

export interface SshSecurityStatus {
  permitRootLogin: string;
  passwordAuthentication: string;
  rootPasswordExposed: boolean;
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

export async function collectSecurity(): Promise<SecurityData> {
  const [ssh, firewall, pendingUpdates, kernelVulns, kernelReboot, autoUpdates] = await Promise.all([
    checkSshConfig(),
    checkFirewall(),
    checkSecurityUpdates(),
    checkKernelVulnerabilities(),
    checkKernelReboot(),
    checkAutoUpdates(),
  ]);

  return { ssh, firewall, pending_updates: pendingUpdates, kernel_vulns: kernelVulns, kernel_reboot: kernelReboot, auto_updates: autoUpdates };
}

// === SSH ===

async function checkSshConfig(): Promise<SshSecurityStatus | null> {
  // Prefer sshd -T (resolves includes and match blocks)
  const output = await run("sshd", ["-T"], 5000);
  if (output) {
    const getVal = (key: string): string => {
      const line = output.split("\n").find((l) => l.startsWith(key + " "));
      return line ? line.split(" ")[1].trim() : "";
    };
    const permitRootLogin = getVal("permitrootlogin");
    const passwordAuth = getVal("passwordauthentication");
    const rootPasswordExposed = permitRootLogin === "yes" && passwordAuth !== "no";
    return { permitRootLogin, passwordAuthentication: passwordAuth, rootPasswordExposed };
  }

  // Fallback: parse sshd_config directly
  try {
    const config = readFileSync("/etc/ssh/sshd_config", "utf-8");
    const lines = config.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const find = (key: string): string | null => {
      const line = lines.find((l) => l.toLowerCase().startsWith(key.toLowerCase()));
      return line ? line.split(/\s+/)[1] : null;
    };
    const permitRootLogin = find("PermitRootLogin") || "prohibit-password";
    const passwordAuth = find("PasswordAuthentication") || "yes";
    const rootPasswordExposed = permitRootLogin.toLowerCase() === "yes" && passwordAuth.toLowerCase() !== "no";
    return { permitRootLogin, passwordAuthentication: passwordAuth, rootPasswordExposed };
  } catch {
    return null;
  }
}

// === Firewall ===

async function checkFirewall(): Promise<FirewallStatus> {
  // UFW: if installed, its status is authoritative (ignores Docker iptables chains)
  const ufw = await run("ufw", ["status"], 5000);
  if (ufw && ufw.includes("Status:")) {
    const active = ufw.includes("Status: active");
    return { active, source: "ufw", details: active ? "UFW is active" : "UFW is inactive" };
  }

  // firewalld: if installed, its status is authoritative
  const fwd = await run("firewall-cmd", ["--state"], 5000);
  if (fwd) {
    if (fwd.trim() === "running") {
      return { active: true, source: "firewalld", details: "firewalld is running" };
    }
    if (fwd.includes("not running") || fwd.includes("dead")) {
      return { active: false, source: "firewalld", details: "firewalld is not running" };
    }
  }

  // nftables (only if no managed firewall found)
  const nft = await run("nft", ["list", "ruleset"], 5000);
  if (nft) {
    const ruleLines = nft.split("\n").filter((l) => l.trim().match(/^\s*(meta|ip |ip6 |tcp |udp |ct |drop|reject|accept)/));
    if (ruleLines.length > 0) {
      return { active: true, source: "nftables", details: `${ruleLines.length} nftables rules` };
    }
  }

  // iptables fallback: filter out Docker/container chains to avoid false positives
  const ipt = await run("iptables", ["-L", "-n"], 5000);
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
    const output = await run("bash", ["-c", `${cmd} updateinfo list security --available 2>/dev/null | grep -c "/"`], 60000);
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
    return { running, installed, needsReboot: true };
  }

  // Method 2: Compare packages (Debian/Ubuntu)
  // Same filter: only versioned images, no metapackages.
  const debPkg = (await run("bash", ["-c", 'dpkg -l "linux-image-*" 2>/dev/null | grep "^ii" | awk \'{print $2}\' | grep "linux-image-[0-9]" | sed "s/linux-image-//" | sort -V | tail -1']))?.trim();
  if (debPkg) {
    return { running, installed: debPkg, needsReboot: debPkg !== running };
  }

  // Method 3: RPM-based
  const rpmPkg = (await run("bash", ["-c", 'rpm -q kernel --queryformat "%{VERSION}-%{RELEASE}.%{ARCH}\\n" 2>/dev/null | sort -V | tail -1']))?.trim();
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
    const timerActive = await run("bash", ["-c", "systemctl is-enabled dnf-automatic-install.timer 2>/dev/null || systemctl is-enabled dnf-automatic.timer 2>/dev/null"], 5000);
    if (timerActive && timerActive.includes("enabled")) {
      return { configured: true, mechanism: "dnf-automatic", details: "Installed and timer enabled" };
    }
    return { configured: false, mechanism: "dnf-automatic", details: "Installed but timer not enabled" };
  }

  return { configured: false, mechanism: "none", details: "No automatic security update mechanism detected" };
}
