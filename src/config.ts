import { lstatSync, readFileSync, type Stats } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  server_name: z.string().default("unnamed-server"),
  collection: z.object({
    interval_seconds: z.number().min(60).max(3600).default(300),
    ipmi: z.boolean().default(true),
    smart: z.boolean().default(true),
    thermal: z.boolean().default(true),
    dmi: z.boolean().default(true),
  }).default({}),
  dashboard: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default("https://app.glassmkr.com"),
    api_key: z.string().default(""),
    tls_pin: z.string().default(""),
  }).default({}),
  thresholds: z.object({
    ram_percent: z.number().default(90),
    swap_alert: z.boolean().default(true),
    disk_percent: z.number().default(85),
    iowait_percent: z.number().default(20),
    nvme_wear_percent: z.number().default(85),
    disk_latency_nvme_ms: z.number().default(50),
    disk_latency_hdd_ms: z.number().default(200),
    cpu_temp_warning_c: z.number().default(80),
    cpu_temp_critical_c: z.number().default(90),
    interface_utilization_percent: z.number().default(90),
  }).default({}),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(""),
      chat_id: z.string().default(""),
    }).default({}),
    email: z.object({
      enabled: z.boolean().default(false),
      to: z.string().default(""),
    }).default({}),
    slack: z.object({
      enabled: z.boolean().default(false),
      webhook_url: z.string().default(""),
    }).default({}),
  }).default({}),
  prometheus: z.object({
    enabled: z.boolean().default(false),
    port: z.number().default(9101),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function assertSecureConfigStat(path: string, stat: Pick<Stats, "uid" | "mode"> & {
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`[config] Refusing non-regular config file at ${path}`);
  }
  if (stat.uid !== 0) {
    throw new Error(`[config] Refusing config not owned by root at ${path} (uid=${stat.uid})`);
  }
  if ((stat.mode & 0o037) !== 0) {
    throw new Error(`[config] Refusing writable or world-accessible config at ${path} (mode=${(stat.mode & 0o777).toString(8)})`);
  }
}

export function loadConfig(path: string): Config {
  try {
    assertSecureConfigStat(path, lstatSync(path));
    const raw = readFileSync(path, "utf-8");
    const parsed = parse(raw);
    return ConfigSchema.parse(parsed);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`[config] No config file at ${path}, using defaults`);
      return ConfigSchema.parse({});
    }
    throw err;
  }
}
