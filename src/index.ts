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
import { pushToForge, initForgeAgent } from "./push/forge.js";
import { collectSecurity, type SecurityData } from "./collect/security.js";
import { collectZfs } from "./collect/zfs.js";
import { collectIoErrors } from "./collect/io-errors.js";
import { collectIoLatency } from "./collect/io-latency.js";
import { collectConntrack } from "./collect/conntrack.js";
import { collectSystemd } from "./collect/systemd.js";
import { collectNtp } from "./collect/ntp.js";
import { collectFileDescriptors } from "./collect/fd.js";
import type { Snapshot, IpmiInfo } from "./lib/types.js";
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
console.log(`[collector] Forge: ${config.forge.enabled ? config.forge.url : "disabled"}`);
console.log(`[collector] Prometheus: ${config.prometheus.enabled ? `:${config.prometheus.port}/metrics` : "disabled"}`);

// Start Prometheus metrics server if enabled
if (config.prometheus.enabled) {
  startMetricsServer(config.prometheus.port);
}

// Initialize TLS pinning for Forge if configured
if (config.forge.tls_pin) {
  initForgeAgent(config.forge.tls_pin);
  console.log("[collector] TLS pinning enabled for Forge");
}

const emptyIpmi: IpmiInfo = { available: false, sensors: [], ecc_errors: { correctable: 0, uncorrectable: 0 }, sel_entries_count: 0, sel_events_recent: [], fans: [] };

// Security checks run once per hour (every 12th cycle at 5-min intervals)
let securityCycleCount = 0;
let cachedSecurity: SecurityData | undefined;

async function collect() {
  const startTime = Date.now();
  console.log(`[collector] Collecting...`);

  const [system, cpu, memory, disks, smart, network, raid, ipmi, osAlerts] = await Promise.all([
    collectSystem(),
    collectCpu(),
    collectMemory(),
    collectDisks(),
    config.collection.smart ? collectSmart() : Promise.resolve([]),
    collectNetwork(),
    collectRaid(),
    config.collection.ipmi ? collectIpmi() : Promise.resolve(emptyIpmi),
    collectOsAlerts(),
  ]);

  // Security checks: run once per hour, reuse cached data between runs
  securityCycleCount++;
  if (securityCycleCount >= 12 || !cachedSecurity) {
    securityCycleCount = 0;
    try { cachedSecurity = await collectSecurity(); } catch (err) { console.error("[security] Collection error:", err); }
  }

  const snapshot: Snapshot = {
    collector_version: PKG_VERSION,
    timestamp: new Date().toISOString(),
    system, cpu, memory, disks, smart, network, raid, ipmi, os_alerts: osAlerts,
    security: cachedSecurity,
  };

  // Single-shot: the very first snapshot after a marked reboot carries
  // the flag, subsequent snapshots do not.
  if (plannedRebootFlag && !plannedRebootConsumed) {
    (snapshot as any).expected_reboot = true;
    if (plannedRebootFlag.reason) (snapshot as any).expected_reboot_reason = plannedRebootFlag.reason;
    plannedRebootConsumed = true;
  }

  // ZFS and I/O errors: collect every cycle (lightweight checks)
  try { snapshot.zfs = await collectZfs() ?? undefined; } catch { /* skip if ZFS not available */ }
  try { snapshot.io_errors = await collectIoErrors() ?? undefined; } catch { /* skip on error */ }
  try { snapshot.io_latency = collectIoLatency(); } catch { /* skip on error */ }
  try { snapshot.conntrack = collectConntrack(); } catch { /* skip on error */ }
  try { snapshot.systemd = await collectSystemd(); } catch { /* skip on error */ }
  try { snapshot.ntp = await collectNtp(); } catch { /* skip on error */ }
  try { snapshot.file_descriptors = collectFileDescriptors(); } catch { /* skip on error */ }

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

  // Push to Forge (non-blocking)
  if (config.forge.enabled && config.forge.api_key) {
    pushToForge(config.forge.url, config.forge.api_key, snapshot);
  }

  // Check for updates (every 6 hours, non-blocking)
  checkForUpdates(config.forge.enabled ? config.forge.url : undefined);

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
    console.log(`Active alerts: ${alertResults.length}`);
    console.log(`Forge: ${config.forge.enabled ? "enabled" : "disabled"}`);
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
