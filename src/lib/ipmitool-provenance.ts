// Is the ipmitool binary that runs AS ROOT owned by a distro package?
//
// WHY THIS EXISTS. CVE-2020-5208 is fixed upstream in ipmitool 1.8.19, but Debian,
// Ubuntu and RHEL all backport the six patches into 1.8.18 packages WITHOUT bumping
// the upstream version, and `ipmitool -V` reports only the bare upstream version.
// So a version compare alone cannot tell a patched distro build from an unpatched
// one, which is why the version check was demoted to an advisory on 2026-07-29.
//
// An adversarial review on 2026-07-30 pointed out what that demotion also allowed:
// a GENUINELY unpatched binary (a source build, a vendor tarball, anything not from
// the distro) now runs as root via the sudo wrapper, unattended, on every snapshot.
// A compromised BMC is not the same thing as root on the running OS, so that is a
// new capability for an attacker, not merely a loss of stealth. Distro attribution
// is the missing evidence: if the package manager owns the file, the distro's
// backport policy covers it and the advisory is right; if nothing owns it, we have
// no patch story at all and must not run it as root.
//
// HOW THE PATH IS RESOLVED, and why it is not process.env.PATH. The wrapper does
// `exec ipmitool sensor` as root under sudo, so what actually runs privileged is
// whatever sudo's secure_path resolves. Verified on Debian 13 (2026-07-30):
// secure_path is /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin, so
// /usr/local/bin PRECEDES /usr/bin. A source build installed with the ipmitool
// default prefix lands in /usr/local/bin and SHADOWS the distro package. Proven
// end to end on that host: a stub placed at /usr/local/bin/ipmitool was what
// `sudo crucible-collect ipmi-sensor` executed, and dpkg-query correctly disowned
// it. We resolve from this fixed list rather than the inherited environment so the
// answer does not depend on the service manager's PATH, which is separate config
// from sudoers and can drift from it.
//
// RESIDUAL GAPS, stated rather than papered over. Neither is a privilege gain,
// because both already require root:
//   - a root user who overwrites a PACKAGED path in place still reads as
//     attributed (dpkg/rpm own the path, not the bytes). `dpkg -V` would catch it
//     by checksum; not done, since an attacker who can write /usr/bin needs no CVE.
//   - a non-default sudoers secure_path pointing outside the list below would make
//     us attribute a different file than the one root execs.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSubprocessEnv } from "./exec.js";

const execFileAsync = promisify(execFile);

/** The directories sudo's default secure_path searches, IN ORDER. The first
 *  ipmitool found here is the one the wrapper execs as root. */
export const SECURE_PATH_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

export interface IpmitoolProvenance {
  /** The binary root would exec, or null when none was found in SECURE_PATH_DIRS. */
  path: string | null;
  /** True only on POSITIVE evidence that a distro package owns `path`. */
  attributed: boolean;
  /** Package identity including the distro EVR, e.g. "ipmitool 1.8.18-11ubuntu2.2".
   *  This is the release suffix `ipmitool -V` hides, so it is the useful thing to
   *  show an operator. Null when unattributed. */
  package: string | null;
  /** Short human-readable reason, always set; goes into the capability detail. */
  detail: string;
}

export interface ProvenanceDeps {
  exists?: (p: string) => boolean;
  /** Runs a package-manager query. Must reject when the command is missing or
   *  the query finds no owner. */
  run?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}

async function defaultRun(cmd: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 5000,
    env: buildSubprocessEnv(),
  });
  return { stdout };
}

/**
 * First ipmitool in SECURE_PATH_DIRS, or null. Pure apart from the injected
 * `exists`; unit-tested.
 */
export function resolveIpmitoolPath(deps: ProvenanceDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  for (const dir of SECURE_PATH_DIRS) {
    const candidate = `${dir}/ipmitool`;
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable directory is not evidence either way; keep looking.
    }
  }
  return null;
}

/**
 * Owning package from `dpkg-query -S` output, or null.
 *
 * Requires a line of the form `<packages>: <path>` whose path matches EXACTLY, so a
 * diagnostic line or an answer about a different file cannot be mistaken for the
 * package name. `<packages>` may be a comma-separated list when several packages
 * ship the path; the first is enough to establish distro origin. Exported for tests.
 */
export function parseDpkgOwner(stdout: string, path: string): string | null {
  for (const line of stdout.split("\n")) {
    const idx = line.lastIndexOf(": ");
    if (idx <= 0) continue;
    const left = line.slice(0, idx).trim();
    const right = line.slice(idx + 2).trim();
    if (right !== path) continue;
    const pkg = left.split(",")[0]?.trim();
    if (!pkg || /\s/.test(pkg)) continue; // a real package name has no whitespace
    return pkg;
  }
  return null;
}

/**
 * Attribute the root-executed ipmitool to a distro package.
 *
 * FAILS CLOSED BY DESIGN: every unknown (no binary found, no package manager
 * present, query error, unparseable output) returns `attributed: false`. The
 * caller only consults this when the version already reads below the CVE floor,
 * so the conservative direction costs monitoring ONLY on a host that is both
 * below the floor and unable to prove a distro origin.
 */
export async function attributeIpmitool(deps: ProvenanceDeps = {}): Promise<IpmitoolProvenance> {
  const run = deps.run ?? defaultRun;
  const path = resolveIpmitoolPath(deps);
  if (!path) {
    return {
      path: null,
      attributed: false,
      package: null,
      detail: `no ipmitool found in ${SECURE_PATH_DIRS.join(":")}`,
    };
  }

  // Debian family. `dpkg-query -S` resolves a path to its owning package and exits
  // non-zero when nothing owns it; the second call adds the EVR.
  //
  // PARSE IT PROPERLY, and treat a DIVERSION as disqualifying. `dpkg-query -S` can
  // prefix its answer with diagnostics such as
  //   local diversion from: /usr/bin/ipmitool
  //   local diversion to: /usr/bin/ipmitool.distrib
  // and a naive `stdout.split(":")[0]` read "local diversion from" as the package
  // name and reported attributed:true. That is not a cosmetic parse bug: a dpkg
  // diversion is exactly how an unpatched binary gets placed AT the packaged path
  // while the real packaged file is moved aside, so the naive parse handed the root
  // wrapper the one file it was built to refuse. Adversarial review 2026-07-30,
  // finding #3.
  //
  // So: if any diversion line mentions this path, we cannot trust path -> package
  // and report UNATTRIBUTED. Otherwise we require a line whose right-hand side is
  // EXACTLY the queried path, and take its left-hand side as the owning package.
  try {
    const { stdout } = await run("dpkg-query", ["-S", path]);
    if (/^\s*(local diversion|diversion by)\b/im.test(stdout)) {
      return {
        path,
        attributed: false,
        package: null,
        detail: `${path} is subject to a dpkg diversion, so the packaged file has been moved aside and the file at this path cannot be attributed to it`,
      };
    }
    const pkg = parseDpkgOwner(stdout, path);
    if (pkg) {
      let evr = "";
      try {
        const v = await run("dpkg-query", ["-W", "-f=${Version}", pkg]);
        evr = v.stdout.trim();
      } catch {
        // Owned but version unreadable: still attributed, just less informative.
      }
      return {
        path,
        attributed: true,
        package: evr ? `${pkg} ${evr}` : pkg,
        detail: `${path} is owned by dpkg package ${evr ? `${pkg} ${evr}` : pkg}`,
      };
    }
  } catch {
    // Not a dpkg host, or the path is unowned. Fall through to rpm.
  }

  // RHEL family. `rpm -qf` prints the owning package NEVR and exits non-zero
  // with "not owned by any package" otherwise.
  try {
    const { stdout } = await run("rpm", ["-qf", "--queryformat", "%{NAME} %{EVR}", path]);
    const owner = stdout.trim();
    if (owner && !/not owned/i.test(owner)) {
      return {
        path,
        attributed: true,
        package: owner,
        detail: `${path} is owned by rpm package ${owner}`,
      };
    }
  } catch {
    // Not an rpm host, or the path is unowned.
  }

  return {
    path,
    attributed: false,
    package: null,
    detail: `${path} is not owned by any dpkg or rpm package, so it is a source, vendor or hand-installed build with no distro backport guarantee`,
  };
}
