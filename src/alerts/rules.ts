// Collector-side alert rules. Currently 23 rules covering RAM/swap/disk,
// CPU, SMART, RAID, network, IPMI thermal/ECC/PSU/SEL/fan, and security.
// Dashboard runs an additional set of server-side rules on top of these
// (predictive, fleet-wide). See RULES_COUNT.md (TBD) for the canonical
// customer-facing total.
//
// When you add or remove a rule, also update:
//   - RULE_AUDIT.md (one section per rule)
//   - the count in this header comment

import type { Snapshot, AlertResult } from "../lib/types.js";
import type { Config } from "../config.js";
import { isPsuSensor, classifyPsuSensorBitmask } from "../lib/vendor-sensors.js";

/**
 * True iff a sensor reading is a temperature reading. Mirrors the
 * helper in Dashboard's evaluator so both sides agree. Defensive against
 * case differences and the SI "degrees C" spelling. Without this
 * gate, the cpu_temperature_high IPMI fallback would false-fire on
 * any sensor whose name contained "cpu" or "temp" (e.g. CPU_FAN at
 * 2000 RPM would alert as 2000°C critical).
 */
function isTemperatureSensor(s: { unit?: string }): boolean {
  const u = (s.unit ?? "").trim();
  return (
    u === "C" ||
    u === "°C" ||
    /^degrees?\s*c$/i.test(u) ||
    /^deg(\s|ree)?\s*c$/i.test(u)
  );
}

export interface AlertRule {
  type: string;
  evaluate(snap: Snapshot, thresholds: Config["thresholds"]): AlertResult[];
}

/**
 * Stable, ordered list of every rule ID this collector ships. Exported as
 * a public API so downstream tooling (Glassmkr's drift validator, Dashboard's
 * UI registry) can verify both sides agree on what exists. When you add
 * or remove a rule, this list updates automatically — but RULES.json in
 * the Glassmkr monorepo is hand-maintained and must be updated separately.
 */
export const ALL_RULE_IDS: readonly string[] = [
  "ram_high", "swap_high", "disk_space_high", "cpu_iowait_high", "oom_kills",
  "smart_failing", "nvme_wear_high", "raid_degraded", "disk_latency_high",
  "interface_errors", "link_speed_mismatch", "interface_saturation",
  "cpu_temperature_high", "ecc_errors", "psu_redundancy_loss",
  "ipmi_sel_critical", "ipmi_fan_failure",
  "ssh_root_password", "ssh_config_unapplied", "no_firewall", "pending_security_updates",
  "kernel_vulnerabilities", "kernel_needs_reboot", "unattended_upgrades_disabled",
] as const;

export const allRules: AlertRule[] = [
  // 1. RAM high
  { type: "ram_high", evaluate(snap, t) {
    if (!snap.memory?.total_mb) return [];
    const pct = (snap.memory.used_mb / snap.memory.total_mb) * 100;
    if (pct < (t.ram_percent ?? 90)) return [];
    return [{ type: "ram_high", severity: pct >= 95 ? "critical" : "warning",
      title: `RAM usage at ${pct.toFixed(1)}%`,
      message: `Using ${snap.memory.used_mb}MB of ${snap.memory.total_mb}MB. ${snap.memory.available_mb}MB available.`,
      evidence: { used_mb: snap.memory.used_mb, total_mb: snap.memory.total_mb, percent: Math.round(pct * 10) / 10 },
      recommendation: "Check: ps aux --sort=-rss | head -20" }];
  }},
  // 2. Swap active
  { type: "swap_high", evaluate(snap, t) {
    if (t.swap_alert === false || !snap.memory || snap.memory.swap_used_mb <= 0) return [];
    return [{ type: "swap_high", severity: "warning", title: `Swap in use: ${snap.memory.swap_used_mb}MB`,
      message: "Server is using swap space, indicating memory pressure.",
      evidence: { swap_used_mb: snap.memory.swap_used_mb },
      recommendation: "Check: free -h && ps aux --sort=-rss | head -20" }];
  }},
  // 3. Disk space high
  { type: "disk_space_high", evaluate(snap, t) {
    if (!snap.disks) return [];
    const threshold = t.disk_percent ?? 85;
    return snap.disks.filter(d => d.percent_used >= threshold).map(d => ({
      type: "disk_space_high", severity: d.percent_used >= 95 ? "critical" as const : "warning" as const,
      title: `Disk ${d.mount} at ${d.percent_used}%`,
      message: `${d.device}: ${d.used_gb}GB of ${d.total_gb}GB used. ${d.available_gb}GB available.`,
      evidence: { device: d.device, mount: d.mount, percent_used: d.percent_used },
      recommendation: "Check: du -sh /* | sort -rh | head -20" }));
  }},
  // 4. CPU iowait
  { type: "cpu_iowait_high", evaluate(snap, t) {
    if (!snap.cpu || snap.cpu.iowait_percent < (t.iowait_percent ?? 20)) return [];
    return [{ type: "cpu_iowait_high", severity: "warning", title: `CPU iowait at ${snap.cpu.iowait_percent.toFixed(1)}%`,
      message: `High I/O wait: CPU spending ${snap.cpu.iowait_percent.toFixed(1)}% waiting for disk.`,
      evidence: { iowait_percent: snap.cpu.iowait_percent },
      recommendation: "Check: iotop -oP or iostat -x 1 5" }];
  }},
  // 5. OOM kills
  { type: "oom_kills", evaluate(snap) {
    if (!snap.os_alerts || snap.os_alerts.oom_kills_recent <= 0) return [];
    return [{ type: "oom_kills", severity: "critical", title: `${snap.os_alerts.oom_kills_recent} OOM kill(s)`,
      message: `Kernel OOM killer terminated ${snap.os_alerts.oom_kills_recent} process(es).`,
      evidence: { oom_kills_recent: snap.os_alerts.oom_kills_recent },
      recommendation: "Check: dmesg | grep -i 'out of memory'" }];
  }},
  // 6. SMART failing
  { type: "smart_failing", evaluate(snap) {
    if (!snap.smart) return [];
    return snap.smart.filter(d => d.health !== "PASSED" || (d.reallocated_sectors && d.reallocated_sectors > 0) || (d.pending_sectors && d.pending_sectors > 0))
      .map(d => ({ type: "smart_failing", severity: "critical" as const,
        title: `SMART failure: ${d.device}`, message: `${d.model}: drive showing signs of failure.`,
        evidence: { device: d.device, health: d.health, reallocated_sectors: d.reallocated_sectors, pending_sectors: d.pending_sectors },
        recommendation: `Back up data. Schedule replacement for ${d.device}.` }));
  }},
  // 7. NVMe wear
  { type: "nvme_wear_high", evaluate(snap, t) {
    if (!snap.smart) return [];
    const threshold = t.nvme_wear_percent ?? 85;
    return snap.smart.filter(d => d.percentage_used != null && d.percentage_used >= threshold)
      .map(d => ({ type: "nvme_wear_high", severity: d.percentage_used! >= 95 ? "critical" as const : "warning" as const,
        title: `NVMe ${d.device} wear at ${d.percentage_used}%`, message: `${d.model} at ${d.percentage_used}% lifetime wear.`,
        evidence: { device: d.device, percentage_used: d.percentage_used },
        recommendation: "Plan drive replacement." }));
  }},
  // 8. RAID degraded
  { type: "raid_degraded", evaluate(snap) {
    if (!snap.raid) return [];
    return snap.raid.filter(r => r.degraded || r.failed_disks.length > 0)
      .map(r => ({ type: "raid_degraded", severity: "critical" as const,
        title: `RAID ${r.device} degraded`, message: `${r.device} (${r.level}) degraded. Failed: ${r.failed_disks.join(", ") || "unknown"}.`,
        evidence: { device: r.device, failed_disks: r.failed_disks },
        recommendation: "Replace failed drive immediately." }));
  }},
  // 9. Disk latency
  // Reads `snap.io_latency` (populated by `collectIoLatency` from /proc/diskstats
  // deltas), not `snap.disks` (which never had a latency field populated). The
  // pre-fix version of this rule referenced `d.latency_p99_ms` on `snap.disks`
  // and never fired on any host, ever.
  //
  // io-latency reports avg_read_latency_ms / avg_write_latency_ms over the
  // collection interval (not p99). We take max(read, write) per device and
  // compare against the per-class threshold:
  //   nvme*: t.disk_latency_nvme_ms (default 50ms)
  //   sd*/vd*/xvd*/md*: t.disk_latency_hdd_ms (default 200ms)
  // 50ms healthy NVMe is generous; SATA SSD and HDD use the 200ms bucket.
  { type: "disk_latency_high", evaluate(snap, t) {
    if (!snap.io_latency || snap.io_latency.length === 0) return [];
    const findings: AlertResult[] = [];
    for (const entry of snap.io_latency) {
      const r = entry.avg_read_latency_ms;
      const w = entry.avg_write_latency_ms;
      if (r == null && w == null) continue;
      // No samples this interval (read_iops + write_iops both 0): skip silently.
      if ((entry.read_iops ?? 0) === 0 && (entry.write_iops ?? 0) === 0) continue;
      const worst = Math.max(r ?? 0, w ?? 0);
      if (worst <= 0) continue;
      const isNvme = entry.device.startsWith("nvme");
      const thresh = isNvme ? (t.disk_latency_nvme_ms ?? 50) : (t.disk_latency_hdd_ms ?? 200);
      if (worst < thresh) continue;
      findings.push({
        type: "disk_latency_high", severity: "warning",
        title: `Disk ${entry.device} latency ${worst.toFixed(1)}ms`,
        message: `Average I/O latency on ${entry.device} is high (read ${r ?? 0}ms, write ${w ?? 0}ms over interval).`,
        evidence: {
          device: entry.device,
          avg_read_latency_ms: r,
          avg_write_latency_ms: w,
          read_iops: entry.read_iops,
          write_iops: entry.write_iops,
          threshold_ms: thresh,
        },
        recommendation: "Check: iotop -oP",
      });
    }
    return findings;
  }},
  // 10. Interface errors
  { type: "interface_errors", evaluate(snap) {
    if (!snap.network) return [];
    return snap.network.filter(i => (i.rx_errors + i.tx_errors + i.rx_drops + i.tx_drops) > 0)
      .map(i => ({ type: "interface_errors", severity: "warning" as const,
        title: `${i.interface}: errors/drops detected`,
        message: `RX errors=${i.rx_errors}, TX errors=${i.tx_errors}, RX drops=${i.rx_drops}, TX drops=${i.tx_drops}.`,
        evidence: { interface: i.interface, rx_errors: i.rx_errors, tx_errors: i.tx_errors, rx_drops: i.rx_drops, tx_drops: i.tx_drops },
        recommendation: "Check cables and SFP/transceiver." }));
  }},
  // 11. Link speed mismatch
  { type: "link_speed_mismatch", evaluate(snap) {
    if (!snap.network) return [];
    return snap.network.filter(i => i.speed_mbps > 0 && i.speed_mbps < 1000)
      .map(i => ({ type: "link_speed_mismatch", severity: "warning" as const,
        title: `${i.interface} at ${i.speed_mbps} Mbps`,
        message: `Interface negotiated below 1 Gbps.`,
        evidence: { interface: i.interface, speed_mbps: i.speed_mbps },
        recommendation: "Check cable, SFP, switch port config." }));
  }},
  // 12. Interface saturation
  { type: "interface_saturation", evaluate(snap, t) {
    if (!snap.network) return [];
    const threshold = (t.interface_utilization_percent ?? 90) / 100;
    return snap.network.filter(i => {
      if (!i.speed_mbps) return false;
      const maxBps = (i.speed_mbps * 1_000_000) / 8;
      return Math.max(i.rx_bytes_sec, i.tx_bytes_sec) / maxBps >= threshold;
    }).map(i => {
      const maxBps = (i.speed_mbps * 1_000_000) / 8;
      const util = Math.max(i.rx_bytes_sec, i.tx_bytes_sec) / maxBps * 100;
      return { type: "interface_saturation", severity: "warning" as const,
        title: `${i.interface} at ${util.toFixed(0)}% utilization`,
        message: `Interface ${i.interface} (${i.speed_mbps} Mbps) near saturation.`,
        evidence: { interface: i.interface, utilization_percent: Math.round(util * 10) / 10 },
        recommendation: "Check: iftop or nload" };
    });
  }},
  // 13. CPU temperature
  // Primary: /sys/class/hwmon (vendor-agnostic, works on Pi + Dell + everything).
  // Fallback: IPMI sensors with the historical "cpu" + "temp" substring filter,
  // used only when hwmon produced no usable CPU reading.
  { type: "cpu_temperature_high", evaluate(snap, t) {
    const warn = t.cpu_temp_warning_c ?? 80;
    const crit = t.cpu_temp_critical_c ?? 90;

    // Primary path: hwmon
    if (snap.thermal?.available && snap.thermal.cpu_readings.length > 0 && snap.thermal.max_cpu_celsius != null) {
      return snap.thermal.cpu_readings
        .filter(r => r.value_celsius >= warn)
        .map(r => ({
          type: "cpu_temperature_high",
          severity: r.value_celsius >= crit ? "critical" as const : "warning" as const,
          title: `${r.label}: ${r.value_celsius}°C`,
          message: `CPU temperature above warning threshold (${r.source} ${r.source_chip}).`,
          evidence: { sensor: r.label, value: r.value_celsius, source: r.source, chip: r.source_chip },
          recommendation: "Check cooling, fans, airflow.",
        }));
    }

    // Fallback path: IPMI sensors. Two gates required to fire:
    //   1. unit indicates temperature (degrees C). Without this a
    //      CPU_FAN sensor reading 2000 RPM would alert as critical.
    //   2. name contains "cpu" or "processor". Excludes ambient,
    //      inlet, PCH, DIMM, PSU sensors that happen to read in °C.
    if (!snap.ipmi?.available || !snap.ipmi.sensors) return [];
    const exclusions = ["ambient", "system", "pch", "inlet", "outlet", "exhaust", "psu", "dimm", "memory"];
    return snap.ipmi.sensors.filter(s => {
      if (!isTemperatureSensor(s)) return false;
      const n = s.name.toLowerCase();
      const isCpu = n.includes("cpu") || n.includes("processor");
      if (!isCpu) return false;
      if (exclusions.some(w => n.includes(w))) return false;
      const v = typeof s.value === "number" ? s.value : parseFloat(String(s.value));
      return !isNaN(v) && v >= warn;
    }).map(s => {
      const v = typeof s.value === "number" ? s.value : parseFloat(String(s.value));
      const sensorCrit = s.upper_critical ?? crit;
      return { type: "cpu_temperature_high", severity: v >= sensorCrit ? "critical" as const : "warning" as const,
        title: `${s.name}: ${v}${s.unit}`, message: `Temperature above warning threshold (IPMI sensor).`,
        evidence: { sensor: s.name, value: v, unit: s.unit, source: "ipmi" },
        recommendation: "Check cooling, fans, airflow." };
    });
  }},
  // 14. ECC errors
  // Reads max(named-sensor counts, SEL-derived counts). Dell iDRAC does
  // not expose ECC as named numeric sensors; SEL is the only signal.
  // Supermicro / HPE / ASRockRack expose them as named sensors.
  // Caveat: SEL counts are cumulative since last SEL clear, not rate.
  { type: "ecc_errors", evaluate(snap) {
    if (!snap.ipmi?.ecc_errors) return [];
    const named = snap.ipmi.ecc_errors;
    const sel = snap.ipmi.ecc_errors_from_sel ?? { correctable: 0, uncorrectable: 0, newest_event_timestamp: null };
    const correctable = Math.max(named.correctable, sel.correctable);
    const uncorrectable = Math.max(named.uncorrectable, sel.uncorrectable);
    if (correctable <= 0 && uncorrectable <= 0) return [];
    const sourceUsed = (sel.correctable > named.correctable || sel.uncorrectable > named.uncorrectable) ? "ipmi_sel" : "ipmi_sensors";
    const sourceLabel = sourceUsed === "ipmi_sel" ? "IPMI SEL events" : "IPMI named sensors";
    if (uncorrectable > 0) return [{ type: "ecc_errors", severity: "critical",
      title: `${uncorrectable} uncorrectable ECC error(s)`,
      message: `${uncorrectable} uncorrectable ECC error(s) from ${sourceLabel}. Data corruption possible. DIMM failing.`,
      evidence: { correctable, uncorrectable, source: sourceUsed, named, sel },
      recommendation: "Replace DIMM immediately. Run: ipmitool sel elist | grep -i memory" }];
    return [{ type: "ecc_errors", severity: "warning",
      title: `${correctable} correctable ECC error(s)`,
      message: `${correctable} correctable ECC error(s) from ${sourceLabel}. Early warning of DIMM failure.`,
      evidence: { correctable, uncorrectable, source: sourceUsed, named, sel },
      recommendation: "Schedule DIMM replacement. Run: ipmitool sel elist | grep -i memory" }];
  }},
  // 15. PSU redundancy
  // Two paths:
  //   A. Per-PSU status: filter individual PSU sensors via vendor-aware
  //      classifier (covers Supermicro `PSU1 Status`, HPE `Power Supply 1`,
  //      Dell `PS1 Status`). If 2+ PSUs and any has failed/absent, fire.
  //   B. Aggregate redundancy state (Dell `PS Redundancy` only today): if
  //      anything other than fully_redundant or unknown, fire — even when
  //      individual PS sensors look OK. This catches "redundancy degraded"
  //      cases the per-PSU path would miss.
  { type: "psu_redundancy_loss", evaluate(snap) {
    if (!snap.ipmi?.available) return [];
    const vendor = snap.dmi?.vendor ?? "generic";

    // Path B: aggregate redundancy state
    const redundancyState = snap.ipmi.psu_redundancy_state;
    if (redundancyState && redundancyState !== "fully_redundant" && redundancyState !== "unknown") {
      return [{ type: "psu_redundancy_loss", severity: "critical",
        title: "PSU redundancy lost",
        message: `BMC reports redundancy state: ${redundancyState.replace(/_/g, " ")}.`,
        evidence: { redundancy_state: redundancyState, source: "aggregate_sensor", vendor },
        recommendation: "Replace failed PSU. Check power connections and BMC `ipmitool chassis status`." }];
    }

    // Path A: per-PSU sensor status
    if (!snap.ipmi.sensors) return [];
    const psus = snap.ipmi.sensors.filter(s => isPsuSensor(s.name, vendor));
    if (psus.length < 2) return [];
    // ipmitool reports discrete states three ways and the 0.8.0/0.9.x
    // implementation only handled the first two:
    //   1. text values like "Failure detected" / "Absent" in the
    //      value or status column.
    //   2. short status codes "cr" (critical) / "nr" (non-recoverable)
    //      added in the 0.8.0 P1 follow-up.
    //   3. hex bitmask in the Reading column for IPMI sensor type 0x08
    //      (Power Supply). Crucible was missing this path entirely, so
    //      BMCs that report discrete states via the spec-defined hex
    //      bits (Supermicro, Gigabyte, ASRockRack on the validation
    //      fleet) produced no per-PSU alerts even when bit 1 (Failure
    //      detected) or bit 3 (AC lost) was asserted. glassmkr#29.
    //
    // The bitmask classifier in vendor-sensors.ts uses the IPMI 2.0
    // spec for sensor type 0x08 and prefers under-report over
    // over-report on ambiguous Reading=0x0 + mask without presence bit.
    const failed = psus.filter(s => {
      const st = String(s.status).toLowerCase().trim();
      const v = String(s.value).toLowerCase();
      if (st === "cr" || st === "nr") return true;
      if (st.includes("fail") || st.includes("absent")) return true;
      if (v.includes("fail") || v.includes("absent")) return true;
      // Hex bitmask path. status carries the BMC's assertion mask for
      // discrete sensors; value is the current Reading.
      const bit = classifyPsuSensorBitmask(String(s.value), String(s.status), vendor);
      return bit === "failed" || bit === "ac_lost" || bit === "absent";
    });
    if (failed.length === 0) return [];
    return [{ type: "psu_redundancy_loss", severity: "critical",
      title: "PSU redundancy lost",
      message: `${failed.length} PSU(s) failed/absent: ${failed.map(p => p.name).join(", ")}.`,
      evidence: { failed: failed.map(p => ({ name: p.name, status: p.status, value: p.value })), source: "per_psu_sensors", vendor },
      recommendation: "Replace failed PSU. Check power connections." }];
  }},
  // 19. IPMI SEL critical events
  { type: "ipmi_sel_critical", evaluate(snap) {
    if (!snap.ipmi?.available || !snap.ipmi.sel_events_recent?.length) return [];
    const critical = snap.ipmi.sel_events_recent.filter(e => e.severity === "critical" && e.direction === "Asserted");
    if (critical.length === 0) return [];
    const byType: Record<string, typeof critical> = {};
    for (const e of critical) { if (!byType[e.sensor_type]) byType[e.sensor_type] = []; byType[e.sensor_type].push(e); }
    const details = Object.entries(byType).map(([t, evts]) => `${t}: ${evts.map(e => `${e.sensor}: ${e.event}`).join(", ")}`).join("; ");
    const recs: string[] = [];
    if (byType.memory) recs.push("Memory errors: identify slot with `ipmitool sel elist | grep -i memory`. Schedule DIMM replacement.");
    if (byType.power) recs.push("PSU event: check physical PSU and connections. Verify redundancy: `ipmitool chassis status`.");
    if (byType.watchdog) recs.push("Watchdog reset: OS or BMC became unresponsive. Check dmesg for root cause.");
    if (byType.processor) recs.push("CPU event: check for thermal throttling or MCE. Run `dmesg | grep -i mce`.");
    if (recs.length === 0) recs.push("Review full SEL: `ipmitool sel elist`.");
    return [{ type: "ipmi_sel_critical", severity: "critical",
      title: `IPMI: ${critical.length} critical hardware event(s)`,
      message: `BMC System Event Log: ${critical.length} critical event(s). ${details}`,
      evidence: { critical_events: critical, sensor_types: Object.keys(byType) },
      recommendation: recs.join(" ") }];
  }},
  // 20. Fan failure
  { type: "ipmi_fan_failure", evaluate(snap) {
    if (!snap.ipmi?.available || !snap.ipmi.fans?.length) return [];
    const failed = snap.ipmi.fans.filter(f => f.status === "critical" || (f.rpm === 0 && f.status !== "absent"));
    if (failed.length === 0) return [];
    const total = snap.ipmi.fans.filter(f => f.status !== "absent").length;
    const names = failed.map(f => `${f.name} (${f.rpm} RPM)`).join(", ");
    return [{ type: "ipmi_fan_failure", severity: "critical",
      title: `Fan failure: ${failed.length} of ${total} fans`,
      message: `${failed.length} fan(s) stopped or critically slow: ${names}. Reduced cooling capacity.`,
      evidence: { failed_fans: failed, total_fans: total, all_fans: snap.ipmi.fans.filter(f => f.status !== "absent") },
      recommendation: "Check physical fans. Monitor temps: `ipmitool sdr type Temperature`. Replace failed fan module." }];
  }},
  // === Security (7) ===
  // 21. SSH root password login
  { type: "ssh_root_password", evaluate(snap) {
    if (!snap.security?.ssh?.rootPasswordExposed) return [];
    return [{ type: "ssh_root_password", severity: "warning",
      title: "SSH root login with password enabled",
      message: `PermitRootLogin is "${snap.security.ssh.permitRootLogin}" and PasswordAuthentication is "${snap.security.ssh.passwordAuthentication}". Root can be brute-forced over SSH.`,
      evidence: { permitRootLogin: snap.security.ssh.permitRootLogin, passwordAuthentication: snap.security.ssh.passwordAuthentication },
      recommendation: 'Set "PermitRootLogin prohibit-password" in /etc/ssh/sshd_config and restart sshd. Key-based root login still works.' }];
  }},
  // 21b. SSH config edited but not reloaded. The security fields above are
  // read from `sshd -T` (the on-disk config), NOT the running daemon, so a
  // fix that isn't reloaded would silently clear ssh_root_password while the
  // box stays exposed. This fires until the daemon reloads/restarts, so the
  // host is never reported all-clear on a staged-but-unapplied SSH change.
  // configApplied defaults to true when undeterminable (and is absent on
  // pre-0.13.16 snapshots), so this never false-fires.
  { type: "ssh_config_unapplied", evaluate(snap) {
    const ssh = snap.security?.ssh;
    if (!ssh || ssh.configApplied !== false) return [];
    return [{ type: "ssh_config_unapplied", severity: "warning" as const,
      title: "SSH config changed but not applied",
      message: "sshd_config was modified after the sshd daemon last loaded its configuration. The running daemon is still using the previous config, so any change (including security hardening) is not yet in effect.",
      evidence: { permitRootLogin: ssh.permitRootLogin, passwordAuthentication: ssh.passwordAuthentication, configMtime: ssh.configMtime ?? null, configLoadedAt: ssh.configLoadedAt ?? null },
      recommendation: 'Validate and apply: "sudo sshd -t && sudo systemctl reload ssh" (Debian/Ubuntu) or "... reload sshd" (RHEL). Existing sessions are unaffected.' }];
  }},
  // 22. No firewall
  { type: "no_firewall", evaluate(snap) {
    if (!snap.security || snap.security.firewall.active) return [];
    return [{ type: "no_firewall", severity: "warning" as const,
      title: "No firewall active",
      message: "No active firewall rules detected (checked UFW, firewalld, nftables, iptables). All ports are exposed unless protected by network-level ACLs.",
      evidence: { source: snap.security.firewall.source },
      recommendation: 'Enable a firewall: "sudo ufw enable" (Debian/Ubuntu) or "sudo systemctl start firewalld" (RHEL/Rocky).' }];
  }},
  // 23. Pending security updates
  { type: "pending_security_updates", evaluate(snap) {
    if (!snap.security?.pending_updates?.available) return [];
    const maxPending = 10;
    if (snap.security.pending_updates.pendingCount <= maxPending) return [];
    const d = snap.security.pending_updates;
    return [{ type: "pending_security_updates", severity: "warning",
      title: `${d.pendingCount} security updates pending`,
      message: `${d.pendingCount} security updates pending on this ${d.distro} server.`,
      evidence: { pendingCount: d.pendingCount, distro: d.distro },
      recommendation: d.distro === "ubuntu" || d.distro === "debian" ? 'Apply with: "sudo apt-get upgrade"' : 'Apply with: "sudo dnf update --security"' }];
  }},
  // 24. Kernel vulnerabilities
  { type: "kernel_vulnerabilities", evaluate(snap) {
    if (!snap.security?.kernel_vulns?.length) return [];
    const unmitigated = snap.security.kernel_vulns.filter(v => !v.mitigated);
    if (unmitigated.length === 0) return [];
    const details = unmitigated.map(v => `${v.name}: ${v.status}`).join("; ");
    return [{ type: "kernel_vulnerabilities", severity: "warning",
      title: `${unmitigated.length} CPU vulnerability mitigations missing`,
      message: `Unmitigated: ${details}. Update the kernel and CPU microcode to apply mitigations.`,
      evidence: { unmitigated, total: snap.security.kernel_vulns.length },
      recommendation: 'Check: "grep . /sys/devices/system/cpu/vulnerabilities/*". Update kernel and microcode packages.' }];
  }},
  // 25. Kernel needs reboot
  { type: "kernel_needs_reboot", evaluate(snap) {
    if (!snap.security?.kernel_reboot?.needsReboot) return [];
    const k = snap.security.kernel_reboot;
    return [{ type: "kernel_needs_reboot", severity: "warning" as const,
      title: "Reboot required for kernel update",
      message: `Running kernel: ${k.running}. Installed kernel: ${k.installed}. A reboot is needed to apply the newer kernel.`,
      evidence: { running: k.running, installed: k.installed },
      recommendation: "Schedule a reboot to apply the newer kernel. Security patches may not be active until then." }];
  }},
  // 26. Unattended upgrades disabled
  { type: "unattended_upgrades_disabled", evaluate(snap) {
    if (!snap.security || snap.security.auto_updates.configured) return [];
    const a = snap.security.auto_updates;
    const hint = a.mechanism === "unattended-upgrades" ? 'Enable: "sudo dpkg-reconfigure -plow unattended-upgrades"'
      : a.mechanism === "dnf-automatic" ? 'Enable: "sudo systemctl enable --now dnf-automatic-install.timer"'
      : 'Install: "sudo apt install unattended-upgrades" (Debian/Ubuntu) or "sudo dnf install dnf-automatic" (RHEL/Rocky)';
    return [{ type: "unattended_upgrades_disabled", severity: "warning" as const,
      title: "Automatic security updates not configured",
      message: `${a.details}. Without automatic updates, security patches must be applied manually.`,
      evidence: { mechanism: a.mechanism, details: a.details },
      recommendation: hint }];
  }},
];
