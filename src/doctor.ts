// `glassmkr-crucible doctor` subcommand: read-only customer-facing
// diagnostic that reports the same capability probes the agent runs at
// startup, plus actionable per-failure-mode guidance. Output is plain
// text; pipe-friendly. Exit code 0 on success regardless of probe
// result — the diagnostic itself succeeded, even when the probes say
// "no BMC here".
//
// Currently covers `doctor ipmi`. Future sub-areas (`doctor security`,
// `doctor network`) would slot in next to it.

import { detectIpmiCapability } from "./lib/capability.js";

/** Format the IPMI detection result + actionable fix guidance. */
export function formatIpmiDoctor(cap: Awaited<ReturnType<typeof detectIpmiCapability>>): string {
  const out: string[] = [];
  out.push("IPMI capability check:");

  if (cap.available) {
    out.push(`  Result:        [OK] IPMI detected via ${cap.method}`);
    if (cap.ipmitool_version) {
      out.push(`  ipmitool:      ${cap.ipmitool_version}`);
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
      out.push("with your vendor — some BMCs can hang past the reset.");
      break;
  }

  return out.join("\n");
}

/** Run the doctor subcommand. Returns the formatted report. */
export async function runDoctorIpmi(): Promise<string> {
  const cap = await detectIpmiCapability();
  return formatIpmiDoctor(cap);
}
