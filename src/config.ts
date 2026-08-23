import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { z } from "zod";
import { normalizeAllowedOrigins, validateEndpoint } from "./lib/endpoint-policy.js";

const DashboardSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default("https://app.glassmkr.com"),
  api_key: z.string().default(""),
  tls_pin: z.string().default(""),
  allow_insecure_endpoint: z.boolean().default(false),
  allowed_origins: z.array(z.string()).default([]),
}).superRefine((value, ctx) => {
  try {
    validateEndpoint(value.url, {
      allowInsecure: value.allow_insecure_endpoint,
      allowedOrigins: normalizeAllowedOrigins(value.allowed_origins),
    });
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : String(err),
      path: ["url"],
    });
  }
});

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
});

type Thresholds = z.infer<typeof ThresholdSchema>;

// Thresholds pushed to their limits effectively disable detection. This is NOT a
// hard failure: configs accepted by earlier releases (e.g. a percent threshold set
// to 100 to silence an alert) must keep loading on upgrade instead of crash-looping
// the daemon under Restart=always. loadConfig surfaces this as a warning plus a
// snapshot flag unless the operator has explicitly acknowledged it.
export function thresholdsDisableDetection(t: Thresholds): boolean {
  return [t.ram_percent, t.disk_percent, t.iowait_percent, t.nvme_wear_percent, t.interface_utilization_percent].some((v) => v >= 100)
    || t.disk_latency_nvme_ms > 10_000
    || t.disk_latency_hdd_ms > 10_000
    || t.cpu_temp_warning_c > 110
    || t.cpu_temp_critical_c > 125;
}

const ConfigSchema = z.object({
  server_name: z.string().default("unnamed-server"),
  collection: z.object({
    interval_seconds: z.number().min(60).max(3600).default(300),
    ipmi: z.boolean().default(true),
    // Restores the pre-2026-07-29 fail-closed behaviour: refuse to collect IPMI
    // when `ipmitool -V` reads below 1.8.19 (CVE-2020-5208). Off by default
    // because that check cannot see distro backports, so it fires on suspicion
    // rather than evidence and silently disabled BMC monitoring on stock Ubuntu
    // 20.04/22.04 and RHEL-family 9. Turn it on if you model BMC compromise.
    enforce_ipmitool_min_version: z.boolean().default(false),
    smart: z.boolean().default(true),
    thermal: z.boolean().default(true),
    dmi: z.boolean().default(true),
  }).default({}),
  dashboard: DashboardSchema.default({}),
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
  detection_disabled?: true;
};

const warnedLegacyConfigPaths = new Set<string>();
const warnedDisabledDetectionPaths = new Set<string>();
const warnedUnknownKeyPaths = new Set<string>();

/**
 * Keys the operator wrote under `collection:` that the schema does not define.
 *
 * WHY. Zod object schemas STRIP unknown keys by default, so
 * `enforce_ipmitool_min_versions: true` (or any other near-miss) parses cleanly
 * and silently leaves the setting at its `false` default. That turns a typo into a
 * silently disabled security control, which an adversarial review flagged on
 * 2026-07-30 as finding #4.
 *
 * NOT `.strict()`, deliberately, though the review offered it as an option: a
 * strict parse throws, and a config that throws stops the agent from starting at
 * all. A host that goes silent is the worse failure here, and we have already lost
 * a box for 23 hours to exactly that shape of problem. A warning names the typo
 * without ever being able to take monitoring down.
 *
 * Exported for unit tests; pure.
 */
export function unknownCollectionKeys(rawCollection: unknown): string[] {
  if (!rawCollection || typeof rawCollection !== "object" || Array.isArray(rawCollection)) return [];
  const known = new Set(Object.keys(ConfigSchema.shape.collection.removeDefault().shape));
  return Object.keys(rawCollection as Record<string, unknown>).filter((k) => !known.has(k));
}

// Unwrap ZodDefault / ZodOptional / ZodEffects (superRefine) down to the
// object shape, or null for leaf schemas. Bounded loop: wrappers do not nest
// deeper than a few levels and a cycle here would be a schema bug.
function objectShapeOf(schema: unknown): Record<string, unknown> | null {
  let s: any = schema;
  for (let i = 0; i < 8 && s; i++) {
    if (typeof s.removeDefault === "function") { s = s.removeDefault(); continue; }
    if (s._def?.typeName === "ZodOptional" && typeof s.unwrap === "function") { s = s.unwrap(); continue; }
    if (s._def?.typeName === "ZodEffects" && s._def.schema) { s = s._def.schema; continue; }
    break;
  }
  return s?._def?.typeName === "ZodObject" ? s.shape : null;
}

/**
 * Every key the operator wrote, in any block, that the schema does not define.
 *
 * Generalizes unknownCollectionKeys to the whole file (v1 freeze review,
 * 2026-08-23): the typo-into-silent-default trap it closed for `collection:`
 * existed identically under `dashboard:`, `thresholds:`, `channels:`, and
 * `prometheus:`, and at the top level, where a stale 0.9.x `forge:` block was
 * silently stripped, which silently disables the dashboard push. Same design
 * choice as the original: warn, never throw (a config that stops the agent is
 * the worse failure). Exported for unit tests; pure.
 */
export function unknownConfigKeys(parsed: unknown): { block: string; keys: string[] }[] {
  const out: { block: string; keys: string[] }[] = [];
  const walk = (blockName: string, raw: unknown, schema: unknown) => {
    const shape = objectShapeOf(schema);
    if (!shape || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const known = new Set(Object.keys(shape));
    const stray = Object.keys(raw as Record<string, unknown>).filter((k) => !known.has(k));
    if (stray.length > 0) out.push({ block: blockName, keys: stray });
    for (const key of known) {
      const childName = blockName === "(top level)" ? key : `${blockName}.${key}`;
      walk(childName, (raw as Record<string, unknown>)[key], shape[key]);
    }
  };
  walk("(top level)", parsed, ConfigSchema);
  return out;
}

export function configLoadFailureMessage(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `[config] Refusing to start: ${path} failed integrity or schema validation: ${detail}`;
}

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

// Runs `ls -ldn <path>` and returns its stdout. The first whitespace token
// of that output is the symbolic mode; `ls` appends a trailing "+" to it when
// the file carries a POSIX ACL (works without the `acl` package / getfacl,
// which is absent on much of the fleet).
export type LsRunner = (path: string) => string;

const defaultLsRunner: LsRunner = (path) =>
  execFileSync("ls", ["-ldn", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export interface LoadConfigDeps {
  runLs: LsRunner;
}

const defaultLoadConfigDeps: LoadConfigDeps = { runLs: defaultLsRunner };

// fstat-based checks (assertSecureConfigStat) see only uid/mode, not the
// extended POSIX ACL. A config that is root:glassmkr 0640 but carries a named
// ACL (e.g. `user:leaktest:r--`) still leaks the API key to that user. init
// strips ACLs with `setfacl -b`; the runtime load must independently refuse
// an ACL'd config rather than trust that init ran. Fail closed: if `ls` cannot
// be run or its output is unparseable, refuse.
export function assertNoPosixAcl(path: string, runLs: LsRunner): void {
  let output: string;
  try {
    output = runLs(path);
  } catch (err) {
    throw new Error(`[config] Refusing config: cannot verify ACL state of ${path} via ls (${err instanceof Error ? err.message : String(err)})`);
  }
  const modeField = output.trim().split(/\s+/)[0];
  // A valid symbolic mode is 10 chars (type + 9 permission bits), with an
  // optional trailing "+" (ACL) or "." (SELinux context). Anything shorter is
  // unparseable; fail closed.
  if (!modeField || modeField.length < 10) {
    throw new Error(`[config] Refusing config: unparseable ls output while checking ACL state of ${path}`);
  }
  if (modeField.endsWith("+")) {
    throw new Error(`[config] Refusing config with a POSIX ACL at ${path} (ls mode ${modeField}); a named ACL can leak the API key. Strip it with 'setfacl -b ${path}' or re-run 'sudo glassmkr-crucible init'.`);
  }
}

export interface LoadConfigOptions {
  /**
   * Set when the operator named this path explicitly (a `--config` flag). A missing
   * file is then an ERROR rather than a cue to use defaults.
   *
   * Why this exists. Round 4's finding #6 made an UNREADABLE explicit config fatal,
   * but a MISSING one still slipped through, because the ENOENT branch below turns
   * any absent file into `ConfigSchema.parse({})` before the caller's error handling
   * ever sees it. So `doctor ipmi --config /typo.yaml` printed "using defaults",
   * probed with enforcement OFF, and exited 0, which is exactly the outcome an
   * operator who set `enforce_ipmitool_min_version: true` was trying to prevent. A
   * typo therefore silently disabled a security gate. Adversarial review round 5,
   * finding #2. The DEFAULT path keeps the ENOENT fallback: shipping without a config
   * file is a supported, documented install.
   */
  mustExist?: boolean;
}

export function loadConfig(
  path: string,
  deps: LoadConfigDeps = defaultLoadConfigDeps,
  opts: LoadConfigOptions = {},
): Config {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const migrationRequired = assertSecureConfigStat(path, fstatSync(fd));
    assertNoPosixAcl(path, deps.runLs);
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
    const strayBlocks = unknownConfigKeys(parsed);
    if (strayBlocks.length > 0 && !warnedUnknownKeyPaths.has(path)) {
      warnedUnknownKeyPaths.add(path);
      for (const { block, keys } of strayBlocks) {
        const where = block === "(top level)" ? "at the top level" : `under ${block}`;
        console.warn(
          `[config] WARNING: ignoring unknown key(s) ${where}: ${keys.join(", ")}. ` +
          "These were dropped, so any setting you expected them to change is still at its default. Check for a typo.",
        );
        if (block === "(top level)" && keys.includes("forge")) {
          console.warn(
            "[config] WARNING: a legacy `forge:` block was found and ignored; the dashboard push reads `dashboard:` " +
            "since v0.10. If this host stopped reporting, that is why. Re-run `sudo glassmkr-crucible init` or rename the block.",
          );
        }
      }
    }
    if (!config.thresholds.acknowledge_disabled_detection && thresholdsDisableDetection(config.thresholds)) {
      config.detection_disabled = true;
      if (!warnedDisabledDetectionPaths.has(path)) {
        warnedDisabledDetectionPaths.add(path);
        console.warn("[config] WARNING: thresholds effectively disable practical detection; set acknowledge_disabled_detection: true to silence this");
      }
    }
    return config;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      // "Cannot determine" must not collapse into "safe": an explicitly named file
      // that is not there tells us nothing about what the operator intended, so it
      // must not be answered with the shipped defaults.
      if (opts.mustExist) throw err;
      console.log(`[config] No config file at ${path}, using defaults`);
      return ConfigSchema.parse({});
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
