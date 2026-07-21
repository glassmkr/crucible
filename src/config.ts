import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const percentThreshold = z.number().finite().min(1).max(100);
const ThresholdSchema = z.object({
  ram_percent: percentThreshold.default(90),
  swap_alert: z.boolean().default(true),
  disk_percent: percentThreshold.default(85),
  iowait_percent: percentThreshold.default(20),
  nvme_wear_percent: percentThreshold.default(85),
  disk_latency_nvme_ms: z.number().finite().min(1).max(60_000).default(50),
  disk_latency_hdd_ms: z.number().finite().min(1).max(60_000).default(200),
  cpu_temp_warning_c: z.number().finite().min(-50).max(150).default(80),
  cpu_temp_critical_c: z.number().finite().min(-50).max(150).default(90),
  interface_utilization_percent: percentThreshold.default(90),
  acknowledge_disabled_detection: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.cpu_temp_warning_c >= value.cpu_temp_critical_c) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cpu warning temperature must be below critical" });
  }
  if (value.acknowledge_disabled_detection) return;
  const disabled = [
    value.ram_percent,
    value.disk_percent,
    value.iowait_percent,
    value.nvme_wear_percent,
    value.interface_utilization_percent,
  ].some((threshold) => threshold >= 100)
    || value.disk_latency_nvme_ms > 10_000
    || value.disk_latency_hdd_ms > 10_000
    || value.cpu_temp_warning_c > 110
    || value.cpu_temp_critical_c > 125;
  if (disabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "thresholds can disable practical detection; set acknowledge_disabled_detection: true to accept this risk",
    });
  }
});

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
  thresholds: ThresholdSchema.default({}),
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
    address: z.string().min(1).max(253).regex(/^[A-Za-z0-9:._-]+$/).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(9101),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema> & {
  config_migration_required?: true;
};

const warnedLegacyConfigPaths = new Set<string>();

export function assertSecureConfigStat(path: string, stat: Pick<Stats, "uid" | "mode"> & {
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}, serviceUid = typeof process.getuid === "function" ? process.getuid() : -1): boolean {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`[config] Refusing non-regular config file at ${path}`);
  }
  if (stat.uid === 0) {
    if ((stat.mode & 0o037) !== 0) {
      throw new Error(`[config] Refusing writable or world-accessible config at ${path} (mode=${(stat.mode & 0o777).toString(8)})`);
    }
    return false;
  }
  if (stat.uid !== serviceUid) {
    throw new Error(`[config] Refusing config owned by unexpected uid at ${path} (uid=${stat.uid})`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`[config] Refusing group/other-writable config at ${path} (mode=${(stat.mode & 0o777).toString(8)})`);
  }
  return true;
}

export function loadConfig(path: string): Config {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const migrationRequired = assertSecureConfigStat(path, fstatSync(fd));
    const raw = readFileSync(fd, "utf-8");
    const parsed = parse(raw);
    const config = ConfigSchema.parse(parsed) as Config;
    if (migrationRequired) {
      config.config_migration_required = true;
      if (!warnedLegacyConfigPaths.has(path)) {
        warnedLegacyConfigPaths.add(path);
        console.warn("[config] WARNING: config is not yet root-owned; run `sudo glassmkr-crucible init` to complete the security migration");
      }
    }
    return config;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`[config] No config file at ${path}, using defaults`);
      return ConfigSchema.parse({});
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
