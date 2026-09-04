#!/usr/bin/env node

import { parseCliArgs } from "./cli.js";
import { CRUCIBLE_VERSION as PKG_VERSION } from "./lib/version.js";

// Handle --version, --help, and planned-reboot subcommands before
// importing collectors, loading config, or starting the Prometheus
// server. Keeps the CLI responsive even on hosts missing the config
// file or external tools.
const { result: cliArgs, output: cliOutput } = parseCliArgs(process.argv.slice(2), PKG_VERSION);
if (cliArgs.mode === "version" || cliArgs.mode === "help") {
  console.log(cliOutput);
  process.exit(0);
}
if (cliArgs.mode === "cli-error") {
  console.error(cliOutput);
  process.exit(2);
}
if (cliArgs.mode === "doctor-ipmi") {
  const { runDoctorIpmi } = await import("./doctor.js");
  const { report, exitCode } = await runDoctorIpmi(cliArgs.configPath);
  console.log(report);
  process.exit(exitCode);
}
if (cliArgs.mode === "init") {
  const { runInit, defaultDeps } = await import("./init.js");
  const flags = cliArgs.init;
  if (!flags) process.exit(2);
  const code = await runInit({
    apiKey: flags.apiKey,
    name: flags.name,
    ingestUrl: flags.ingestUrl,
    configPath: flags.configPath,
    noStart: flags.noStart,
    force: flags.force,
    noVerify: flags.noVerify,
    apiKeyFromArgv: flags.apiKey !== "-",
    allowInsecureEndpoint: flags.allowInsecureEndpoint,
    allowedEndpointOrigins: flags.allowedEndpointOrigins,
  }, defaultDeps());
  process.exit(code);
}
if (cliArgs.mode === "enroll") {
  const { runEnroll, defaultEnrollDeps } = await import("./enroll.js");
  const flags = cliArgs.enroll;
  if (!flags || !flags.accountKey) {
    console.error("[enroll] missing required --account-key (use --account-key - to read from stdin). See 'glassmkr-crucible enroll --help'.");
    process.exit(2);
  }
  const code = await runEnroll({
    accountKey: flags.accountKey,
    name: flags.name,
    dashboardUrl: flags.dashboardUrl,
    configPath: flags.configPath,
    tags: flags.tags,
    noStart: flags.noStart,
    force: flags.force,
    noVerify: flags.noVerify,
    allowInsecureEndpoint: flags.allowInsecureEndpoint,
    allowedEndpointOrigins: flags.allowedEndpointOrigins,
  }, defaultEnrollDeps());
  process.exit(code);
}
if (cliArgs.mode === "mark-reboot" || cliArgs.mode === "reboot") {
  const { writeRebootMarker, parseDuration, DEFAULT_TTL_MS } = await import("./lib/reboot-marker.js");
  const ttlMs = cliArgs.ttl ? parseDuration(cliArgs.ttl) : DEFAULT_TTL_MS;
  if (ttlMs === null) {
    console.error(`[mark-reboot] invalid --ttl value: ${cliArgs.ttl}. Use e.g. 10m, 2h, 600s.`);
    process.exit(2);
  }
  try {
    const { path, expires_at } = writeRebootMarker({
      reason: cliArgs.reason, ttlMs,
    });
    console.log(`[${cliArgs.mode}] marker written: ${path} (expires ${expires_at}${cliArgs.reason ? `, reason: ${cliArgs.reason}` : ""})`);
  } catch (err: any) {
    console.error(`[${cliArgs.mode}] failed to write marker: ${err?.message || err}`);
    console.error(`  Most likely cause: need root privileges to write under /var/lib/crucible/.`);
    process.exit(1);
  }
  if (cliArgs.mode === "reboot") {
    const { execFileSync } = await import("node:child_process");
    const { buildSubprocessEnv } = await import("./lib/exec.js");
    console.log("[reboot] invoking systemctl reboot");
    try {
      execFileSync("systemctl", ["reboot"], { stdio: "inherit", env: buildSubprocessEnv() });
    } catch (err: any) {
      console.error(`[reboot] systemctl reboot failed: ${err?.message || err}`);
      process.exit(1);
    }
  }
  process.exit(0);
}


// mode === "run": hand over to the agent runtime. This MUST stay a dynamic
// import. A static import here is hoisted above every check above, so the
// whole runtime graph (collectors, undici, alerts/state.js and its
// import-time state-file read) would load before --help was even parsed;
// that is exactly what printed EACCES stack traces ahead of the usage text
// for an unprivileged --help on 2026-09-04.
await import("./agent.js");
