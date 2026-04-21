// CLI argument handling for the Crucible binary. Runs before any config load
// or collector initialization so --version and --help exit cleanly even when
// the config file is missing or the host lacks the tools the collectors need.

export type CliMode = "version" | "help" | "run" | "mark-reboot" | "reboot";

export interface CliArgs {
  mode: CliMode;
  configPath: string;
  reason?: string;
  ttl?: string; // raw duration string, parsed by caller
}

export const DEFAULT_CONFIG_PATH = "/etc/glassmkr/collector.yaml";

export function parseCliArgs(argv: string[], version: string): { result: CliArgs; output: string | null } {
  // argv is typically process.argv.slice(2)
  let configPath = DEFAULT_CONFIG_PATH;

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

export function helpText(version: string): string {
  return [
    `glassmkr-crucible v${version} - Bare metal server monitoring agent`,
    "",
    "Usage:",
    "  glassmkr-crucible [options]",
    "  glassmkr-crucible mark-reboot [--reason TEXT] [--ttl DURATION]",
    "  glassmkr-crucible reboot      [--reason TEXT] [--ttl DURATION]",
    "",
    "Options:",
    "  -v, --version    Print version and exit",
    "  -h, --help       Print this help and exit",
    `  -c, --config     Path to config file (default: ${DEFAULT_CONFIG_PATH})`,
    "",
    "Subcommands:",
    "  mark-reboot      Write a planned-reboot marker so the next boot",
    "                   does not fire `server_rebooted_unexpectedly`.",
    "                   You run the reboot yourself afterwards.",
    "  reboot           Write the marker, then invoke `systemctl reboot`.",
    "",
    "Without options, starts the collector daemon using the config file.",
    "Docs: https://github.com/glassmkr/crucible",
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
