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

  it("rejects control characters in the Prometheus bind address", () => {
    expect(config('prometheus:\n  address: "127.0.0.1\\nInjected"\n')).toThrow();
  });

  it("rejects absurd threshold values", () => {
    expect(config("thresholds:\n  disk_latency_hdd_ms: 999999\n")).toThrow();
  });

  it("requires acknowledgement when practical detection is disabled", () => {
    expect(config("thresholds:\n  disk_percent: 100\n")).toThrow(/acknowledge_disabled_detection/);
    expect(config("thresholds:\n  disk_percent: 100\n  acknowledge_disabled_detection: true\n")().thresholds.disk_percent).toBe(100);
  });

  it("allows swap alerts to be disabled without a global detection acknowledgement", () => {
    expect(config("thresholds:\n  swap_alert: false\n")().thresholds.swap_alert).toBe(false);
  });
});
