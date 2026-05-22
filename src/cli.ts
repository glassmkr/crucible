// CLI argument handling for the Crucible binary. Runs before any config load
// or collector initialization so --version and --help exit cleanly even when
// the config file is missing or the host lacks the tools the collectors need.

import * as fs from "node:fs";

export type CliMode = "version" | "help" | "run" | "mark-reboot" | "reboot" | "init" | "doctor-ipmi";

export interface CliArgs {
  mode: CliMode;
  configPath: string;
  reason?: string;
  ttl?: string; // raw duration string, parsed by caller
  init?: InitFlags;
}

export interface InitFlags {
  apiKey?: string;
  name?: string;
  ingestUrl?: string;
  configPath?: string;
  noStart: boolean;
  force: boolean;
  noVerify: boolean;
}

// Canonical config path as of v0.13.5. Renamed from collector.yaml to
// crucible.yaml to match the product naming (the agent has been named
// "Crucible" since v0.10; the config-file rename was the last piece of
// the half-finished rename). Existing installs with collector.yaml on
// disk continue to work via LEGACY_CONFIG_PATH fallback in the run-mode
// path below, and `init` auto-migrates the file when invoked.
export const DEFAULT_CONFIG_PATH = "/etc/glassmkr/crucible.yaml";
export const LEGACY_CONFIG_PATH = "/etc/glassmkr/collector.yaml";

export function parseCliArgs(argv: string[], version: string): { result: CliArgs; output: string | null } {
  // argv is typically process.argv.slice(2)
  let configPath = DEFAULT_CONFIG_PATH;

  // Subcommand dispatch: `init` takes its own flag set.
  if (argv[0] === "init") {
    const flags: InitFlags = { noStart: false, force: false, noVerify: false };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") {
        return { result: { mode: "help", configPath: "" }, output: initHelp(version) };
      }
      if (a === "--api-key") { flags.apiKey = argv[++i]; continue; }
      if (a.startsWith("--api-key=")) { flags.apiKey = a.slice("--api-key=".length); continue; }
      if (a === "--name") { flags.name = argv[++i]; continue; }
      if (a.startsWith("--name=")) { flags.name = a.slice("--name=".length); continue; }
      if (a === "--ingest-url") { flags.ingestUrl = argv[++i]; continue; }
      if (a.startsWith("--ingest-url=")) { flags.ingestUrl = a.slice("--ingest-url=".length); continue; }
      if (a === "--config-path") { flags.configPath = argv[++i]; continue; }
      if (a.startsWith("--config-path=")) { flags.configPath = a.slice("--config-path=".length); continue; }
      if (a === "--no-start") { flags.noStart = true; continue; }
      if (a === "--force") { flags.force = true; continue; }
      if (a === "--no-verify") { flags.noVerify = true; continue; }
    }
    return { result: { mode: "init", configPath: "", init: flags }, output: null };
  }

  // Subcommand dispatch: `doctor <topic>` — read-only diagnostic.
  // Currently only `doctor ipmi` is implemented; placeholder for future
  // topics (security, network) without changing the CLI shape.
  if (argv[0] === "doctor") {
    if (argv[1] === "--help" || argv[1] === "-h") {
      return { result: { mode: "help", configPath: "" }, output: doctorHelp(version) };
    }
    if (argv[1] === "ipmi") {
      return { result: { mode: "doctor-ipmi", configPath: "" }, output: null };
    }
    return {
      result: { mode: "help", configPath: "" },
      output: `glassmkr-crucible doctor: missing or unknown topic '${argv[1] ?? ""}'. See 'glassmkr-crucible doctor --help'.`,
    };
  }

  // Subcommand dispatch: `mark-reboot` and `reboot` take their own flags
  // (--reason, --ttl) but re-use --help.
  if (argv[0] === "mark-reboot" || argv[0] === "reboot") {
    const mode: "mark-reboot" | "reboot" = argv[0];
    let reason: string | undefined;
    let ttl: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") {
        return { result: { mode: "help", configPath: "" }, output: subcommandHelp(mode, version) };
      }
      if (a === "--reason") { reason = argv[++i]; continue; }
      if (a.startsWith("--reason=")) { reason = a.slice("--reason=".length); continue; }
      if (a === "--ttl") { ttl = argv[++i]; continue; }
      if (a.startsWith("--ttl=")) { ttl = a.slice("--ttl=".length); continue; }
    }
    return { result: { mode, configPath: "", reason, ttl }, output: null };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      return { result: { mode: "version", configPath: "" }, output: `glassmkr-crucible v${version}` };
    }
    if (arg === "--help" || arg === "-h") {
      return { result: { mode: "help", configPath: "" }, output: helpText(version) };
    }
    // -c <path> or --config <path>
    if (arg === "-c" || arg === "--config") {
      const next = argv[i + 1];
      if (next) {
        configPath = next;
        i++;
      }
      continue;
    }
    // --config=<path>
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    // Legacy positional argument: first non-flag token
    if (!arg.startsWith("-")) {
      configPath = arg;
    }
  }

  return { result: { mode: "run", configPath }, output: null };
}

/**
 * If the caller did not pass an explicit --config and the default config
 * path does not exist but the legacy /etc/glassmkr/collector.yaml does,
 * transparently fall back to the legacy path and emit a one-line warn.
 *
 * Pure with respect to its IO injection (so tests can drive it without
 * touching the real filesystem). index.ts wires the default fs + console.
 */
export interface ConfigFallbackDeps {
  existsSync: (p: string) => boolean;
  warn: (msg: string) => void;
}

export function resolveConfigPathWithLegacyFallback(
  configPath: string,
  deps: ConfigFallbackDeps = { existsSync: fs.existsSync, warn: (m) => console.warn(m) },
): string {
  if (configPath !== DEFAULT_CONFIG_PATH) return configPath;
  if (deps.existsSync(DEFAULT_CONFIG_PATH)) return configPath;
  if (!deps.existsSync(LEGACY_CONFIG_PATH)) return configPath;
  deps.warn(
    `[crucible] Using legacy config path ${LEGACY_CONFIG_PATH}; run 'glassmkr-crucible init' to migrate to ${DEFAULT_CONFIG_PATH}`,
  );
  return LEGACY_CONFIG_PATH;
}

export function helpText(version: string): string {
  return [
    `glassmkr-crucible v${version} - Bare metal server monitoring agent`,
    "",
    "Usage:",
    "  glassmkr-crucible [options]",
    "  glassmkr-crucible init        --api-key <K> [--name <N>] [--ingest-url <U>] [--no-start] [--force]",
    "  glassmkr-crucible mark-reboot [--reason TEXT] [--ttl DURATION]",
    "  glassmkr-crucible reboot      [--reason TEXT] [--ttl DURATION]",
    "  glassmkr-crucible doctor ipmi",
    "",
    "Options:",
    "  -v, --version    Print version and exit",
    "  -h, --help       Print this help and exit",
    `  -c, --config     Path to config file (default: ${DEFAULT_CONFIG_PATH})`,
    "",
    "Subcommands:",
    "  init             First-run setup: validate API key, write",
    "                   crucible.yaml + systemd unit, enable service.",
    "                   See 'glassmkr-crucible init --help'.",
    "  mark-reboot      Write a planned-reboot marker so the next boot",
    "                   does not fire `server_rebooted_unexpectedly`.",
    "                   You run the reboot yourself afterwards.",
    "  reboot           Write the marker, then invoke `systemctl reboot`.",
    "  doctor ipmi      Read-only IPMI capability check with actionable",
    "                   fix guidance for each failure mode (e.g. ipmitool",
    "                   not installed, kernel modules missing, BMC busy).",
    "",
    "Without options, starts the collector daemon using the config file.",
    "Docs: https://github.com/glassmkr/crucible",
  ].join("\n");
}

export function initHelp(version: string): string {
  return [
    `glassmkr-crucible init - first-run setup wizard`,
    "",
    "Usage:",
    "  glassmkr-crucible init --api-key <KEY> [options]",
    "  glassmkr-crucible init --api-key - [options]   # read key from stdin",
    "",
    "Required:",
    "  --api-key <KEY>     gmk_cru_live_<...>_<4> or col_<hex>. Use - to read from stdin.",
    "",
    "Options:",
    "  --name <NAME>       Server name in the Glassmkr dashboard. Defaults to the host's hostname.",
    "  --ingest-url <URL>  Ingest endpoint (default: https://app.glassmkr.com/api/v1/ingest).",
    "  --config-path <P>   Where to write crucible.yaml (default: /etc/glassmkr/crucible.yaml).",
    "  --no-start          Write config + unit, daemon-reload, but do not enable/start the service.",
    "  --force             Overwrite an existing config file.",
    "  --no-verify         Skip the connectivity probe against the ingest endpoint.",
    "  -h, --help          Print this help and exit.",
    "",
    "What this does:",
    "  1. Validates the api key format and (unless --no-verify) checks it against the ingest endpoint.",
    "  2. Writes /etc/glassmkr/crucible.yaml (mode 0600). If a legacy",
    "     /etc/glassmkr/collector.yaml exists, it is renamed to the new",
    "     path before write (lossless migration).",
    "  3. Writes /etc/systemd/system/glassmkr-crucible.service (mode 0644) with",
    "     ExecStart pointing at the dynamically-detected binary path.",
    "  4. Runs systemctl daemon-reload.",
    "  5. Unless --no-start, runs systemctl enable --now glassmkr-crucible.",
    "",
    "Requires root for the filesystem and systemd writes (sudo).",
    `v${version}`,
  ].join("\n");
}

function doctorHelp(version: string): string {
  return [
    `glassmkr-crucible doctor - read-only diagnostic`,
    "",
    "Usage:",
    "  glassmkr-crucible doctor ipmi    Diagnose IPMI capability + show fixes",
    "",
    "Each topic runs the same probes the agent uses internally and prints",
    "structured output plus actionable per-failure-mode guidance. The",
    "command never modifies system state.",
    `v${version}`,
  ].join("\n");
}

function subcommandHelp(mode: "mark-reboot" | "reboot", version: string): string {
  const action = mode === "reboot"
    ? "Write a planned-reboot marker and invoke `systemctl reboot`."
    : "Write a planned-reboot marker; operator triggers the reboot.";
  return [
    `glassmkr-crucible ${mode} - ${action}`,
    "",
    "Usage:",
    `  glassmkr-crucible ${mode} [--reason TEXT] [--ttl DURATION]`,
    "",
    "Options:",
    '  --reason TEXT    Free-text reason (e.g. "kernel update")',
    "  --ttl DURATION   Expiry window; e.g. 5m, 10m, 1h (default 10m)",
    "",
    `Marker path: /var/lib/crucible/reboot-expected (requires root).`,
    `v${version}`,
  ].join("\n");
}
