// CLI argument handling for the Crucible binary. Runs before any config load
// or collector initialization so --version and --help exit cleanly even when
// the config file is missing or the host lacks the tools the collectors need.

import * as fs from "node:fs";

export type CliMode = "version" | "help" | "run" | "mark-reboot" | "reboot" | "init" | "enroll" | "doctor-ipmi";

export interface CliArgs {
  mode: CliMode;
  configPath: string;
  reason?: string;
  ttl?: string; // raw duration string, parsed by caller
  init?: InitFlags;
  enroll?: EnrollFlags;
}

export interface InitFlags {
  apiKey?: string;
  name?: string;
  ingestUrl?: string;
  configPath?: string;
  noStart: boolean;
  force: boolean;
  noVerify: boolean;
  allowInsecureEndpoint: boolean;
  allowedEndpointOrigins?: string[];
}

export interface EnrollFlags {
  accountKey?: string;
  name?: string;
  dashboardUrl?: string;
  configPath?: string;
  tags?: string[];
  noStart: boolean;
  force: boolean;
  noVerify: boolean;
  allowInsecureEndpoint: boolean;
  allowedEndpointOrigins?: string[];
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
    const flags: InitFlags = { noStart: false, force: false, noVerify: false, allowInsecureEndpoint: false };
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
      if (a === "--allow-insecure-endpoint") { flags.allowInsecureEndpoint = true; continue; }
      if (a === "--allow-endpoint-origin") {
        flags.allowedEndpointOrigins = [...(flags.allowedEndpointOrigins ?? []), argv[++i]];
        continue;
      }
      if (a.startsWith("--allow-endpoint-origin=")) {
        flags.allowedEndpointOrigins = [...(flags.allowedEndpointOrigins ?? []), a.slice("--allow-endpoint-origin=".length)];
        continue;
      }
      if (a === "--no-start") { flags.noStart = true; continue; }
      if (a === "--force") { flags.force = true; continue; }
      if (a === "--no-verify") { flags.noVerify = true; continue; }
    }
    return { result: { mode: "init", configPath: "", init: flags }, output: null };
  }

  // Subcommand dispatch: `enroll`: hands-off fleet onboarding with an
  // account-scoped key. Takes its own flag set.
  if (argv[0] === "enroll") {
    const flags: EnrollFlags = { noStart: false, force: false, noVerify: false, allowInsecureEndpoint: false };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") {
        return { result: { mode: "help", configPath: "" }, output: enrollHelp(version) };
      }
      if (a === "--account-key") { flags.accountKey = argv[++i]; continue; }
      if (a.startsWith("--account-key=")) { flags.accountKey = a.slice("--account-key=".length); continue; }
      if (a === "--name") { flags.name = argv[++i]; continue; }
      if (a.startsWith("--name=")) { flags.name = a.slice("--name=".length); continue; }
      if (a === "--dashboard-url") { flags.dashboardUrl = argv[++i]; continue; }
      if (a.startsWith("--dashboard-url=")) { flags.dashboardUrl = a.slice("--dashboard-url=".length); continue; }
      if (a === "--config-path") { flags.configPath = argv[++i]; continue; }
      if (a.startsWith("--config-path=")) { flags.configPath = a.slice("--config-path=".length); continue; }
      if (a === "--tags") { flags.tags = splitTags(argv[++i]); continue; }
      if (a.startsWith("--tags=")) { flags.tags = splitTags(a.slice("--tags=".length)); continue; }
      if (a === "--allow-insecure-endpoint") { flags.allowInsecureEndpoint = true; continue; }
      if (a === "--allow-endpoint-origin") {
        flags.allowedEndpointOrigins = [...(flags.allowedEndpointOrigins ?? []), argv[++i]];
        continue;
      }
      if (a.startsWith("--allow-endpoint-origin=")) {
        flags.allowedEndpointOrigins = [...(flags.allowedEndpointOrigins ?? []), a.slice("--allow-endpoint-origin=".length)];
        continue;
      }
      if (a === "--no-start") { flags.noStart = true; continue; }
      if (a === "--force") { flags.force = true; continue; }
      if (a === "--no-verify") { flags.noVerify = true; continue; }
    }
    return { result: { mode: "enroll", configPath: "", enroll: flags }, output: null };
  }

  // Subcommand dispatch: `doctor <topic>`: read-only diagnostic.
  // Currently only `doctor ipmi` is implemented; placeholder for future
  // topics (security, network) without changing the CLI shape.
  if (argv[0] === "doctor") {
    if (argv[1] === "--help" || argv[1] === "-h") {
      return { result: { mode: "help", configPath: "" }, output: doctorHelp(version) };
    }
    if (argv[1] === "ipmi") {
      // Honour --config. `doctor ipmi` reads collection.enforce_ipmitool_min_version
      // so it reports what the RUNNING agent does, and the agent may have been
      // started with a non-default config path. Returning "" made doctor always read
      // the default path, so on a host using --config it could report IPMI available
      // while the service was correctly refusing to collect. That is the exact
      // disagreement doctor exists to prevent. Adversarial review 2026-07-30 #8.
      let doctorConfig = "";
      for (let i = 2; i < argv.length; i++) {
        if ((argv[i] === "--config" || argv[i] === "-c") && argv[i + 1]) { doctorConfig = argv[i + 1]; break; }
        const eq = /^--config=(.+)$/.exec(argv[i] ?? "");
        if (eq) { doctorConfig = eq[1]; break; }
      }
      return { result: { mode: "doctor-ipmi", configPath: doctorConfig }, output: null };
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

// Parse a comma-separated --tags value into a trimmed, non-empty list.
function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

export function helpText(version: string): string {
  return [
    `glassmkr-crucible v${version} - Bare metal server monitoring agent`,
    "",
    "Usage:",
    "  glassmkr-crucible [options]",
    "  glassmkr-crucible init        [--api-key <K>] [--name <N>] [--ingest-url <U>] [--no-start] [--force]",
    "  glassmkr-crucible enroll      --account-key <K> [--name <N>] [--tags a,b] [--no-start] [--force]",
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
    "  enroll           Hands-off fleet onboarding: self-register this host",
    "                   with a shared account key, get its own collector key,",
    "                   then configure + start. Idempotent per machine.",
    "                   See 'glassmkr-crucible enroll --help'.",
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
    "  glassmkr-crucible init [--api-key <KEY>] [options]",
    "  glassmkr-crucible init --api-key - [options]   # read key from stdin",
    "",
    "Options:",
    "  --api-key <KEY>     Required for a new config or --force rewrite. Use - to read from stdin.",
    "                      Literal values can appear in ps and shell history.",
    "                      A protected file descriptor or systemd credential can be piped to stdin.",
    "  --name <NAME>       Server name in the Glassmkr dashboard. Defaults to the host's hostname.",
    "  --ingest-url <URL>  Ingest endpoint (default: https://app.glassmkr.com/api/v1/ingest).",
    "  --allow-endpoint-origin <ORIGIN>",
    "                      Permit a specific cross-origin or private endpoint. Repeatable.",
    "  --allow-insecure-endpoint",
    "                      Permit HTTP and private endpoints for trusted self-hosting.",
    "  --config-path <P>   Where to write crucible.yaml (default: /etc/glassmkr/crucible.yaml).",
    "  --no-start          Write config + unit, daemon-reload, but do not enable/start the service.",
    "  --force             Overwrite an existing config file. Without it, init re-secures in place.",
    "  --no-verify         Skip the connectivity probe against the ingest endpoint.",
    "  -h, --help          Print this help and exit.",
    "",
    "What this does:",
    "  1. Validates the api key format and (unless --no-verify) checks it against the ingest endpoint.",
    "  2. Writes /etc/glassmkr/crucible.yaml (root-owned, mode 0640). If a legacy",
    "     /etc/glassmkr/collector.yaml exists, it is renamed to the new",
    "     path before write (lossless migration).",
    "  3. Writes /etc/systemd/system/glassmkr-crucible.service (mode 0644) with",
    "     ExecStart pointing at the dynamically-detected binary path.",
    "  4. Runs systemctl daemon-reload.",
    "  5. Unless --no-start, runs systemctl enable --now glassmkr-crucible.",
    "",
    "Requires root for the filesystem and systemd writes (sudo).",
    "If privileged wrapper setup fails, the service remains unprivileged.",
    "Set GLASSMKR_ALLOW_ROOT_FALLBACK=1 only to explicitly accept root fallback.",
    `v${version}`,
  ].join("\n");
}

export function enrollHelp(version: string): string {
  return [
    `glassmkr-crucible enroll - hands-off fleet onboarding`,
    "",
    "Usage:",
    "  glassmkr-crucible enroll --account-key <KEY> [options]",
    "  glassmkr-crucible enroll --account-key - [options]   # read key from stdin",
    "",
    "Required:",
    "  --account-key <KEY>   A write-scoped account key (gmk_acct_live_<...>).",
    "                        Create one in the dashboard: Settings -> API keys.",
    "                        Prefer - to read it from stdin; literal values can",
    "                        appear in ps and shell history. The key is safe to",
    "                        provision through a protected file descriptor or",
    "                        systemd credential and pipe to stdin. It may be",
    "                        shared across the fleet;",
    "                        it is used once here and never written to disk.",
    "",
    "Options:",
    "  --name <NAME>         Server name in the dashboard. Defaults to hostname.",
    "  --tags a,b,c          Comma-separated tags to set on the server.",
    "  --dashboard-url <URL> Dashboard base URL (default: https://app.glassmkr.com).",
    "  --allow-endpoint-origin <ORIGIN>",
    "                        Permit a specific cross-origin or private endpoint.",
    "                        Repeat for multiple origins.",
    "  --allow-insecure-endpoint",
    "                        Permit HTTP and private endpoints for trusted self-hosting.",
    "  --config-path <P>     Where to write crucible.yaml (default: /etc/glassmkr/crucible.yaml).",
    "  --no-start            Write config + unit, daemon-reload, but do not start the service.",
    "  --force               Re-enroll even if already configured (rotates the collector key).",
    "  --no-verify           Skip the post-register connectivity probe.",
    "  -h, --help            Print this help and exit.",
    "",
    "What this does:",
    "  1. Derives this host's stable machine id (DMI product_uuid, else",
    "     /etc/machine-id) so a re-run maps back to the SAME dashboard server",
    "     instead of creating a duplicate.",
    "  2. POSTs it to /api/v1/servers with the account key; the dashboard",
    "     self-registers the server and returns this host's own collector key.",
    "  3. Hands that collector key to the same setup path as 'init' (writes",
    "     crucible.yaml, sets up privilege separation, installs + starts the",
    "     systemd unit). The account key is NOT written to disk.",
    "",
    "Idempotent: if the host is already configured, it is a no-op (no key",
    "rotation) unless --force is passed. Requires root for the filesystem and",
    "systemd writes (sudo).",
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
    "Options:",
    "  --config <path>   Read this config instead of the default. Pass the same",
    "                    path the service uses, so the diagnostic reflects the",
    "                    settings the running agent actually applies.",
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
