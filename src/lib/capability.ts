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
import { attributeIpmitool, resolveIpmitoolPath, type IpmitoolProvenance } from "./ipmitool-provenance.js";

const execFileAsync = promisify(execFile);

export type IpmiCapability =
  | {
      available: true;
      method: "ipmitool_in_band";
      ipmitool_version: string | null;
      /** True when we could not PROVE the binary is at or above
       *  MIN_SAFE_IPMITOOL_VERSION, either because it reads below the floor or
       *  because its version string was unparseable, and we collected anyway. Only
       *  ever set when the binary was POSITIVELY attributed to a distro package, so
       *  it means "your distro almost certainly backported the fix without bumping
       *  the version", NOT "vulnerable". Unattributable builds fail closed. */
      ipmitool_below_cve_floor?: boolean;
      /** The distro package owning the root-executed binary, including the EVR
       *  (`ipmitool 1.8.18-11ubuntu2.2`). Only set alongside
       *  ipmitool_below_cve_floor, and it is the evidence that justifies it: this
       *  release suffix is exactly what `ipmitool -V` hides. */
      ipmitool_package?: string;
    }
  | {
      available: false;
      /** `ipmitool_cve_2020_5208` is produced when the version reads below the
       *  floor AND the binary is not owned by any distro package, or when an
       *  operator has set `collection.enforce_ipmitool_min_version: true`. */
      reason: "no_ipmitool_binary" | "no_bmc_device" | "execution_failed" | "permission_denied" | "ipmitool_cve_2020_5208";
      detail?: string;
    };

// CVE-2020-5208 (GHSA-g659-9qxw-p7cp): heap overflows in ipmitool's FRU, SDR,
// session, channel and lanp parsers when handling data received FROM a BMC.
// Fixed upstream in ipmitool 1.8.19. The agent runs ipmitool in-band as root via
// the sudo wrapper, so exploitation would be root RCE on the host.
//
// 2026-07-29: THIS IS NOW AN ADVISORY, NOT A BLOCKER, by default. Reasoning, kept
// here because it is a deliberate loosening of a security control and must stay
// reviewable:
//
//  1. It fires on SUSPICION, never on evidence, which contradicts the principle
//     stated on isIpmitoolVersionVulnerable() below. `ipmitool -V` reports a BARE
//     upstream version: Ubuntu 22.04 ships 1.8.18-11ubuntu2.2 and reports
//     "1.8.18". The distro release suffix, which is where a backported fix lives,
//     is not visible to the agent at all. RHEL changelogs cite rhbz ids rather
//     than CVE numbers, so even a changelog grep cannot confirm patch state
//     there. So we cannot distinguish patched from unpatched.
//  2. On the distros where it fires, the package is normally ALREADY PATCHED.
//     Verified 2026-07-29 on the fleet: Ubuntu 20.04 and 22.04 both carry all six
//     upstream CVE-2020-5208 patches (one via focal-security), and neither offers
//     any 1.8.19+ package to upgrade to. So the gate removed all BMC monitoring
//     while protecting against nothing.
//  3. The threat requires a COMPROMISED BMC on that same host, since access is
//     in-band (KCS/SSIF) with no network MITM path. An attacker holding the BMC
//     already has power control, virtual media, KVM and often DMA, i.e. they can
//     own the host without this bug. The marginal gain is stealth, not capability.
//  4. Cost side: stock Ubuntu 20.04/22.04 and RHEL-family 9 all pin 1.8.18, so
//     the default behaviour silently disabled fan, PSU, SEL and IPMI-ECC
//     monitoring on the majority of real fleets. For a hardware-monitoring
//     product that is a worse failure than the risk it averted.
//
// So the default is now: collect, and report the version plus a below-floor flag
// so the Dashboard can advise. Operators who genuinely model BMC compromise can
// restore fail-closed with `collection.enforce_ipmitool_min_version: true`.
//
// 2026-07-30, NARROWED after an adversarial review argued the loosening had gone
// one step too far. Points 1-4 above are about DISTRO-PACKAGED ipmitool, and they
// hold. They say nothing about a source build, a vendor tarball or a hand-compiled
// binary, and the loosened gate ran those as root too, unattended, every snapshot.
// Point 3's "the attacker already owns the host" reasoning does NOT extend to that
// case: holding the BMC is not the same as holding root on the running OS, so
// executing genuinely unpatched parsers as root adds a capability rather than
// merely removing stealth.
//
// So below-floor now splits on EVIDENCE OF ORIGIN (lib/ipmitool-provenance.ts):
//   - owned by a dpkg/rpm package -> collect, advisory only. The distro's backport
//     policy is the patch story, and this is the common real-fleet case.
//   - owned by nothing            -> FAIL CLOSED. No backport story exists, so we
//     refuse to hand it root.
// `enforce_ipmitool_min_version: true` still forces closed regardless of origin.
export const MIN_SAFE_IPMITOOL_VERSION = "1.8.19";

/**
 * True iff `version` is a parseable ipmitool version strictly below
 * MIN_SAFE_IPMITOOL_VERSION. Kept as a thin wrapper for readability at call
 * sites that only care about the below-floor case; callers deciding whether to
 * hand the binary to root must use classifyIpmitoolVersion() instead, because
 * this collapses "unknown" into false. Pure; unit-tested.
 */
export function isIpmitoolVersionVulnerable(version: string | null): boolean {
  return classifyIpmitoolVersion(version) === "below_floor";
}

/**
 * Three-way, because "we could not tell" is NOT the same as "safe".
 *
 * The old two-way version returned false for an unparseable version, on the
 * principle that we should not disable a capability we cannot positively identify
 * as vulnerable. That was defensible while the gate was version-only, but once
 * provenance existed it became a hole: `ipmitool version vendor-build` parsed as
 * unknown, was treated as at-or-above the floor, and so skipped provenance AND
 * `enforce_ipmitool_min_version` entirely, handing an unidentifiable vendor build
 * to the root wrapper. Adversarial review 2026-07-30, finding #1.
 *
 * `unknown` now routes to exactly the same place as `below_floor`: prove distro
 * origin or do not run as root. A distro-packaged build with a strange version
 * string therefore still collects, which keeps the cost off real fleets.
 */
export function classifyIpmitoolVersion(version: string | null): "below_floor" | "at_or_above" | "unknown" {
  if (!version) return "unknown";
  // STRICT numeric core. The previous `split` + `parseInt` was permissive in both
  // directions: `parseInt("2vendor")` gave 2 so a garbage string outranked the floor,
  // and `1.8.19-rc.1` compared equal to 1.8.19 and passed, even though a prerelease
  // PRECEDES its release and need not contain the fix. Both skipped provenance and
  // enforcement entirely. Adversarial review round 4, finding #2.
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  if (!m) return "unknown";
  const core = [Number(m[1]), Number(m[2]), Number(m[3])];
  const suffix = m[4];
  const min = [1, 8, 19];
  for (let i = 0; i < 3; i++) {
    if (core[i] < min[i]) return "below_floor";
    if (core[i] > min[i]) return "at_or_above"; // e.g. 1.9.0-rc still contains the fix
  }
  // Core is EXACTLY the floor. A bare "1.8.19" is the fixed release; anything with a
  // suffix could be a prerelease of it, and we cannot tell "-rc.1" from a distro
  // "-4" here, so we decline to call it safe and let provenance decide. In practice
  // `ipmitool -V` prints a bare upstream version, so this costs real hosts nothing.
  return suffix === "" ? "at_or_above" : "unknown";
}

interface DetectDeps {
  /** Override for tests. Runs `ipmitool -V` (direct; works unprivileged).
   *  Returns stdout or throws with err.code. Used only for the version /
   *  CVE gate. */
  runIpmitool?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Override for tests. The WRAPPED sensor probe (`sudo crucible-collect
   *  ipmi-sensor`). Returns stdout, or null on any failure. This is the
   *  availability signal: under the §2.1 unprivileged model the agent user
   *  cannot stat /dev/ipmi0 or run ipmitool directly, so a direct
   *  device-node probe is meaningless; the wrapper (which runs as root) is
   *  the real reachability test. */
  probeSensor?: () => Promise<string | null>;
  /** Restore the pre-2026-07-29 fail-closed behaviour: refuse to collect IPMI at
   *  all when `ipmitool -V` reads below MIN_SAFE_IPMITOOL_VERSION. Off by
   *  default because the check cannot see distro backports and therefore fires on
   *  suspicion rather than evidence; sourced from
   *  `collection.enforce_ipmitool_min_version`. */
  enforceMinVersion?: boolean;
  /** Override for tests. Distro-package attribution of the root-executed
   *  ipmitool; consulted ONLY when the version reads below the CVE floor. */
  attributeProvenance?: () => Promise<IpmitoolProvenance>;
  /** Override for tests. Resolves the binary sudo's secure_path would run as root. */
  resolveRootPath?: () => string | null;
}

async function defaultRunIpmitool(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: 2000,
    env: buildSubprocessEnv(),
  });
  return { stdout, stderr };
}

export async function detectIpmiCapability(deps: DetectDeps = {}): Promise<IpmiCapability> {
  const runIpmitool = deps.runIpmitool ?? defaultRunIpmitool;
  const probeSensor = deps.probeSensor ?? (() => runPrivileged("ipmi-sensor"));
  const enforceMinVersion = deps.enforceMinVersion ?? false;
  const attributeProvenance = deps.attributeProvenance ?? (() => attributeIpmitool());
  const resolveRootPath = deps.resolveRootPath ?? (() => resolveIpmitoolPath());

  // WHICH binary are we judging? It must be the one that runs AS ROOT, or the gate
  // inspects one file and the wrapper executes another. The wrapper does
  // `exec ipmitool` under sudo, so sudo's secure_path decides, and /usr/local/bin
  // precedes /usr/bin there. Probing bare "ipmitool" instead used the AGENT's
  // ambient PATH: with 1.8.19 first on the service PATH and an unowned 1.8.18 first
  // on sudo's, the version check passed, provenance was skipped, and the unpatched
  // one ran as root. Adversarial review 2026-07-30, finding #2.
  //
  // Falling back to bare "ipmitool" is deliberate and only for hosts with no match
  // in the secure_path list, which in practice means the root-direct installs (no
  // sudo wrapper) where the agent's own PATH IS the resolution root will use.
  const rootPath = resolveRootPath();
  const probeTarget = rootPath ?? "ipmitool";

  // Step 1: probe the ipmitool binary + version. `ipmitool -V` needs no BMC
  // access, so it works even as the unprivileged service user.
  let ipmitoolVersion: string | null = null;
  try {
    const { stdout } = await runIpmitool(probeTarget, ["-V"]);
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

  // Step 2: version check (CVE-2020-5208). Advisory for DISTRO-PACKAGED binaries,
  // fail-closed for everything else; see the block comment on
  // MIN_SAFE_IPMITOOL_VERSION. Attribution is only queried when the version
  // already reads below the floor, so hosts on 1.8.19+ pay nothing for it.
  const versionClass = classifyIpmitoolVersion(ipmitoolVersion);
  const unproven = versionClass !== "at_or_above"; // below the floor OR unparseable
  let provenance: IpmitoolProvenance | null = null;
  if (unproven) {
    const versionPhrase = versionClass === "below_floor"
      ? `ipmitool ${ipmitoolVersion} < ${MIN_SAFE_IPMITOOL_VERSION}`
      : `ipmitool reported an unrecognisable version (${ipmitoolVersion ?? "no version output"}), so it cannot be shown to be at or above ${MIN_SAFE_IPMITOOL_VERSION}`;
    if (enforceMinVersion) {
      return {
        available: false,
        reason: "ipmitool_cve_2020_5208",
        detail: `${versionPhrase}; enforcement is on (collection.enforce_ipmitool_min_version)`,
      };
    }
    provenance = await attributeProvenance();
    if (!provenance.attributed) {
      return {
        available: false,
        reason: "ipmitool_cve_2020_5208",
        detail: `${versionPhrase} and ${provenance.detail}; refusing to run it as root`,
      };
    }
  }

  // Step 3: reachability via the WRAPPED sensor probe. Non-empty output means
  // the BMC answered; empty/failure means no usable BMC on this host.
  try {
    const out = await probeSensor();
    if (out && out.trim().length > 0) {
      return {
        available: true,
        method: "ipmitool_in_band",
        ipmitool_version: ipmitoolVersion,
        // Only set when true, so snapshots from unaffected hosts are unchanged.
        ...(unproven ? { ipmitool_below_cve_floor: true } : {}),
        ...(unproven && provenance?.package ? { ipmitool_package: provenance.package } : {}),
      };
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
    // The advisory is appended rather than replacing the line: monitoring IS
    // working, and the operator should not read this as a failure.
    const advisory = cap.ipmitool_below_cve_floor
      ? `; note ipmitool reads < ${MIN_SAFE_IPMITOOL_VERSION} (CVE-2020-5208)${cap.ipmitool_package ? `, but it is the distro package ${cap.ipmitool_package}, and distros backport this fix without bumping the upstream version` : ", which many distros patch without bumping the version"}`
      : "";
    return `IPMI: available (${v}${cap.method.replace(/_/g, " ")})${advisory}`;
  }
  switch (cap.reason) {
    case "no_ipmitool_binary": return "IPMI: not available (ipmitool not installed)";
    case "no_bmc_device":      return "IPMI: not available (no /dev/ipmi*, BMC not detected)";
    case "permission_denied":  return `IPMI: not available (${cap.detail ?? "permission denied"})`;
    case "execution_failed":   return `IPMI: not available (execution failed${cap.detail ? `: ${cap.detail}` : ""})`;
    case "ipmitool_cve_2020_5208": return `IPMI: disabled (${cap.detail ?? "ipmitool too old (CVE-2020-5208)"})`;
  }
}
