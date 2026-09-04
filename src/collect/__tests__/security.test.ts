// Tests for collectSecurity's cache shape.
//
// Pre-0.9.3: the entire SecurityData was cached for 1h (12 cycles at
// 300s interval), which meant customer config changes (ufw enable,
// sshd_config edit, dnf-automatic install) didn't show up in alert
// state for up to an hour. Surfaced by CLEANUP_REPORT_2026-05-13.md.
//
// 0.9.3: only the pending_updates sub-check is cached (since it hits
// apt/dnf metadata and is genuinely slow). Every other sub-check
// (firewall, sshd, kernel_vulns, kernel_reboot, auto_updates) runs
// every cycle.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const runDetailedMock = vi.fn();
vi.mock("../../lib/exec.js", () => ({
  run: (...args: unknown[]) => runMock(...args),
  runDetailed: (...args: unknown[]) => runDetailedMock(...args),
}));
vi.mock("fs", () => ({
  existsSync: () => false,
  readFileSync: () => "",
  readdirSync: () => [],
}));
// runPrivileged is the only way the firewall probes reach ufw / firewall-cmd /
// nft / iptables. Default to null (no wrapper, not root) so every pre-existing
// test keeps the behaviour it had when the real module returned null.
const runPrivilegedMock = vi.fn();
vi.mock("../../lib/privileged.js", () => ({
  runPrivileged: (...args: unknown[]) => runPrivilegedMock(...args),
}));

const {
  collectSecurity,
  __resetSecurityCacheForTests,
  iptablesHasEffectiveIngressProtection,
  nftHasEffectiveIngressProtection,
  readKernelVulnerability,
  securityCollectionAvailability,
  installedKernelIsNewer,
  rpmKernelPackagesFor,
} = await import("../security.js");
const { allRules } = await import("../../alerts/rules.js");

beforeEach(() => {
  runMock.mockReset();
  runDetailedMock.mockReset();
  runDetailedMock.mockResolvedValue({
    installed: true,
    exitCode: 1,
    stdout: null,
    stderr: "",
    timedOut: false,
  });
  runPrivilegedMock.mockReset();
  runPrivilegedMock.mockResolvedValue(null);
  __resetSecurityCacheForTests();
});

describe("collectSecurity cache shape (0.9.3 fix)", () => {
  it("fast sub-checks (firewall, ssh, kernel_reboot, auto_updates) re-run on every call", async () => {
    // Stub: every run() returns null (no shell tool installed).
    runMock.mockResolvedValue(null);
    await collectSecurity();
    const callsAfterFirst = runMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await collectSecurity();
    const callsAfterSecond = runMock.mock.calls.length;
    // Second call should re-run all the fast checks (mostly the
    // same shell commands as first call). The only thing that
    // SHOULD be skipped is checkSecurityUpdates because of the
    // pending-updates cache.
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it("pending_updates result is cached within the TTL window", async () => {
    // The check looks for apt/dnf etc via run(); we simulate "apt is
    // installed and returns 5 upgradable" by matching the bash -c
    // call pattern.
    runMock.mockImplementation((...args: any[]) => {
      const cmd = args[0] as string;
      const subArgs = args[1] as string[];
      const fullCmd = `${cmd} ${(subArgs || []).join(" ")}`;
      if (fullCmd.includes("apt list --upgradable")) {
        return Promise.resolve("Listing...\n/security/upgradable\n");
      }
      return Promise.resolve(null);
    });

    const first = await collectSecurity();
    // Find checkSecurityUpdates-like calls
    const updateCallsAfterFirst = runMock.mock.calls.filter((c) =>
      String(c[1]?.join(" ") ?? "").includes("apt list --upgradable") ||
      String(c[1]?.join(" ") ?? "").includes("dnf updateinfo")
    ).length;

    await collectSecurity();
    const updateCallsAfterSecond = runMock.mock.calls.filter((c) =>
      String(c[1]?.join(" ") ?? "").includes("apt list --upgradable") ||
      String(c[1]?.join(" ") ?? "").includes("dnf updateinfo")
    ).length;

    expect(updateCallsAfterFirst).toBeGreaterThanOrEqual(0);
    // Whatever the first count was, the second call should NOT have
    // added new pending-updates calls (cache hit).
    expect(updateCallsAfterSecond).toBe(updateCallsAfterFirst);
    expect(first.pending_updates).toBeDefined();
  });

  it("__resetSecurityCacheForTests forces re-collection of pending_updates", async () => {
    runMock.mockImplementation((...args: any[]) => {
      const subArgs = args[1] as string[];
      const fullCmd = (subArgs || []).join(" ");
      if (fullCmd.includes("apt list --upgradable")) {
        return Promise.resolve("Listing...\n");
      }
      return Promise.resolve(null);
    });

    await collectSecurity();
    __resetSecurityCacheForTests();

    // After reset, the next call should re-attempt the expensive check.
    const callsBefore = runMock.mock.calls.length;
    await collectSecurity();
    const callsAfter = runMock.mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });
});

describe("fail-visible security probes", () => {
  it("requires an input hook and protective nftables verdict", () => {
    expect(nftHasEffectiveIngressProtection(`table inet filter {
      chain input { type filter hook input priority 0; policy accept; tcp dport 22 accept }
    }`)).toBe(false);
    expect(nftHasEffectiveIngressProtection(`table inet filter {
      chain input {
        type filter hook input priority 0; policy accept;
        ct state invalid drop
      }
    }`)).toBe(true);
    expect(nftHasEffectiveIngressProtection("chain input { type filter hook input priority 0; policy drop; }")).toBe(true);
    expect(nftHasEffectiveIngressProtection(`table inet filter {
      chain input {
        type filter hook input priority 0; policy drop;
      }
    }`)).toBe(true);
    expect(nftHasEffectiveIngressProtection(`table inet filter {
      chain input {
        type filter hook input priority 0; policy accept;
        tcp dport { 22, 80 } accept
        ct state invalid drop
      }
    }`)).toBe(true);
  });

  it("evaluates only the iptables INPUT policy and verdicts", () => {
    const acceptOnly = "Chain INPUT (policy ACCEPT)\ntarget prot opt source destination\nACCEPT all -- 0.0.0.0/0 0.0.0.0/0\n\nChain DOCKER (policy ACCEPT)\nDROP all -- 0.0.0.0/0 0.0.0.0/0\n";
    expect(iptablesHasEffectiveIngressProtection(acceptOnly)).toBe(false);
    expect(iptablesHasEffectiveIngressProtection(acceptOnly.replace("policy ACCEPT", "policy DROP"))).toBe(true);
    const fail2banOnly = "Chain INPUT (policy ACCEPT)\ntarget prot opt source destination\nDROP all -- 203.0.113.8 0.0.0.0/0\n";
    expect(iptablesHasEffectiveIngressProtection(fail2banOnly)).toBe(false);
  });

  it("marks a failed kernel vulnerability read unknown and unavailable", () => {
    const result = readKernelVulnerability("spectre_v2", () => { throw new Error("EACCES"); });
    expect(result).toMatchObject({
      status: "unknown",
      mitigated: false,
      available: false,
    });
  });

  it("reports no installed firewall tooling as a reachable inactive state", async () => {
    runMock.mockResolvedValue(null);
    const result = await collectSecurity();
    expect(result.firewall).toMatchObject({ available: true, active: false, source: "none" });
    const noFirewallRule = allRules.find((rule) => rule.type === "no_firewall")!;
    expect(noFirewallRule.evaluate({ security: result } as any, {} as any)).toHaveLength(1);
  });

  it("propagates a present but failed firewall probe into collection status", async () => {
    runMock.mockResolvedValue(null);
    runDetailedMock.mockImplementation((_cmd: string, args: string[]) => Promise.resolve({
      installed: true,
      exitCode: args[0] === "nft" ? 0 : 1,
      stdout: args[0] === "nft" ? "/usr/sbin/nft\n" : null,
      stderr: "",
      timedOut: false,
    }));
    const result = await collectSecurity();
    expect(result.firewall).toMatchObject({ available: false, active: null, source: "unknown" });
    expect(securityCollectionAvailability(result)).toMatchObject({
      available: false,
      error: expect.stringContaining("firewall"),
    });
  });

  it("ignores commented unattended-upgrades examples and accepts effective apt-config", async () => {
    const configure = (effective: string) => runMock.mockImplementation((cmd: string, args: string[]) => {
      const full = `${cmd} ${args.join(" ")}`;
      if (full.includes("dpkg -l unattended-upgrades")) return Promise.resolve("ii unattended-upgrades");
      if (cmd === "apt-config") return Promise.resolve(effective);
      if (full.includes("is-enabled unattended-upgrades")) return Promise.resolve("enabled");
      if (full.includes("is-active unattended-upgrades")) return Promise.resolve("active");
      return Promise.resolve(null);
    });

    configure('// APT::Periodic::Update-Package-Lists "1";\n// APT::Periodic::Unattended-Upgrade "1";');
    expect((await collectSecurity()).auto_updates.configured).toBe(false);
    configure('APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";');
    expect((await collectSecurity()).auto_updates.configured).toBe(true);
  });
});

// Known-bad fixture (remote-codex, Ubuntu 24.04, 2026-09-04): ufw was
// installed but never enabled, and the host's real firewall was a hand-written
// nftables ruleset with input and output at policy drop. The ufw branch
// returned as soon as it saw "Status:", so the collector reported
// active:false source:ufw and the dashboard raised no_firewall on a
// default-deny host. Purging the ufw package cleared it, which is the wrong
// fix: an installed-but-inactive managed backend must fall through to the
// raw nftables / iptables probes before anything is declared unprotected.
const NFT_DROP_RULESET = `table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;
    ct state established,related accept
    iif "lo" accept
    tcp dport 22 accept
  }
  chain output {
    type filter hook output priority filter; policy drop;
    ct state established,related accept
    tcp dport { 53, 443 } accept
  }
}
`;

describe("checkFirewall falls through an inactive managed backend", () => {
  const noFirewallRule = allRules.find((rule) => rule.type === "no_firewall")!;

  function privileged(outputs: Record<string, string>) {
    runPrivilegedMock.mockImplementation((action: string) => Promise.resolve(outputs[action] ?? null));
  }
  function installed(...tools: string[]) {
    runDetailedMock.mockImplementation((_cmd: string, args: string[]) => Promise.resolve({
      installed: true,
      exitCode: tools.includes(args[0]) ? 0 : 1,
      stdout: tools.includes(args[0]) ? `/usr/sbin/${args[0]}\n` : null,
      stderr: "",
      timedOut: false,
    }));
  }

  it("ufw installed but inactive + protective nftables ruleset => active via nftables", async () => {
    runMock.mockResolvedValue(null);
    installed("ufw", "nft");
    privileged({ ufw: "Status: inactive\n", nft: NFT_DROP_RULESET });
    const result = await collectSecurity();
    expect(result.firewall).toMatchObject({ available: true, active: true, source: "nftables" });
    expect(noFirewallRule.evaluate({ security: result } as any, {} as any)).toEqual([]);
  });

  it("firewalld installed but not running + protective nftables ruleset => active via nftables", async () => {
    runMock.mockResolvedValue(null);
    installed("firewall-cmd", "nft");
    privileged({ "firewall-cmd": "not running\n", nft: NFT_DROP_RULESET });
    const result = await collectSecurity();
    expect(result.firewall).toMatchObject({ available: true, active: true, source: "nftables" });
  });

  it("keeps the inactive managed backend as source when nothing protects, and names every consulted backend", async () => {
    runMock.mockResolvedValue(null);
    installed("ufw", "nft", "iptables");
    privileged({
      ufw: "Status: inactive\n",
      nft: "table inet filter {\n  chain input {\n    type filter hook input priority filter; policy accept;\n  }\n}\n",
      iptables: "Chain INPUT (policy ACCEPT)\ntarget prot opt source destination\n",
    });
    const result = await collectSecurity();
    // source stays "ufw": the dashboard's fix variants key on it to pick the
    // enable-ufw path, which is still the right remediation on this host.
    expect(result.firewall).toMatchObject({ available: true, active: false, source: "ufw" });
    expect(result.firewall.details).toMatch(/ufw/);
    expect(result.firewall.details).toMatch(/nftables/);
    expect(result.firewall.details).toMatch(/iptables/);
    const alerts = noFirewallRule.evaluate({ security: result } as any, {} as any);
    expect(alerts).toHaveLength(1);
    // The message must report what was consulted on THIS host, not a fixed
    // list: firewalld was never installed here, so it must not be claimed.
    expect(alerts[0].message).toContain(result.firewall.details);
    expect(alerts[0].message).not.toMatch(/firewalld/);
  });
});

// R-P2-RHEL-1 (val-fleet campaign 2026-05-22): the RHEL dnf-automatic
// path used to treat ANY enabled timer as "configured: true", which
// included the download-only timers (dnf-automatic.timer /
// dnf-automatic-download.timer with apply_updates != yes). A
// download-only host then suppressed pending_security_updates while
// Critical patches sat unapplied (observed on h12sst: 26 pending,
// some Critical). The fix requires either dnf-automatic-install.timer
// (applies unconditionally) OR a legacy/download timer WITH
// apply_updates = yes in /etc/dnf/automatic.conf.
describe("checkAutoUpdates dnf-automatic apply-vs-download (R-P2-RHEL-1)", () => {
  // Helper: route the shell mock so the Debian path is absent (no
  // unattended-upgrades) and dnf-automatic is installed, then let the
  // caller decide which timers/config to report.
  function dnfHost(opts: {
    installTimer?: boolean;
    legacyTimer?: boolean;
    applyYes?: boolean;
  }) {
    return (...args: any[]) => {
      const cmd = String((args[1] as string[])?.join(" ") ?? "");
      // Debian path: not installed
      if (cmd.includes("dpkg -l unattended-upgrades")) return Promise.resolve(null);
      // dnf-automatic installed
      if (cmd.includes("rpm -q dnf-automatic")) return Promise.resolve("dnf-automatic-1.0.0-1.el9.noarch");
      // install timer
      if (cmd.includes("is-enabled dnf-automatic-install.timer")) {
        return Promise.resolve(opts.installTimer ? "enabled" : "disabled");
      }
      // legacy/download timer (single is-enabled call with both unit names)
      if (cmd.includes("is-enabled dnf-automatic.timer dnf-automatic-download.timer")) {
        return Promise.resolve(opts.legacyTimer ? "enabled\ndisabled" : "disabled\ndisabled");
      }
      // apply_updates grep
      if (cmd.includes("apply_updates")) {
        return Promise.resolve(opts.applyYes ? "apply_updates = yes" : "");
      }
      return Promise.resolve(null);
    };
  }

  it("install.timer enabled => configured: true regardless of apply_updates", async () => {
    runMock.mockImplementation(dnfHost({ installTimer: true, legacyTimer: false, applyYes: false }));
    const r = await collectSecurity();
    expect(r.auto_updates.mechanism).toBe("dnf-automatic");
    expect(r.auto_updates.configured).toBe(true);
  });

  it("legacy/download timer enabled but apply_updates != yes => configured: false (download-only)", async () => {
    runMock.mockImplementation(dnfHost({ installTimer: false, legacyTimer: true, applyYes: false }));
    const r = await collectSecurity();
    expect(r.auto_updates.mechanism).toBe("dnf-automatic");
    expect(r.auto_updates.configured).toBe(false);
    expect(r.auto_updates.details).toMatch(/download-only/i);
  });

  it("legacy timer enabled WITH apply_updates = yes => configured: true", async () => {
    runMock.mockImplementation(dnfHost({ installTimer: false, legacyTimer: true, applyYes: true }));
    const r = await collectSecurity();
    expect(r.auto_updates.configured).toBe(true);
  });

  it("dnf-automatic installed but no timer enabled => configured: false", async () => {
    runMock.mockImplementation(dnfHost({ installTimer: false, legacyTimer: false, applyYes: false }));
    const r = await collectSecurity();
    expect(r.auto_updates.configured).toBe(false);
    expect(r.auto_updates.details).toMatch(/no installing timer/i);
  });
});

// kernel_needs_reboot: the "installed is newer" decision used to be a string
// inequality, so a host booted into a mainline or custom kernel (packaged
// linux-image-unsigned-*, which the installed-kernel scan also used to miss)
// alerted forever, and no reboot could clear it because GRUB boots the same
// kernel again. Found on a real host running 6.10.0-061000-generic while apt's
// newest was 6.8.0-136-generic.
describe("installedKernelIsNewer", () => {
  it("does not claim a reboot when the running kernel is newer (mainline kernel)", () => {
    expect(installedKernelIsNewer("6.8.0-136-generic", "6.10.0-061000-generic")).toBe(false);
  });
  it("compares numerically, not as strings (6.10 outranks 6.8)", () => {
    expect(installedKernelIsNewer("6.10.0-1", "6.8.0-9")).toBe(true);
  });
  it("still reports a genuinely newer installed kernel", () => {
    expect(installedKernelIsNewer("6.8.0-136-generic", "6.8.0-124-generic")).toBe(true);
  });
  it("treats an equal kernel as no reboot needed", () => {
    expect(installedKernelIsNewer("6.8.0-136-generic", "6.8.0-136-generic")).toBe(false);
  });
  it("returns false when a version has no parseable numbers", () => {
    expect(installedKernelIsNewer("unknown", "6.8.0-136-generic")).toBe(false);
  });
  it("handles RHEL-style releases", () => {
    expect(installedKernelIsNewer("5.14.0-503.40.1.el9_5.x86_64", "5.14.0-503.38.1.el9_5.x86_64")).toBe(true);
  });
});

// rpm kernel scan must stay within the running kernel's family. Querying a
// fixed cross-family set (kernel-core kernel kernel-default) omitted Oracle's
// kernel-uek entirely, so on a UEK host a retained older RHCK package was read
// as "installed" and a genuine UEK update was hidden (false negative).
describe("rpmKernelPackagesFor", () => {
  it("selects kernel-uek for an Oracle UEK running kernel", () => {
    expect(rpmKernelPackagesFor("5.15.0-300.161.13.el8uek.x86_64")).toEqual(["kernel-uek"]);
  });
  it("selects kernel-default for a SUSE running kernel", () => {
    expect(rpmKernelPackagesFor("6.4.0-150600.23.42-default")).toEqual(["kernel-default"]);
  });
  it("selects kernel-core + kernel for stock RHEL/Rocky/Alma", () => {
    expect(rpmKernelPackagesFor("4.18.0-553.40.1.el8_10.x86_64")).toEqual(["kernel-core", "kernel"]);
  });
  it("does not misclassify a stock EL9 kernel as SUSE or UEK", () => {
    expect(rpmKernelPackagesFor("5.14.0-503.40.1.el9_5.x86_64")).toEqual(["kernel-core", "kernel"]);
  });
});

