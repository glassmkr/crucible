import { createServer } from "http";
import type { Snapshot } from "./lib/types.js";

let latestSnapshot: Snapshot | null = null;

export function updateMetrics(snapshot: Snapshot) {
  latestSnapshot = snapshot;
}

export function startMetricsServer(port: number) {
  const server = createServer((req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      if (!latestSnapshot) {
        res.writeHead(503);
        res.end("# No data collected yet\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(formatPrometheus(latestSnapshot));
    } else if (req.url === "/health") {
      res.writeHead(200);
      res.end("ok\n");
    } else {
      res.writeHead(404);
      res.end("Not found\n");
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[metrics] Prometheus endpoint listening on :${port}/metrics`);
  });
}

function formatPrometheus(snap: Snapshot): string {
  const lines: string[] = [];

  // CPU
  lines.push("# HELP glassmkr_cpu_user_percent CPU user utilization");
  lines.push("# TYPE glassmkr_cpu_user_percent gauge");
  lines.push(`glassmkr_cpu_user_percent ${snap.cpu.user_percent}`);
  lines.push(`glassmkr_cpu_system_percent ${snap.cpu.system_percent}`);
  lines.push(`glassmkr_cpu_iowait_percent ${snap.cpu.iowait_percent}`);
  lines.push(`glassmkr_cpu_idle_percent ${snap.cpu.idle_percent}`);
  lines.push(`glassmkr_load_1m ${snap.cpu.load_1m}`);
  lines.push(`glassmkr_load_5m ${snap.cpu.load_5m}`);
  lines.push(`glassmkr_load_15m ${snap.cpu.load_15m}`);

  // Memory
  lines.push("# HELP glassmkr_memory_used_mb Memory used in MB");
  lines.push("# TYPE glassmkr_memory_used_mb gauge");
  lines.push(`glassmkr_memory_used_mb ${snap.memory.used_mb}`);
  lines.push(`glassmkr_memory_total_mb ${snap.memory.total_mb}`);
  lines.push(`glassmkr_memory_available_mb ${snap.memory.available_mb}`);
  lines.push(`glassmkr_swap_used_mb ${snap.memory.swap_used_mb}`);

  // Disks
  lines.push("# HELP glassmkr_disk_used_percent Disk usage percentage");
  lines.push("# TYPE glassmkr_disk_used_percent gauge");
  for (const disk of snap.disks) {
    const labels = `mount="${disk.mount}",device="${disk.device}"`;
    lines.push(`glassmkr_disk_used_percent{${labels}} ${disk.percent_used}`);
    lines.push(`glassmkr_disk_total_gb{${labels}} ${disk.total_gb}`);
    lines.push(`glassmkr_disk_used_gb{${labels}} ${disk.used_gb}`);
  }

  // Network
  lines.push("# HELP glassmkr_net_rx_bytes_sec Network receive bytes per second");
  lines.push("# TYPE glassmkr_net_rx_bytes_sec gauge");
  for (const iface of snap.network) {
    const labels = `interface="${iface.interface}"`;
    lines.push(`glassmkr_net_rx_bytes_sec{${labels}} ${iface.rx_bytes_sec}`);
    lines.push(`glassmkr_net_tx_bytes_sec{${labels}} ${iface.tx_bytes_sec}`);
    lines.push(`glassmkr_net_rx_errors{${labels}} ${iface.rx_errors}`);
    lines.push(`glassmkr_net_tx_errors{${labels}} ${iface.tx_errors}`);
    lines.push(`glassmkr_net_speed_mbps{${labels}} ${iface.speed_mbps}`);
  }

  // SMART
  for (const drive of snap.smart) {
    const labels = `device="${drive.device}",model="${drive.model}"`;
    if (drive.temperature_c != null) lines.push(`glassmkr_smart_temperature_c{${labels}} ${drive.temperature_c}`);
    if (drive.percentage_used != null) lines.push(`glassmkr_smart_percentage_used{${labels}} ${drive.percentage_used}`);
    if (drive.reallocated_sectors != null) lines.push(`glassmkr_smart_reallocated_sectors{${labels}} ${drive.reallocated_sectors}`);
  }

  // IPMI
  if (snap.ipmi?.available) {
    for (const sensor of snap.ipmi.sensors) {
      if (typeof sensor.value === "number") {
        lines.push(`glassmkr_ipmi_sensor{sensor="${sensor.name}",unit="${sensor.unit}"} ${sensor.value}`);
      }
    }
    // ecc_errors is null when IPMI couldn't be probed at all (no
    // ipmitool / no /dev/ipmi0). Omit the Prometheus lines in that case
    // so scrapers don't record "0" as if it were a real measurement.
    if (snap.ipmi.ecc_errors) {
      lines.push(`glassmkr_ipmi_ecc_correctable ${snap.ipmi.ecc_errors.correctable}`);
      lines.push(`glassmkr_ipmi_ecc_uncorrectable ${snap.ipmi.ecc_errors.uncorrectable}`);
    }

    // Fans
    if (snap.ipmi.fans) {
      for (const fan of snap.ipmi.fans) {
        lines.push(`glassmkr_ipmi_fan_rpm{fan="${fan.name}",status="${fan.status}"} ${fan.rpm}`);
      }
    }
  }

  // OS alerts
  lines.push(`glassmkr_oom_kills_recent ${snap.os_alerts.oom_kills_recent}`);
  lines.push(`glassmkr_zombie_processes ${snap.os_alerts.zombie_processes}`);

  // Security
  if (snap.security) {
    lines.push(`glassmkr_ssh_root_password_exposed ${snap.security.ssh?.rootPasswordExposed ? 1 : 0}`);
    lines.push(`glassmkr_firewall_active ${snap.security.firewall.active ? 1 : 0}`);
    if (snap.security.pending_updates?.available) {
      lines.push(`glassmkr_pending_security_updates ${snap.security.pending_updates.pendingCount}`);
    }
    const unmitigated = snap.security.kernel_vulns.filter(v => !v.mitigated).length;
    lines.push(`glassmkr_kernel_vulns_unmitigated ${unmitigated}`);
    lines.push(`glassmkr_kernel_needs_reboot ${snap.security.kernel_reboot?.needsReboot ? 1 : 0}`);
    lines.push(`glassmkr_auto_updates_configured ${snap.security.auto_updates.configured ? 1 : 0}`);
  }

  return lines.join("\n") + "\n";
}
