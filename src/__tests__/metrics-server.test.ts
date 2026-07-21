import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { escapePrometheusLabel, formatPrometheus, installMetricsServerErrorHandler, startMetricsServer } from "../metrics-server.js";
import type { Snapshot } from "../lib/types.js";

describe("Prometheus output hardening", () => {
  it("escapes backslashes, quotes, and newlines in labels", () => {
    expect(escapePrometheusLabel('disk\\name"\nnext')).toBe('disk\\\\name\\"\\nnext');
  });

  it("replaces carriage returns and NUL bytes in labels", () => {
    expect(escapePrometheusLabel("before\rafter\0end")).toBe("before after end");
  });

  it("serializes hostile disk, device, model, interface, and sensor labels safely", () => {
    const hostile = 'bad"\\\nlabel';
    const snapshot = {
      cpu: { user_percent: 1, system_percent: 2, iowait_percent: 3, idle_percent: 94, load_1m: 1, load_5m: 1, load_15m: 1 },
      memory: { used_mb: 1, total_mb: 2, available_mb: 1, swap_used_mb: 0 },
      disks: [{ mount: hostile, device: hostile, percent_used: 1, total_gb: 2, used_gb: 1 }],
      network: [{ interface: hostile, rx_bytes_sec: 1, tx_bytes_sec: 2, rx_errors: 0, tx_errors: 0, speed_mbps: 1000 }],
      smart: [{ device: hostile, model: hostile, temperature_c: 20, percentage_used: null, reallocated_sectors: null }],
      ipmi: { available: true, sensors: [{ name: hostile, unit: hostile, value: 1 }], ecc_errors: null, fans: [{ name: hostile, status: hostile, rpm: 1000 }] },
      os_alerts: { oom_kills_recent: 0, zombie_processes: 0 },
    } as unknown as Snapshot;

    const output = formatPrometheus(snapshot);
    expect(output).not.toContain('bad"\\\nlabel');
    expect(output).toContain('bad\\"\\\\\\nlabel');
  });

  it("rejects a bad port without throwing", () => {
    const errors: Error[] = [];
    expect(startMetricsServer(70000, "127.0.0.1", (err) => errors.push(err))).toBeNull();
    expect(errors[0].message).toContain("invalid port");
  });

  it("routes EADDRINUSE through the listener error handler", () => {
    const server = new EventEmitter();
    const errors: Error[] = [];
    installMetricsServerErrorHandler(server as any, (err) => errors.push(err));
    server.emit("error", Object.assign(new Error("address already in use"), { code: "EADDRINUSE" }));
    expect(errors[0].message).toContain("address already in use");
  });
});
