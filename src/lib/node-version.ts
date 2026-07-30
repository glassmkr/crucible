// Minimum supported Node.js version, and the pure helpers the preflight entry
// uses to enforce it.
//
// WHERE THE FLOOR COMES FROM. Exactly one dependency sets it: undici@8, whose
// webidl layer calls `markAsUncloneable` (from `node:worker_threads`) at import
// time. On a Node lacking that symbol, merely importing undici throws
// "TypeError: webidl.util.markAsUncloneable is not a function", and because
// src/index.ts imports undici transitively via endpoint-policy, the service
// crash-looped under Restart=always with a cryptic error. A Node 20 box on prod
// is what found it. Nothing else here needs a modern Node: tsconfig targets
// ES2022, `yaml` declares >= 14 and `zod` declares nothing.
//
// 2026-07-30: LOWERED FROM 24 TO 22.19.0, after measuring rather than assuming.
// The original guard was a MAJOR-ONLY comparison pinned at 24, written from a
// crash seen on Node 20, with a comment that hedged the real boundary as
// "~22.4 / 24". It was too strict in a way that cost real usability: it refused
// to start on Node 22 LTS, which held a fleet box back and would block any
// customer on that LTS from running a recent agent.
//
// Measured on a Linux host with a throwaway Node 22.22.2, all of which PASSED
// while the preflight was still refusing to start:
//   - `require("node:worker_threads").markAsUncloneable` is a function
//   - `import("undici")` succeeds; `fetch` and `Agent` both present
//   - importing dist/lib/endpoint-policy.js, the exact chain that crash-looped,
//     succeeds
//   - a real HTTPS request through the undici Agent returns 200
//   - `doctor ipmi` through the real CLI prints correct output
// The gate was the only thing broken.
//
// 22.19.0 is undici@8.8.0's own declared `engines.node`, so the floor is the
// dependency's answer instead of our guess. That also forces a FULL version
// comparison: a major-only check cannot express "22.19", and being unable to
// express it is exactly what pushed the original guard up to 24. Node 22.4 is
// genuinely too old and is still rejected.
//
// If undici is ever bumped, re-read its `engines.node` and move this with it.
//
// These helpers carry no side effects and import nothing, so the preflight entry
// (and its test) can use them without dragging in undici. The actual guard lives
// in src/preflight.ts, which runs BEFORE the real entry is imported.
export const MIN_NODE_VERSION = "22.19.0";

/**
 * Parse `major.minor.patch` from a `process.versions.node`-style string
 * ("22.22.2", "v24.0.0"). A missing minor or patch counts as 0, so "24" and
 * "v24.1" are usable. Returns null when there is no leading integer, so callers
 * can fail closed.
 */
export function parseNodeVersion(version: string): [number, number, number] | null {
  // ANCHORED AT BOTH ENDS, deliberately. Unanchored, this silently discarded any
  // suffix, so "22.19.0-rc.1", "22.19.0-nightly20260730", "22.19.0garbage" and
  // "v24junk" all parsed as satisfying the floor. A prerelease PRECEDES its release
  // in semver and may not carry the undici API at all, which would put us back at
  // the original import-time crash-loop that this guard exists to prevent, and a
  // string like "v24junk" is not a version we should be interpreting at any level.
  // Rejecting means failing closed, which is the right direction here: server hosts
  // run distro or NodeSource builds, never nightlies, so the practical cost is
  // approximately zero. Adversarial review 2026-07-30, finding #7.
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version.trim());
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((p) => (p === undefined ? 0 : Number(p)));
  if (parts.some((n) => !Number.isInteger(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/**
 * True when `version` is at least `minimum`, compared numerically per component.
 * String comparison would rank "22.9" above "22.19", which is the whole reason
 * this is not a one-liner. An unparseable version counts as too old, so we fail
 * closed rather than waving it through. Pure; unit-tested.
 */
export function nodeMeetsMinimum(version: string, minimum: string = MIN_NODE_VERSION): boolean {
  const have = parseNodeVersion(version);
  const need = parseNodeVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return true;
    if (have[i] < need[i]) return false;
  }
  return true; // exactly equal
}

/**
 * One-line, operator-facing reason the agent refuses to start on an old Node.
 * Printed to stderr by the preflight before exit(1). It names the version it
 * actually saw, because the operator's first question is always which Node the
 * service is really using, and it is frequently not the one on their PATH.
 */
export function oldNodeMessage(version: string, minimum: string = MIN_NODE_VERSION): string {
  return `[crucible] Refusing to start: glassmkr-crucible requires Node.js ${minimum} or newer, but this process is Node.js ${version}. Upgrade Node and restart the service; see https://github.com/glassmkr/crucible`;
}
