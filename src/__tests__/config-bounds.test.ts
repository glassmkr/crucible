import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const dirs: string[] = [];

function config(raw: string) {
  const dir = mkdtempSync(join(tmpdir(), "crucible-config-"));
  dirs.push(dir);
  const path = join(dir, "crucible.yaml");
  writeFileSync(path, raw);
  return () => loadConfig(path);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config bounds", () => {
  it.each([0, 65536, 9101.5])("rejects invalid Prometheus port %s", (port) => {
    expect(config(`prometheus:\n  enabled: true\n  port: ${port}\n`)).toThrow();
  });

  it("defaults Prometheus to loopback", () => {
    expect(config("prometheus:\n  enabled: true\n")().prometheus.address).toBe("127.0.0.1");
  });

  it("fills every omitted block with its shipped defaults", () => {
    // A block the operator leaves out must come back fully populated, never as
    // an empty object. zod 4's `.default({})` hands the literal back unparsed,
    // which leaves interval_seconds and every threshold undefined, and it still
    // type-checks once cast; the schema therefore uses `.prefault({})`. Nothing
    // else failed when that was tried during the zod 4 migration (2026-11-13).
    const loaded = config('server_name: "defaults-host"\n')();
    expect(loaded.collection).toEqual({
      interval_seconds: 300,
      ipmi: true,
      enforce_ipmitool_min_version: false,
      smart: true,
      thermal: true,
      dmi: true,
    });
    expect(loaded.dashboard).toEqual({
      enabled: false,
      url: "https://app.glassmkr.com",
      api_key: "",
      tls_pin: "",
      allow_insecure_endpoint: false,
      allowed_origins: [],
    });
    expect(loaded.thresholds).toEqual({
      ram_percent: 90,
      swap_alert: true,
      disk_percent: 85,
      iowait_percent: 20,
      nvme_wear_percent: 85,
      disk_latency_nvme_ms: 50,
      disk_latency_hdd_ms: 200,
      cpu_temp_warning_c: 80,
      cpu_temp_critical_c: 90,
      interface_utilization_percent: 90,
      acknowledge_disabled_detection: false,
    });
    expect(loaded.channels).toEqual({
      telegram: { enabled: false, bot_token: "", chat_id: "" },
      email: { enabled: false, to: "" },
      slack: { enabled: false, webhook_url: "" },
    });
    expect(loaded.prometheus).toEqual({ enabled: false, address: "127.0.0.1", port: 9101 });
  });

  it("rejects control characters in the Prometheus bind address", () => {
    expect(config('prometheus:\n  address: "127.0.0.1\\nInjected"\n')).toThrow();
  });

  it("rejects absurd threshold values", () => {
    expect(config("thresholds:\n  disk_latency_hdd_ms: 999999\n")).toThrow();
  });

  it("surfaces disabled detection as a flag instead of crash-looping a prev-valid config", () => {
    // disk_percent:100 disabled that alert on 0.14.5; it must keep loading on upgrade
    // (loadConfig throw == crash loop under Restart=always), surfaced via a flag.
    const loaded = config("thresholds:\n  disk_percent: 100\n")();
    expect(loaded.thresholds.disk_percent).toBe(100);
    expect(loaded.detection_disabled).toBe(true);
    // Acknowledged -> loads with no flag.
    const acked = config("thresholds:\n  disk_percent: 100\n  acknowledge_disabled_detection: true\n")();
    expect(acked.thresholds.disk_percent).toBe(100);
    expect(acked.detection_disabled).toBeUndefined();
  });

  it("allows swap alerts to be disabled without a global detection acknowledgement", () => {
    expect(config("thresholds:\n  swap_alert: false\n")().thresholds.swap_alert).toBe(false);
  });
});
