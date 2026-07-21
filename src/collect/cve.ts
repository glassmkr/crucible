// Distro-aware CVE collection for the running kernel.
//
// Pre-C13 the collector reads /sys/devices/system/cpu/vulnerabilities
// (Spectre / Meltdown / etc) under SecurityData.kernel_vulns. That's
// CPU microcode + kernel-mitigation status, not the distro CVE patch
// queue. C13 ships separate distro-CVE data so Dashboard can REDESIGN
// the kernel_vulnerabilities rule from a uptime-proxy / kernel-line
// check into a real CVE-driven signal.
//
// Three distro paths:
//
//   - Ubuntu / Ubuntu Pro:
//       Requires `pro security-status --format=json` AND attached pro
//       subscription. Token comes from GLASSMKR_UBUNTU_PRO_TOKEN env
//       var per the spec. No token => available: false silently
//       (legitimate state on non-Pro hosts).
//
//   - RHEL / Fedora / Rocky / Alma / CentOS:
//       `dnf updateinfo --output json` exposes a per-advisory list.
//       The dnf JSON output is well-defined on modern releases (8+);
//       older dnf falls back to text scraping which we tag as "stub".
//
//   - SUSE / openSUSE:
//       `zypper list-patches --category=security --severity=critical`
//       returns one line per patch. Severity is a column.
//
// Capability gating: missing CLI => available: false with reason.
// Distro detection uses snap.system.os_id (Crucible 0.8+ field); but
// since this collector is called separately from system.ts, we re-
// derive distro from /etc/os-release inside this module to stay
// independent.
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §3.

import { readProcFile } from "../lib/parse.js";
import { run } from "../lib/exec.js";
import { readOsReleaseField } from "./system.js";
import type { CveDistro, CveSeverity, CveSnapshot, KernelCve } from "../lib/types.js";

export async function collectCve(): Promise<CveSnapshot> {
  const distro = detectDistro();
  switch (distro) {
    case "ubuntu":
    case "debian":
      return collectUbuntuPro();
    case "rhel":
    case "fedora":
    case "rocky":
    case "alma":
    case "centos":
      return collectDnf(distro);
    case "sles":
    case "opensuse":
      return collectZypper(distro);
    default:
      return {
        available: false,
        reason: `distro "${distro}" not supported by CVE collection`,
        distro,
        kernel_cves_pending: [],
        total_critical_pending: 0,
        total_important_pending: 0,
        parser_quality: "stub",
      };
  }
}

function detectDistro(): CveDistro {
  const raw = readProcFile("/etc/os-release");
  if (!raw) return "unknown";
  return distroFromOsRelease(raw);
}

/**
 * Map an /etc/os-release ID field to a CveDistro. ID extraction is
 * delegated to system.ts's readOsReleaseField (the canonical reader,
 * already lowercases) so all three Crucible distro consumers parse the
 * ID line the same way; the family-mapping switch stays here because it
 * is CVE-collection-specific.
 */
function distroFromOsRelease(raw: string): CveDistro {
  const id = readOsReleaseField(raw, "ID");
  if (id === undefined) return "unknown";
  if (id === "ubuntu") return "ubuntu";
  if (id === "debian") return "debian";
  if (id === "rhel") return "rhel";
  if (id === "fedora") return "fedora";
  if (id === "rocky") return "rocky";
  if (id === "almalinux" || id === "alma") return "alma";
  if (id === "centos") return "centos";
  if (id === "sles") return "sles";
  if (id === "opensuse" || id === "opensuse-leap" || id === "opensuse-tumbleweed") {
    return "opensuse";
  }
  return "unknown";
}

// === Ubuntu Pro path ===

async function collectUbuntuPro(): Promise<CveSnapshot> {
  const token = process.env.GLASSMKR_UBUNTU_PRO_TOKEN;
  if (!token) {
    return {
      available: false,
      reason:
        "Ubuntu Pro token not set (export GLASSMKR_UBUNTU_PRO_TOKEN to enable CVE collection)",
      distro: "ubuntu",
      kernel_cves_pending: [],
      total_critical_pending: 0,
      total_important_pending: 0,
      parser_quality: "fleet-tested",
    };
  }
  const out = await run(
    "pro",
    ["security-status", "--format=json"],
    10000,
    { GLASSMKR_UBUNTU_PRO_TOKEN: token },
  );
  if (!out) {
    return {
      available: false,
      reason: "`pro security-status` returned no output (Ubuntu Pro CLI missing or not attached?)",
      distro: "ubuntu",
      kernel_cves_pending: [],
      total_critical_pending: 0,
      total_important_pending: 0,
      parser_quality: "fleet-tested",
    };
  }
  const parsed = parseUbuntuProJson(out);
  return {
    available: true,
    distro: "ubuntu",
    kernel_cves_pending: parsed.kernel_cves,
    total_critical_pending: parsed.critical,
    total_important_pending: parsed.important,
    parser_quality: "fleet-tested",
  };
}

/**
 * Parse the relevant kernel-CVE subset of `pro security-status --format=json`.
 * The full shape is large; we only need pending CVEs against the
 * running kernel + a severity histogram.
 *
 * Best-effort + defensive: malformed JSON yields zeros and no events.
 */
export function parseUbuntuProJson(raw: string): {
  kernel_cves: KernelCve[];
  critical: number;
  important: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kernel_cves: [], critical: 0, important: 0 };
  }
  // Ubuntu Pro JSON shape (abbreviated; real output has many more fields):
  //   { "summary": { "kernel-cves": { "pending": [{ "cve": "CVE-2026-1234",
  //     "severity": "high", "package": "linux-image-...", ... }] } } }
  // The exact key shape varies by pro CLI version; reach defensively.
  const root = parsed as {
    summary?: { "kernel-cves"?: { pending?: unknown[] } };
    "kernel-cves"?: unknown[];
  };
  const pendingArr =
    root?.summary?.["kernel-cves"]?.pending ??
    (root?.["kernel-cves"] as unknown[]) ??
    [];
  const cves: KernelCve[] = [];
  let crit = 0;
  let imp = 0;
  if (Array.isArray(pendingArr)) {
    for (const entry of pendingArr) {
      const e = entry as Record<string, unknown>;
      const cveId = typeof e.cve === "string" ? e.cve : "";
      if (!cveId) continue;
      const severity = normaliseSeverity(typeof e.severity === "string" ? e.severity : "");
      const pkg = typeof e.package === "string" ? e.package : "";
      const fixed = typeof e.fixed_version === "string" ? e.fixed_version : undefined;
      cves.push({
        cve_id: cveId,
        severity,
        package_name: pkg,
        ...(fixed ? { fixed_version: fixed } : {}),
      });
      if (severity === "critical") crit++;
      else if (severity === "important") imp++;
    }
  }
  return { kernel_cves: cves, critical: crit, important: imp };
}

// === dnf path (RHEL family) ===

async function collectDnf(distro: CveDistro): Promise<CveSnapshot> {
  const out = await run("dnf", [
    "updateinfo",
    "list",
    "--security",
    "--quiet",
  ]);
  if (!out) {
    return {
      available: false,
      reason: "`dnf updateinfo list --security` returned no output (dnf missing or no security advisories?)",
      distro,
      kernel_cves_pending: [],
      total_critical_pending: 0,
      total_important_pending: 0,
      parser_quality: "stub",
    };
  }
  const parsed = parseDnfUpdateinfoText(out);
  return {
    available: true,
    distro,
    kernel_cves_pending: parsed.kernel_cves,
    total_critical_pending: parsed.critical,
    total_important_pending: parsed.important,
    // Text scrape; dnf JSON output is the cleaner path but isn't
    // universally available across RHEL 8/9/10. Tagging stub so the
    // dashboard rule shows the right honesty.
    parser_quality: "stub",
  };
}

/**
 * Parse `dnf updateinfo list --security --quiet` text output.
 *
 * Format (one line per advisory; columns vary slightly by dnf version):
 *   RHSA-2026:1234 Critical/Sec.   kernel-5.14.0-1234.x86_64
 *   RHBA-2026:5678 Moderate/Sec.   bash-5.1.8-9.el9_4.x86_64
 *
 * We only keep advisories whose package name starts with "kernel"
 * (the kernel meta-package or any kernel-* sub-package).
 */
export function parseDnfUpdateinfoText(raw: string): {
  kernel_cves: KernelCve[];
  critical: number;
  important: number;
} {
  const cves: KernelCve[] = [];
  let crit = 0;
  let imp = 0;
  for (const line of raw.split("\n")) {
    const m = line.match(
      /^([A-Z]+-\d{4}:\d+)\s+(\S+)\/Sec\.\s+(\S+)/i,
    );
    if (!m) continue;
    const [, advisory, sevToken, pkg] = m;
    if (!pkg.toLowerCase().startsWith("kernel")) continue;
    const severity = normaliseSeverity(sevToken);
    cves.push({
      cve_id: advisory, // dnf reports advisory IDs (RHSA-...) not CVE IDs directly
      severity,
      package_name: pkg,
    });
    if (severity === "critical") crit++;
    else if (severity === "important") imp++;
  }
  return { kernel_cves: cves, critical: crit, important: imp };
}

// === zypper path (SUSE family) ===

async function collectZypper(distro: CveDistro): Promise<CveSnapshot> {
  const out = await run("zypper", [
    "--non-interactive",
    "list-patches",
    "--category=security",
  ]);
  if (!out) {
    return {
      available: false,
      reason: "`zypper list-patches --category=security` returned no output (zypper missing?)",
      distro,
      kernel_cves_pending: [],
      total_critical_pending: 0,
      total_important_pending: 0,
      parser_quality: "stub",
    };
  }
  const parsed = parseZypperListPatchesText(out);
  return {
    available: true,
    distro,
    kernel_cves_pending: parsed.kernel_cves,
    total_critical_pending: parsed.critical,
    total_important_pending: parsed.important,
    parser_quality: "stub",
  };
}

/**
 * Parse `zypper list-patches --category=security` table output.
 *
 * Format (columns: Repository | Name | Category | Severity | Status):
 *   SLES15-SP6-Updates | SUSE-SLE-...-1234 | security | critical | needed
 *
 * We restrict to security patches whose name contains "kernel" — best
 * effort; zypper doesn't surface a "package" column the same way dnf
 * does, so the kernel match is on the patch name itself.
 */
export function parseZypperListPatchesText(raw: string): {
  kernel_cves: KernelCve[];
  critical: number;
  important: number;
} {
  const cves: KernelCve[] = [];
  let crit = 0;
  let imp = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes("|")) continue;
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length < 5) continue;
    const [, name, category, severityRaw] = cols;
    if (!/security/i.test(category)) continue;
    if (!/kernel/i.test(name)) continue;
    const severity = normaliseSeverity(severityRaw);
    cves.push({
      cve_id: name,
      severity,
      package_name: name,
    });
    if (severity === "critical") crit++;
    else if (severity === "important") imp++;
  }
  return { kernel_cves: cves, critical: crit, important: imp };
}

// === shared helpers ===

function normaliseSeverity(raw: string): CveSeverity {
  const v = raw.toLowerCase().trim();
  if (v === "critical" || v === "crit") return "critical";
  if (v === "important" || v === "high" || v === "imp") return "important";
  if (v === "moderate" || v === "medium" || v === "med") return "moderate";
  if (v === "low" || v === "negligible") return "low";
  return "unknown";
}

export const __test_only = {
  detectDistro,
  distroFromOsRelease,
  normaliseSeverity,
};
