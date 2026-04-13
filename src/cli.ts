// CLI argument handling for the Crucible binary. Runs before any config load
// or collector initialization so --version and --help exit cleanly even when
// the config file is missing or the host lacks the tools the collectors need.

export interface CliArgs {
  mode: "version" | "help" | "run";
  configPath: string;
}

export const DEFAULT_CONFIG_PATH = "/etc/glassmkr/collector.yaml";

export function parseCliArgs(argv: string[], version: string): { result: CliArgs; output: string | null } {
  // argv is typically process.argv.slice(2)
  let configPath = DEFAULT_CONFIG_PATH;

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
    "",
    "Options:",
    "  -v, --version    Print version and exit",
    "  -h, --help       Print this help and exit",
    `  -c, --config     Path to config file (default: ${DEFAULT_CONFIG_PATH})`,
    "",
    "Without options, starts the collector daemon using the config file.",
    "Docs: https://github.com/glassmkr/crucible",
  ].join("\n");
}
