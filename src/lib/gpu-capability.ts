// Capability discovery for GPU telemetry.
//
// WHY THIS EXISTS. The recurring defect in this subsystem is that "we could not
// read it" and "we read it and the answer is zero" collapse into the same value.
// `collectNvLinkBasic` is the live example: it returns `[]` both when the GPU has
// no NVLink at all and when `nvidia-smi nvlink` failed, which are opposite facts.
// On our own L4 that produces an empty link list which a rule could read as "every
// link is gone".
//
// The 2026-08-02 GPU research made this a first-class design rule, because the
// NVIDIA surface is unusually hostile to the naive approach:
//
//   - the same command exists on hardware that has no NVLink at all, and simply
//     prints nothing;
//   - NVIDIA does not guarantee `nvidia-smi` output is stable across driver
//     releases, so a parse can start failing after an upgrade with no other sign;
//   - some reads are documented as needing administrator privilege on some driver
//     branches and not others;
//   - fields get renamed and deprecated (the `nvidia-smi -q` fabric schema already
//     has), and a renamed field reads as absent.
//
// Each of those needs a DIFFERENT operator response, so they must not share a
// representation. We have shipped this bug twice before at the field level: the
// v0.13.0 `retired_pages.double_bit_ecc` typo and the v0.13.2
// `clocks_event_reasons` rename both had nvidia-smi exit 0 while stderr said the
// field was unknown, and both were processed as "no data" for about a day.

/**
 * Why a telemetry read produced no usable value. `supported` is the only status
 * that carries data; every other status means the accompanying value is absent,
 * NOT zero, and no rule may treat it as a measurement.
 */
export type GpuCapabilityStatus =
  /** Read succeeded and the value is usable. */
  | "supported"
  /** The hardware or driver genuinely does not have this. An L4 has no NVLink. */
  | "not_supported"
  /** The read exists but this user may not perform it. Often fixable with a wrapper action. */
  | "permission_denied"
  /** Transient: timeout, device busy, driver reloading. Retry next cycle. */
  | "temporarily_unavailable"
  /** The command ran but its output did not match what we know how to read. */
  | "parse_or_api_mismatch"
  /** The binary is not installed at all. */
  | "tool_absent";

export interface GpuCapability {
  /** Stable identifier for the probe, e.g. "nvlink.status". */
  probe: string;
  status: GpuCapabilityStatus;
  /** Short operator-facing reason. Null when supported. */
  detail: string | null;
}

/** Markers NVIDIA tooling uses when a feature is absent rather than broken. */
const NOT_SUPPORTED_MARKERS = [
  "not supported",
  "n/a",
  "does not support",
  "unsupported",
  "no devices with nvlink",
  "nvlink is not supported",
];

const PERMISSION_MARKERS = [
  "insufficient permission",
  "permission denied",
  "requires root",
  "administrator privileges",
  "operation not permitted",
];

const TRANSIENT_MARKERS = [
  "in use by another",
  "device is busy",
  "try again",
  "resource temporarily unavailable",
  "driver/library version mismatch",
  "has fallen off the bus",
];

/**
 * Markers meaning the command ran but we asked for something it did not recognise.
 * This is the silent-rename class: nvidia-smi exits 0 and says so only on stderr.
 */
const FIELD_MISMATCH_MARKERS = [
  "field not found",
  "unknown field",
  "invalid combination of input arguments",
  "not a valid",
  "unrecognized",
];

function matches(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
}

/**
 * Classify one probe from the raw subprocess outcome.
 *
 * `hasUsableContent` lets the caller apply its own emptiness test, because empty
 * stdout is ambiguous on its own: for `nvlink --status` it means no NVLink, for
 * `topo -m` it means the parse failed. The caller knows which.
 */
export function classifyProbe(
  probe: string,
  res: { installed: boolean; exitCode: number | null; stdout: string | null; stderr: string; timedOut: boolean },
  hasUsableContent: (stdout: string) => boolean,
): GpuCapability {
  if (!res.installed) {
    return { probe, status: "tool_absent", detail: "binary not installed" };
  }
  if (res.timedOut) {
    return { probe, status: "temporarily_unavailable", detail: "timed out" };
  }

  const stderr = res.stderr ?? "";

  // stderr is checked BEFORE exit code on purpose. nvidia-smi exits 0 while
  // reporting an unknown field on stderr; that is the exact shape that hid two
  // field renames for a day each.
  if (matches(stderr, PERMISSION_MARKERS)) {
    return { probe, status: "permission_denied", detail: firstLine(stderr) };
  }
  if (matches(stderr, FIELD_MISMATCH_MARKERS)) {
    return { probe, status: "parse_or_api_mismatch", detail: firstLine(stderr) };
  }
  if (matches(stderr, NOT_SUPPORTED_MARKERS)) {
    return { probe, status: "not_supported", detail: firstLine(stderr) };
  }
  if (matches(stderr, TRANSIENT_MARKERS)) {
    return { probe, status: "temporarily_unavailable", detail: firstLine(stderr) };
  }

  if (res.exitCode !== 0) {
    // A nonzero exit with no recognised marker. run() preserves stdout here, and
    // some NVIDIA tools print the real explanation to stdout, so check it too.
    const combined = `${stderr}\n${res.stdout ?? ""}`;
    if (matches(combined, NOT_SUPPORTED_MARKERS)) {
      return { probe, status: "not_supported", detail: firstLine(combined) };
    }
    return {
      probe,
      status: "parse_or_api_mismatch",
      detail: `exit ${res.exitCode}${stderr ? ": " + firstLine(stderr) : ""}`,
    };
  }

  const stdout = res.stdout ?? "";
  if (matches(stdout, NOT_SUPPORTED_MARKERS)) {
    return { probe, status: "not_supported", detail: firstLine(stdout) };
  }
  if (!hasUsableContent(stdout)) {
    // Exit 0, nothing we recognise, no marker. EMPTY output means the feature
    // is absent: on an L4 this is what `nvlink --status` does, and treating it
    // as "supported with zero links" is the bug this whole module exists to
    // prevent. NONEMPTY output that fails the caller's content test is a
    // different animal (Codex 2026-08-29 #15): the tool ran and said
    // something we could not read, which is the exact shape a driver
    // output-format change produces. Filing that under not_supported makes a
    // broken parser look like absent hardware, silently and forever;
    // parse_or_api_mismatch is the status that gets a human to look.
    if (stdout.trim() === "") {
      return { probe, status: "not_supported", detail: "no output and no error" };
    }
    return { probe, status: "parse_or_api_mismatch", detail: `unrecognized output: ${firstLine(stdout)}` };
  }

  return { probe, status: "supported", detail: null };
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]!.slice(0, 160);
}

/** True only when the probe produced a real measurement. */
export function isMeasured(c: GpuCapability | undefined | null): boolean {
  return c?.status === "supported";
}
