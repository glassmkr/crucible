import { run } from "../lib/exec.js";
import { readFileSync, readdirSync } from "fs";

// OS support-status collector (v0.13.24+, currency-monitoring milestone).
//
// Answers one question the pending_updates / CVE collectors cannot: is this
// host's OS release still receiving security support, EVEN IF it is past its
// standard end-of-life date? A past-EOL release enrolled in Ubuntu Pro/ESM or
// pinned to a RHEL EUS repo keeps getting security fixes; reporting it
// "unsupported" purely from an external date table would be a false claim.
//
// The dashboard's os_end_of_life rule combines the release EOL date (from the
// synced endoflife.date dataset) with THIS signal to decide whether a
// past-standard-support host is genuinely unsupported or still covered.
//
// PRIVILEGE: strictly unprivileged. The authoritative Ubuntu signal
// (`pro security-status`) is designed to run without root, and RHEL EUS is
// read from world-readable /etc/yum.repos.d/*.repo. We deliberately do NOT
// escalate to `subscription-manager` (which needs root), because Crucible's
// public contract is that the agent runs as the `glassmkr` user, never root.
// Where an unprivileged signal cannot prove enrollment (RHEL registration),
// we degrade to `extended_support_active: null` rather than expand the
// privileged surface.
//
// FAIL-SAFE: every unparseable / absent path returns null (field omitted), so
// a wrong guess about tool output never produces a false "unsupported"; the
// dashboard degrades to conservative "enrollment not verified" wording.

export interface SupportStatus {
  // Which on-host mechanism produced the reading.
  source: "ubuntu-pro" | "rhel-eus-repos";
  // Whether EXTENDED security support (Ubuntu ESM / RHEL EUS) is active on
  // this host right now. This is an enrollment FACT, not a lifecycle verdict:
  // the dashboard combines it with the release EOL date to decide whether a
  // past-standard-support host is still covered.
  //   true  = extended support engaged (esm-infra enabled / EUS repo active)
  //   false = mechanism present, no extended support engaged
  //   null  = mechanism present but state could not be determined
  extended_support_active: boolean | null;
  // Human-readable evidence line for the dashboard + alert evidence.
  details: string;
  // Ubuntu Pro specifics (present only when source === "ubuntu-pro").
  attached?: boolean; // machine attached to a Pro subscription
  esm_infra?: boolean; // esm-infra service enabled (main archive extended security)
  esm_apps?: boolean; // esm-apps service enabled (universe extended security)
  // RHEL specifics (present only when source === "rhel-eus-repos").
  eus?: boolean; // an enabled *-eus-* repo is configured
}

function readOsId(): string | undefined {
  try {
    const osRelease = readFileSync("/etc/os-release", "utf-8");
    const m = osRelease.match(/^ID=(.*)$/m);
    if (!m) return undefined;
    return m[1].trim().replace(/^"(.*)"$/, "$1").trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export async function collectSupportStatus(): Promise<SupportStatus | null> {
  const id = readOsId();
  if (!id) return null;

  if (id === "ubuntu") return await collectUbuntuPro();
  if (/^(rhel|rocky|almalinux|centos)$/.test(id)) return collectRhelEus();

  // Debian LTS has no per-host "attach" concept (LTS is just a repo), so the
  // endoflife.date extendedSupport date models it fully; no on-host signal.
  // Every other distro: no supported mechanism.
  return null;
}

// === Ubuntu Pro / ESM ===

// `pro security-status --format json` is the documented unprivileged status
// command (successor to `ubuntu-security-status`). Its enrollment state lives
// under `summary.ua`: `attached` (bool) + `enabled_services` (string[] of
// service names such as "esm-infra", "esm-apps"). We also defensively accept
// the root-level shape emitted by `pro status --format json` in case a future
// client version reshapes the output. Any deviation -> null.
async function collectUbuntuPro(): Promise<SupportStatus | null> {
  const out = await run("pro", ["security-status", "--format", "json"], 15000);
  if (!out) return null; // pro not installed / no output -> ENOENT or empty

  let j: unknown;
  try {
    j = JSON.parse(out);
  } catch {
    return null;
  }
  const obj = j as Record<string, any>;
  const ua = obj?.summary?.ua ?? obj; // security-status nests under summary.ua

  const attached = ua?.attached === true;
  const enabled: unknown = ua?.enabled_services;
  if (!Array.isArray(enabled)) {
    // Could not locate the enrollment shape we understand: report attached
    // if we found it, but leave extended support undetermined.
    return {
      source: "ubuntu-pro",
      extended_support_active: null,
      details: "Ubuntu Pro client present; enrollment state not parseable",
      attached,
    };
  }
  const services = new Set(enabled.map((s) => String(s)));
  const esmInfra = services.has("esm-infra");
  const esmApps = services.has("esm-apps");

  // esm-infra covers the main archive (where security-critical packages live),
  // so it is the signal that a past-standard-support LTS is still getting
  // security fixes. esm-apps (universe) is reported for completeness.
  const details = attached
    ? `Ubuntu Pro attached; esm-infra ${esmInfra ? "enabled" : "disabled"}, esm-apps ${esmApps ? "enabled" : "disabled"}`
    : "Ubuntu Pro not attached (no ESM coverage)";

  return {
    source: "ubuntu-pro",
    extended_support_active: esmInfra,
    details,
    attached,
    esm_infra: esmInfra,
    esm_apps: esmApps,
  };
}

// === RHEL EUS ===

// Extended Update Support pins a host to a specific minor and keeps security
// fixes flowing past that minor's standard window. It is visible unprivileged
// as an enabled repo whose id/baseurl carries the "eus" token in the
// world-readable /etc/yum.repos.d/*.repo files. `subscription-manager` would
// confirm the subscription is valid, but it needs root, so we read the repo
// config instead and degrade to null when we cannot read it at all.
function collectRhelEus(): SupportStatus | null {
  const dir = "/etc/yum.repos.d";
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".repo"));
  } catch {
    return null; // no repo dir readable -> undetermined
  }
  if (files.length === 0) return null;

  let sawAnyRepo = false;
  let eusEnabled = false;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(`${dir}/${f}`, "utf-8");
    } catch {
      continue;
    }
    // Walk .repo INI sections: a section header line "[id]" starts a block;
    // within it, "enabled = 1" turns it on. A repo counts as EUS when its
    // section id or any baseurl/metalink line carries the "eus" token.
    let sectionIsEus = false;
    let sectionEnabled = false;
    const flush = () => {
      if (sectionIsEus && sectionEnabled) eusEnabled = true;
    };
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[") && line.endsWith("]")) {
        flush();
        sawAnyRepo = true;
        sectionIsEus = /eus/i.test(line);
        sectionEnabled = false;
        continue;
      }
      if (/eus/i.test(line) && /^(baseurl|metalink|mirrorlist)\s*=/i.test(line)) {
        sectionIsEus = true;
      }
      if (/^enabled\s*=\s*1\b/i.test(line)) sectionEnabled = true;
    }
    flush();
  }

  if (!sawAnyRepo) return null;

  return {
    source: "rhel-eus-repos",
    extended_support_active: eusEnabled,
    details: eusEnabled
      ? "An enabled EUS (Extended Update Support) repository is configured"
      : "No enabled EUS repository found (registration not checked; needs root)",
    eus: eusEnabled,
  };
}
