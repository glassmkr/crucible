// Single source of truth for the Crucible version string at runtime.
// Read from package.json so a release bump propagates everywhere
// (notification footers, version-check log lines, --version flag, the
// `collector_version` field on every snapshot) without anyone having to
// remember to update a hardcoded constant.
//
// Returns "0.0.0" on read failure rather than throwing; the agent has to
// keep running even if its package.json is somehow missing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Injected at single-file-binary build time via `bun build --compile --define`
// (see scripts/build-binaries.sh). A compiled binary has no package.json on
// disk next to it, so without this it would self-report "0.0.0" in every
// snapshot's collector_version. Undefined under node/tsc, where the file
// read below is the source of truth.
declare const CRUCIBLE_INJECTED_VERSION: string | undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPkgVersion(): string {
  if (typeof CRUCIBLE_INJECTED_VERSION === "string" && CRUCIBLE_INJECTED_VERSION) {
    return CRUCIBLE_INJECTED_VERSION;
  }
  // src/lib/version.ts -> ../../package.json under src layout, but at
  // runtime (compiled to dist/lib/version.js) it's still ../../package.json.
  // Both paths resolve correctly because package.json sits one level above
  // dist/ AND one level above src/.
  for (const candidate of [
    join(__dirname, "..", "..", "package.json"),
    join(__dirname, "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg && typeof pkg.version === "string") return pkg.version;
    } catch { /* try next */ }
  }
  return "0.0.0";
}

export const CRUCIBLE_VERSION = readPkgVersion();
