// Minimum supported Node.js major version, and the pure helpers the
// preflight entry uses to enforce it.
//
// 0.14.6 pulled in undici@8, whose webidl layer calls
// `webidl.util.markAsUncloneable` at import time. That symbol only exists
// on Node >= ~22.4 / 24, so merely importing undici on an older Node (a
// Node 20 box was found on prod) throws
// "TypeError: webidl.util.markAsUncloneable is not a function" and the
// service crash-loops under Restart=always with a cryptic error.
//
// These helpers carry no side effects and import nothing, so the preflight
// entry (and its test) can use them without dragging in undici. The actual
// guard lives in src/preflight.ts, which runs BEFORE the real entry is
// imported.
export const MIN_NODE_MAJOR = 24;

// Parse the major version out of a `process.versions.node`-style string
// ("20.11.1", "v24.0.0"). Returns null when the shape is not recognisable
// so callers can fail closed.
export function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : null;
}

// True when `version` is a recognisable Node version whose major is at
// least `minimum`. An unparseable version is treated as too old (fail
// closed) rather than waved through.
export function nodeMajorMeetsMinimum(version: string, minimum: number = MIN_NODE_MAJOR): boolean {
  const major = parseNodeMajor(version);
  return major !== null && major >= minimum;
}

// One-line, operator-facing reason the agent refuses to start on an old
// Node. Printed to stderr by the preflight before exit(1).
export function oldNodeMessage(version: string, minimum: number = MIN_NODE_MAJOR): string {
  return `[crucible] Refusing to start: glassmkr-crucible requires Node.js ${minimum} or newer, but this process is Node.js ${version}. Upgrade Node and restart the service; see https://github.com/glassmkr/crucible`;
}
