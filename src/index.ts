#!/usr/bin/env node

import { parseCliArgs } from "./cli.js";
import { CRUCIBLE_VERSION as PKG_VERSION } from "./lib/version.js";

// Handle --version, --help, and planned-reboot subcommands before
// importing collectors, loading config, or starting the Prometheus
// server. Keeps the CLI responsive even on hosts missing the config
// file or external tools.
const { result: cliArgs, output: cliOutput } = parseCliArgs(process.argv.slice(2), PKG_VERSION);
if (cliArgs.mode === "version" || cliArgs.mode === "help") {
  console.log(cliOutput);
  process.exit(0);
}
if (cliArgs.mode === "doctor-ipmi") {
  const { runDoctorIpmi } = await import("./doctor.js");
  console.log(await runDoctorIpmi());
  process.exit(0);
}
if (cliArgs.mode === "init") {
  const { runInit, defaultDeps } = await import("./init.js");
  const flags = cliArgs.init;
  if (!flags || !flags.apiKey) {
    console.error("[init] missing required --api-key (use --api-key - to read from stdin). See 'glassmkr-crucible init --help'.");
    process.exit(2);
  }
  const code = await runInit({
    apiKey: flags.apiKey,
    name: flags.name,
    ingestUrl: flags.ingestUrl,
    configPath: flags.configPath,
    noStart: flags.noStart,
    force: flags.force,
    noVerify: flags.noVerify,
  }, defaultDeps());
  process.exit(code);
}
if (cliArgs.mode === "mark-reboot" || cliArgs.mode === "reboot") {
  const { writeRebootMarker, parseDuration, DEFAULT_TTL_MS } = await import("./lib/reboot-marker.js");
  const ttlMs = cliArgs.ttl ? parseDuration(cliArgs.ttl) : DEFAULT_TTL_MS;
  if (ttlMs === null) {
    console.error(`[mark-reboot] invalid --ttl value: ${cliArgs.ttl}. Use e.g. 10m, 2h, 600s.`);
    process.exit(2);
  }
  try {
    const { path, expires_at } = writeRebootMarker({
      reason: cliArgs.reason, ttlMs,
    });
    console.log(`[${cliArgs.mode}] marker written: ${path} (expires ${expires_at}${cliArgs.reason ? `, reason: ${cliArgs.reason}` : ""})`);
  } catch (err: any) {
    console.error(`[${cliArgs.mode}] failed to write marker: ${err?.message || err}`);
    console.error(`  Most likely cause: need root privileges to write under /var/lib/crucible/.`);
    process.exit(1);
  }
  if (cliArgs.mode === "reboot") {
    const { execFileSync } = await import("node:child_process");
    console.log("[reboot] invoking systemctl reboot");
    try {
      execFileSync("systemctl", ["reboot"], { stdio: "inherit" });
    } catch (err: any) {
      console.error(`[reboot] systemctl reboot failed: ${err?.message || err}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

import { loadConfig } from "./config.js";
import { checkForUpdates } from "./lib/version-check.js";
import { startMetricsServer, updateMetrics } from "./metrics-server.js";
import { collectSystem } from "./collect/system.js";
import { collectCpu } from "./collect/cpu.js";
import { collectMemory } from "./collect/memory.js";
import { collectDisks } from "./collect/disks.js";
import { collectSmart } from "./collect/smart.js";
import { collectNetwork } from "./collect/network.js";
import { collectRaid } from "./collect/raid.js";
import { collectIpmi } from "./collect/ipmi.js";
import { collectOsAlerts } from "./collect/os-alerts.js";
import { evaluateAlerts } from "./alerts/evaluator.js";
import { updateAlertState } from "./alerts/state.js";
import { sendTelegram } from "./notify/telegram.js";
import { sendSlack } from "./notify/slack.js";
import { sendEmail } from "./notify/email.js";
import { pushToDashboard, initDashboardAgent } from "./push/dashboard.js";
import { collectSecurity, type SecurityData } from "./collect/security.js";
import { collectZfs } from "./collect/zfs.js";
import { collectEdac } from "./collect/edac.js";
import { collectPsi } from "./collect/psi.js";
import { collectVmstat } from "./collect/vmstat.js";
import { collectRebootEvidence } from "./collect/reboot-evidence.js";
import { collectHardwareRaid } from "./collect/hardware-raid.js";
import { collectIoErrors } from "./collect/io-errors.js";
import { collectIoLatency } from "./collect/io-latency.js";
import { collectConntrack } from "./collect/conntrack.js";
import { collectSystemd } from "./collect/systemd.js";
import { collectNtp } from "./collect/ntp.js";
import { collectFileDescriptors, collectProcessFd } from "./collect/fd.js";
import { collectBonding } from "./collect/bonding.js";
import { collectTcpStats } from "./collect/tcp-stats.js";
import { collectThermal } from "./collect/thermal.js";
import { collectDmi, formatVendorLine } from "./collect/dmi.js";
import { detectIpmiCapability, formatCapabilityLine } from "./lib/capability.js";
import type { Snapshot, IpmiInfo, DmiInfo, IpmiCapability } from "./lib/types.js";
import { consumeRebootMarker, type PlannedReboot } from "./lib/reboot-marker.js";

// Consume the planned-reboot marker once at startup. If the operator ran
// `crucible-agent mark-reboot` / `reboot` before this boot, the marker
// exists, we flag it on the first snapshot, and we delete the file (so
// subsequent snapshots don't keep claiming the reboot was planned).
const plannedRebootFlag: PlannedReboot | null = consumeRebootMarker();
if (plannedRebootFlag) {
  console.log(`[collector] Planned reboot acknowledged${plannedRebootFlag.reason ? `: ${plannedRebootFlag.reason}` : ""}`);
}
let plannedRebootConsumed = false;

const config = loadConfig(cliArgs.configPath);

console.log(`[collector] Starting. Server: ${config.server_name}. Interval: ${config.collection.interval_seconds}s`);
console.log(`[collector] IPMI: ${config.collection.ipmi ? "enabled" : "disabled"}, SMART: ${config.collection.smart ? "enabled" : "disabled"}`);
console.log(`[collector] Dashboard: ${config.dashboard.enabled ? config.dashboard.url : "disabled"}`);
console.log(`[collector] Prometheus: ${config.prometheus.enabled ? `:${config.prometheus.port}/metrics` : "disabled"}`);

// Start Prometheus metrics server if enabled
if (config.prometheus.enabled) {
  startMetricsServer(config.prometheus.port);
}

// Initialize TLS pinning for Dashboard if configured
if (config.dashboard.tls_pin) {
  initDashboardAgent(config.dashboard.tls_pin);
  console.log("[collector] TLS pinning enabled for Dashboard");
}

// Returned when IPMI collection is disabled by config. `null` ecc/SEL
// distinguishes "we didn't probe" from "BMC said zero". glassmkr#29.
const emptyIpmi: IpmiInfo = { available: false, sensors: [], ecc_errors: null, sel_entries_count: null, sel_events_recent: [], fans: [] };

// DMI is read once at startup; sys_vendor / product_name don't change for
// the lifetime of the process.
let cachedDmi: DmiInfo | undefined;
if (config.collection.dmi) {
  try {
    cachedDmi = await collectDmi();
    console.log(`[collector] ${formatVendorLine(cachedDmi)}`);
  } catch (err) {
    console.error("[dmi] Detection error:", err);
  }
}

// IPMI capability detection runs at startup AND is periodically re-run so
// that a customer who installs ipmitool after the agent started doesn't
// have to restart Crucible. Pre-0.9.4 the capability was one-shot at boot,
// which left services-1 (and any other host with the same install pattern)
// stuck reporting "Not detected" forever even after the operator fixed the
// underlying provisioning gap. cross-vendor IPMI audit Phase 1 B.2b.
//
// Re-detection cadence: every IPMI_RECHECK_CYCLES cycles. At the default
// 5-min collection interval that's one re-check per hour. Transitions
// false→true log info; true→false log warn.
const IPMI_RECHECK_CYCLES = 12;
let ipmiCapability: IpmiCapability | undefined;
let ipmiCheckCounter = 0;

async function refreshIpmiCapability(): Promise<void> {
  if (!config.collection.ipmi) return;
  try {
    const next = await detectIpmiCapability();
    const prevAvailable = ipmiCapability?.available;
    ipmiCapability = next;
    if (prevAvailable === undefined) {
      console.log(`[collector] ${formatCapabilityLine(next)}`);
    } else if (prevAvailable !== next.available) {
      const direction = next.available ? "available" : "unavailable";
      const level = next.available ? "log" : "warn";
      console[level](`[ipmi] capability flipped: now ${direction} (${formatCapabilityLine(next)})`);
    }
  } catch (err) {
    console.error("[ipmi] Capability detection error:", err);
  }
}

if (config.collection.ipmi) {
  await refreshIpmiCapability();
} else {
  console.log("[collector] IPMI: disabled by config");
}

// Security checks run every cycle. The only expensive sub-check
// (pending_updates against apt/dnf metadata) is internally cached
// with a 1h TTL inside collectSecurity(); every other sub-check
// (firewall, sshd config, kernel_vulns, kernel_reboot, auto_updates)
// is fast and re-runs every cycle so that a customer config change
// is reflected in the next snapshot rather than the next hourly
// window. Pre-fix this whole block was cached for 12 cycles which
// made legitimate fixes look broken from the customer's view for up
// to an hour. Surfaced by CLEANUP_REPORT_2026-05-13.md.
let lastSecurityResult: SecurityData | undefined;

async function collect() {
  const startTime = Date.now();
  console.log(`[collector] Collecting...`);

  // Re-check IPMI capability periodically so post-install fixes (ipmitool
  // installed after agent start, kernel modules loaded, permission grants)
  // pick up without a restart. First cycle (counter=0) does NOT re-check
  // because startup already did.
  if (config.collection.ipmi && ipmiCheckCounter > 0 && ipmiCheckCounter % IPMI_RECHECK_CYCLES === 0) {
    await refreshIpmiCapability();
  }
  ipmiCheckCounter++;

  const [system, cpu, memory, disks, smart, network, raid, ipmi, osAlerts] = await Promise.all([
    collectSystem(),
    collectCpu(),
    collectMemory(),
    collectDisks(),
    config.collection.smart ? collectSmart() : Promise.resolve([]),
    collectNetwork(),
    collectRaid(),
    config.collection.ipmi ? collectIpmi(cachedDmi?.vendor ?? "generic", ipmiCapability) : Promise.resolve(emptyIpmi),
    collectOsAlerts(),
  ]);

  try {
    lastSecurityResult = await collectSecurity();
  } catch (err) {
    console.error("[security] Collection error:", err);
    // Leave `lastSecurityResult` at its previous value so an
    // intermittent failure doesn't blank out the security block.
  }

  const snapshot: Snapshot = {
    collector_version: PKG_VERSION,
    timestamp: new Date().toISOString(),
    system, cpu, memory, disks, smart, network, raid, ipmi, os_alerts: osAlerts,
    security: lastSecurityResult,
    dmi: cachedDmi,
  };

  // Single-shot: the very first snapshot after a marked reboot carries
  // the flag, subsequent snapshots do not.
  if (plannedRebootFlag && !plannedRebootConsumed) {
    (snapshot as any).expected_reboot = true;
    if (plannedRebootFlag.reason) (snapshot as any).expected_reboot_reason = plannedRebootFlag.reason;
    plannedRebootConsumed = true;
  }

  // ZFS and I/O errors: collect every cycle (lightweight checks)
  if (config.collection.thermal) {
    try { snapshot.thermal = await collectThermal(); } catch { /* skip on error */ }
  }
  try { snapshot.zfs = await collectZfs() ?? undefined; } catch { /* skip if ZFS not available */ }
  try { snapshot.io_errors = await collectIoErrors() ?? undefined; } catch { /* skip on error */ }
  try { snapshot.io_latency = collectIoLatency(); } catch { /* skip on error */ }
  try { snapshot.conntrack = collectConntrack(); } catch { /* skip on error */ }
  try { snapshot.systemd = await collectSystemd(); } catch { /* skip on error */ }
  try { snapshot.ntp = await collectNtp(); } catch { /* skip on error */ }
  try { snapshot.file_descriptors = collectFileDescriptors(); } catch { /* skip on error */ }

  // C1-C6 collectors (v0.10.4, 2026-05-19). Each capability-gates by
  // detecting whether the underlying kernel/CLI surface exists; absent
  // → field omitted → dashboard rules degrade gracefully per the
  // activation PR's capability gates.
  try { snapshot.ecc_edac = collectEdac() ?? undefined; } catch { /* skip on error */ }
  try { snapshot.psi = collectPsi() ?? undefined; } catch { /* skip on error */ }
  try { snapshot.vmstat = collectVmstat() ?? undefined; } catch { /* skip on error */ }
  try { snapshot.reboot_evidence = await collectRebootEvidence(); } catch { /* skip on error */ }
  try { snapshot.hardware_raid = await collectHardwareRaid() ?? undefined; } catch { /* skip on error */ }

  // C7-C10 collectors (v0.11.0, 2026-05-19). Capability gating mirrors
  // C1-C6: each emits an `available: false` payload (or absent field)
  // when its underlying /proc surface is missing. Dashboard rules
  // degrade gracefully on older agents and hosts that lack the
  // relevant kernel modules.
  try { snapshot.process_fd = collectProcessFd(); } catch { /* skip on error */ }
  try { snapshot.bonding = collectBonding(); } catch { /* skip on error */ }
  try { snapshot.tcp_stats = collectTcpStats(); } catch { /* skip on error */ }

  // Update Prometheus metrics
  updateMetrics(snapshot);

  // Evaluate alerts
  const alertResults = evaluateAlerts(snapshot, config.thresholds);
  const { newAlerts, resolvedAlerts } = updateAlertState(alertResults);

  const elapsed = Date.now() - startTime;
  console.log(`[collector] Collected in ${elapsed}ms. Alerts: ${alertResults.length} active, ${newAlerts.length} new, ${resolvedAlerts.length} resolved`);

  // Send notifications for new/resolved alerts
  if (newAlerts.length > 0 || resolvedAlerts.length > 0) {
    if (config.channels.telegram.enabled && config.channels.telegram.bot_token && config.channels.telegram.chat_id) {
      await sendTelegram(config.channels.telegram.bot_token, config.channels.telegram.chat_id, newAlerts, resolvedAlerts, config.server_name);
    }
    if (config.channels.slack.enabled && config.channels.slack.webhook_url) {
      await sendSlack(config.channels.slack.webhook_url, newAlerts, resolvedAlerts, config.server_name);
    }
    if (config.channels.email.enabled && config.channels.email.to) {
      await sendEmail(config.channels.email, newAlerts, resolvedAlerts, config.server_name);
    }
  }

  // Push to Dashboard (non-blocking)
  if (config.dashboard.enabled && config.dashboard.api_key) {
    pushToDashboard(config.dashboard.url, config.dashboard.api_key, snapshot);
  }

  // Check for updates (every 6 hours, non-blocking)
  checkForUpdates(config.dashboard.enabled ? config.dashboard.url : undefined);

  // Print summary on first run
  if (firstRun) {
    firstRun = false;
    console.log("");
    console.log("=== First collection complete ===");
    console.log(`Server: ${system.hostname} (${system.os})`);
    console.log(`CPU:    ${cpu.user_percent.toFixed(1)}% (load: ${cpu.load_1m})`);
    const ramPct = memory.total_mb > 0 ? ((memory.used_mb / memory.total_mb) * 100).toFixed(1) : "0";
    console.log(`RAM:    ${ramPct}% (${memory.used_mb} / ${memory.total_mb} MB)`);
    if (disks.length > 0) console.log(`Disk:   ${disks[0].percent_used}% (${disks[0].mount})`);
    console.log(`SMART:  ${smart.length > 0 ? `${smart.length} drive(s) checked` : "not available"}`);
    console.log(`Network: ${network.map((n) => n.interface).join(", ") || "none detected"}`);
    console.log(`IPMI:   ${ipmi.available ? "available" : "not available"}`);
    if (snapshot.thermal) {
      const t = snapshot.thermal;
      const max = t.max_cpu_celsius != null ? `, hottest CPU ${t.max_cpu_celsius}°C` : "";
      console.log(`Thermal: ${t.source === "none" ? "no CPU sensors" : `${t.source} (${t.cpu_readings.length} CPU reading(s)${max})`}`);
    }
    console.log(`Active alerts: ${alertResults.length}`);
    console.log(`Dashboard: ${config.dashboard.enabled ? "enabled" : "disabled"}`);
    console.log("");
  }
}

let firstRun = true;

// Run immediately
collect();

// Then on interval
setInterval(collect, config.collection.interval_seconds * 1000);

process.on("SIGTERM", () => {
  console.log("[collector] Received SIGTERM, shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[collector] Received SIGINT, shutting down");
  process.exit(0);
});
