// `glassmkr-crucible doctor` subcommand: read-only customer-facing
// diagnostic that reports the same capability probes the agent runs at
// startup, plus actionable per-failure-mode guidance. Output is plain
// text; pipe-friendly. Exit code 0 on success regardless of probe
// result: the diagnostic itself succeeded, even when the probes say
// "no BMC here".
//
// Currently covers `doctor ipmi`. Future sub-areas (`doctor security`,
// `doctor network`) would slot in next to it.

import { detectIpmiCapability, MIN_SAFE_IPMITOOL_VERSION } from "./lib/capability.js";
import { loadConfig } from "./config.js";
import { DEFAULT_CONFIG_PATH, resolveConfigPathWithLegacyFallback } from "./cli.js";

/** Format the IPMI detection result + actionable fix guidance. */
export function formatIpmiDoctor(cap: Awaited<ReturnType<typeof detectIpmiCapability>>): string {
  const out: string[] = [];
  out.push("IPMI capability check:");

  if (cap.available) {
    out.push(`  Result:        [OK] IPMI detected via ${cap.method}`);
    if (cap.ipmitool_version) {
      out.push(`  ipmitool:      ${cap.ipmitool_version}`);
    }
    // The below-floor advisory belongs here above all: `doctor ipmi` is what an
    // operator runs when IPMI looks wrong, and it used to omit this entirely
    // (2026-07-30 review finding #5), so the one place designed to explain IPMI
    // state was the one place that did not mention the CVE gate.
    if (cap.ipmitool_below_cve_floor) {
      out.push(`  CVE-2020-5208: version reads below ${MIN_SAFE_IPMITOOL_VERSION}, collecting anyway`);
      if (cap.ipmitool_package) {
        out.push(`  Package:       ${cap.ipmitool_package} (distro-owned)`);
        out.push("");
        out.push("  Your distro backports this fix without bumping the upstream");
        out.push("  version, so the package above is almost certainly patched. The");
        out.push("  release suffix is the part `ipmitool -V` does not show you.");
        out.push("  Verify: zcat /usr/share/doc/ipmitool/changelog.Debian.gz | grep -i 5208");
        out.push("      or: rpm -q --changelog ipmitool | grep -i 5208");
      }
    }
    out.push("");
    out.push("Crucible will collect:");
    out.push("  - Sensor readings (temperature, fan, voltage, power)");
    out.push("  - SEL events (recent + cumulative ECC counters)");
    out.push("  - PSU redundancy state (per-PSU + aggregate)");
    out.push("");
    out.push("If your dashboard still shows \"IPMI: Not detected\", the agent");
    out.push("may have started before ipmitool was installed. Since 0.9.4 the");
    out.push("capability is re-checked once per hour and the next collection");
    out.push("cycle picks up the change automatically.");
    return out.join("\n");
  }

  out.push(`  Result:        [FAIL] reason=${cap.reason}`);
  if (cap.detail) out.push(`  Detail:        ${cap.detail}`);
  out.push("");

  switch (cap.reason) {
    case "no_ipmitool_binary":
      out.push("Fix: install ipmitool");
      out.push("  Debian/Ubuntu:    sudo apt install ipmitool");
      out.push("  RHEL/Rocky/Alma:  sudo dnf install ipmitool");
      out.push("  Arch:             sudo pacman -S ipmitool");
      out.push("  Alpine:           sudo apk add ipmitool");
      out.push("");
      out.push("After installing, the next collection cycle (within ~5 minutes)");
      out.push("will re-detect IPMI automatically. No agent restart needed.");
      break;
    case "no_bmc_device":
      out.push("Fix: ensure the BMC kernel modules are loaded.");
      out.push("  sudo modprobe ipmi_si ipmi_devintf ipmi_msghandler");
      out.push("  ls -l /dev/ipmi0    # should appear after the modules load");
      out.push("");
      out.push("If `/dev/ipmi0` never appears, the host may not have a BMC");
      out.push("(common on consumer hardware, Pi, laptops, and VMs without IPMI");
      out.push("passthrough). In that case set `collection.ipmi: false` in");
      out.push("/etc/glassmkr/crucible.yaml (legacy installs: /etc/glassmkr/collector.yaml) to silence the snapshot field.");
      break;
    case "permission_denied":
      out.push("Fix: repair Crucible's narrow privileged collector wrapper.");
      out.push("  sudo glassmkr-crucible init --api-key <KEY> --force");
      out.push("  sudo -u glassmkr sudo -n /usr/local/sbin/crucible-collect ipmi-sensor");
      out.push("");
      out.push("The service stays unprivileged when wrapper setup fails. Do not");
      out.push("grant broad device groups or run the whole collector as root.");
      break;
    case "execution_failed":
      out.push("Fix: ipmitool ran but failed. Diagnose by hand:");
      out.push("  sudo ipmitool mc info");
      out.push("");
      out.push("Common causes:");
      out.push("  - BMC is in a degraded state and dropped the request");
      out.push("  - the in-band interface (KCS/SSIF) is busy");
      out.push("  - kernel modules are loaded but the userland tool's version is");
      out.push("    too old for this BMC's IPMI 2.0 dialect");
      out.push("");
      out.push("DO NOT run `sudo ipmitool mc reset cold` without confirming first");
      out.push("with your vendor; some BMCs can hang past the reset.");
      break;
    case "ipmitool_cve_2020_5208":
      out.push("Crucible will not run this ipmitool as root. It reports a version");
      out.push(`below ${MIN_SAFE_IPMITOOL_VERSION} (CVE-2020-5208: heap overflows parsing BMC`);
      out.push("responses) and either no distro package owns the binary, or you have");
      out.push("set collection.enforce_ipmitool_min_version: true.");
      out.push("");
      out.push("Which one it is, is in the Detail line above. If it names a path:");
      out.push("  that file is a source, vendor or hand-installed build, so no distro");
      out.push("  backport covers it. Note /usr/local/bin precedes /usr/bin in sudo's");
      out.push("  secure_path, so a local build SHADOWS the packaged one.");
      out.push("");
      out.push("Fix, in order of preference:");
      out.push("  1. Use your distro's package and remove the unowned binary:");
      out.push("       command -v ipmitool          # which one wins today");
      out.push("       sudo apt install ipmitool    # or dnf/pacman/apk");
      out.push("  2. Build or install 1.8.19 or newer, which fixes the CVE upstream.");
      out.push("  3. If this host has no BMC to monitor, set collection.ipmi: false.");
      out.push("");
      out.push("Distro-packaged 1.8.18 is NOT blocked: those are patched by backport");
      out.push("and Crucible collects from them with an advisory instead.");
      break;
  }

  return out.join("\n");
}

/**
 * Read `collection.enforce_ipmitool_min_version` so the doctor probes with the
 * SAME settings the agent uses. Without this the doctor could report IPMI as
 * available on a host where the running agent is refusing to collect, which is
 * the opposite of useful (2026-07-30 review finding #5).
 *
 * Best-effort on purpose. The config is root:glassmkr 0640, so an ordinary user
 * running `doctor ipmi` cannot read it, and a diagnostic must never fail because
 * of that. Unreadable config falls back to the shipped default (false) and says so.
 */
export function readEnforceFlag(
  load: typeof loadConfig = loadConfig,
  configPath?: string,
): { enforce: boolean; note: string | null } {
  try {
    // An explicit --config wins; only the default path gets the legacy fallback,
    // since that fallback exists to find /etc/glassmkr/collector.yaml and would be
    // wrong to apply to an operator's chosen path.
    const resolved = configPath && configPath.length > 0
      ? configPath
      : resolveConfigPathWithLegacyFallback(DEFAULT_CONFIG_PATH);
    const cfg = load(resolved);
    return { enforce: cfg.collection.enforce_ipmitool_min_version, note: null };
  } catch (err: any) {
    const why = err?.code === "EACCES" || err?.code === "EPERM"
      ? "config is not readable by this user (it is root:glassmkr 0640); re-run with sudo for a config-aware result"
      : `config could not be read (${String(err?.code ?? err?.message ?? err).slice(0, 80)})`;
    return { enforce: false, note: why };
  }
}

/** Run the doctor subcommand. Returns the formatted report. */
export async function runDoctorIpmi(configPath?: string): Promise<string> {
  const { enforce, note } = readEnforceFlag(loadConfig, configPath);
  const cap = await detectIpmiCapability({ enforceMinVersion: enforce });
  const report = formatIpmiDoctor(cap);
  return note ? `${report}\n\nNote: ${note}.` : report;
}
