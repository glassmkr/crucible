// One-shot IPMI capability detection at process startup.
//
// The agent runs collectIpmi() every cycle. Without this layer, hosts
// without a BMC (Pi, laptop, VM, container without /dev mapped) hit four
// ipmitool ENOENT or "Could not open device" execs every interval forever.
// They're silent (lib/exec.ts swallows ENOENT) but still wasted process
// spawns, and there's no log telling the user IPMI is unavailable here.
//
// This module probes once at startup and caches the result. collectIpmi()
// reads the cached capability and short-circuits when unavailable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runPrivileged } from "./privileged.js";
import { buildSubprocessEnv } from "./exec.js";

const execFileAsync = promisify(execFile);

export type IpmiCapability =
  | { available: true; method: "ipmitool_in_band"; ipmitool_version: string | null }
  | { available: false; reason: "no_ipmitool_binary" | "no_bmc_device" | "execution_failed" | "permission_denied" | "ipmitool_cve_2020_5208"; detail?: string };

// CVE-2020-5208 (GHSA-g659-9qxw-p7cp): heap overflow in ipmitool's
// read_fru_area_section and related parsers when handling data received
// from a remote LAN party (a malicious or compromised BMC). Fixed in
// ipmitool 1.8.19. The agent runs ipmitool in-band against the host BMC,
// so a compromised BMC parsing path is a real local-blast-radius primitive
// (audit §2.1 / catalog T-202). Below the fix version we mark IPMI
// unavailable rather than feed BMC output to a vulnerable parser.
export const MIN_SAFE_IPMITOOL_VERSION = "1.8.19";

/**
 * True iff `version` is a parseable ipmitool version strictly below
 * MIN_SAFE_IPMITOOL_VERSION. Unknown/unparseable versions return false
 * (we do not disable a capability we cannot positively identify as
 * vulnerable). Pure; unit-tested.
 */
export function isIpmitoolVersionVulnerable(version: string | null): boolean {
  if (!version) return false;
  const min = [1, 8, 19];
  const parts = version.split(/[.\-+]/).map((p) => parseInt(p, 10));
  if (parts.length === 0 || Number.isNaN(parts[0])) return false; // unparseable
  for (let i = 0; i < min.length; i++) {
    const p = Number.isNaN(parts[i]) ? 0 : (parts[i] ?? 0);
    if (p < min[i]) return true;
    if (p > min[i]) return false;
  }
  return false; // equal or greater
}

interface DetectDeps {
  /** Override for tests. Runs `ipmitool -V` (direct; works unprivileged).
   *  Returns stdout or throws with err.code. Used only for the version /
   *  CVE gate. */
  runIpmitool?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Override for tests. The WRAPPED sensor probe (`sudo crucible-collect
   *  ipmi-sensor`). Returns stdout, or null on any failure. This is the
   *  availability signal: under the §2.1 unprivileged model the agent user
   *  cannot stat /dev/ipmi0 or run ipmitool directly, so a direct
   *  device-node probe is meaningless; the wrapper (which runs as root) is
   *  the real reachability test. */
  probeSensor?: () => Promise<string | null>;
}

async function defaultRunIpmitool(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("ipmitool", args, {
    timeout: 2000,
    env: buildSubprocessEnv(),
  });
  return { stdout, stderr };
}

export async function detectIpmiCapability(deps: DetectDeps = {}): Promise<IpmiCapability> {
  const runIpmitool = deps.runIpmitool ?? defaultRunIpmitool;
  const probeSensor = deps.probeSensor ?? (() => runPrivileged("ipmi-sensor"));

  // Step 1: probe the ipmitool binary + version. `ipmitool -V` needs no BMC
  // access, so it works even as the unprivileged service user.
  let ipmitoolVersion: string | null = null;
  try {
    const { stdout } = await runIpmitool(["-V"]);
    const m = stdout.match(/ipmitool version (\S+)/);
    ipmitoolVersion = m ? m[1] : null;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { available: false, reason: "no_ipmitool_binary" };
    }
    return {
      available: false,
      reason: "execution_failed",
      detail: String(err?.stderr ?? err?.message ?? err).split("\n")[0]?.slice(0, 200),
    };
  }

  // Step 2: version gate (CVE-2020-5208): refuse to feed BMC output to a
  // vulnerable ipmitool parser. Fail-closed for the IPMI capability only;
  // every other collector is unaffected. Skipped when the version could
  // not be parsed (we do not disable a capability we cannot positively
  // identify as vulnerable).
  if (isIpmitoolVersionVulnerable(ipmitoolVersion)) {
    return {
      available: false,
      reason: "ipmitool_cve_2020_5208",
      detail: `ipmitool ${ipmitoolVersion} < ${MIN_SAFE_IPMITOOL_VERSION}; upgrade to close CVE-2020-5208`,
    };
  }

  // Step 3: reachability via the WRAPPED sensor probe. Non-empty output means
  // the BMC answered; empty/failure means no usable BMC on this host.
  try {
    const out = await probeSensor();
    if (out && out.trim().length > 0) {
      return { available: true, method: "ipmitool_in_band", ipmitool_version: ipmitoolVersion };
    }
    return { available: false, reason: "no_bmc_device" };
  } catch (err: any) {
    return {
      available: false,
      reason: "execution_failed",
      detail: String(err?.stderr ?? err?.message ?? err).split("\n")[0]?.slice(0, 200),
    };
  }
}

export function formatCapabilityLine(cap: IpmiCapability): string {
  if (cap.available) {
    const v = cap.ipmitool_version ? `ipmitool ${cap.ipmitool_version}, ` : "";
    return `IPMI: available (${v}${cap.method.replace(/_/g, " ")})`;
  }
  switch (cap.reason) {
    case "no_ipmitool_binary": return "IPMI: not available (ipmitool not installed)";
    case "no_bmc_device":      return "IPMI: not available (no /dev/ipmi*, BMC not detected)";
    case "permission_denied":  return `IPMI: not available (${cap.detail ?? "permission denied"})`;
    case "execution_failed":   return `IPMI: not available (execution failed${cap.detail ? `: ${cap.detail}` : ""})`;
    case "ipmitool_cve_2020_5208": return `IPMI: disabled (${cap.detail ?? "ipmitool too old (CVE-2020-5208)"})`;
  }
}
