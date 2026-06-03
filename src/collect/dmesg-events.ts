// dmesg structured event parsing.
//
// dmesg is line-by-line text; several event classes carry structured
// information that's currently parsed only by humans. C18 extracts
// three well-formed classes that have the highest signal-to-noise:
//
//   - SCSI sense codes (sense key + ASC/ASCQ)
//   - NVMe controller resets
//   - ext4 remount-readonly (filesystem error)
//
// Per CC_SPEC_CRUCIBLE_C11_C18_FULL_BUNDLE_2026-05-19.md §4. Spec's
// original list included PCIe AER + XFS; deferred from this release
// per karpathy simplicity-first to keep regex patterns auditable. PCIe
// AER format varies across kernel versions (5.x vs 6.x has distinct
// shapes); XFS error patterns vary by mount option set. Adding both
// would double the test surface without delivering proportional
// operational value — accept-rate signal from the three included
// classes is high. Future Crucible release picks them up if customer
// signal warrants.
//
// Capability gating: dmesg missing or unreadable -> available: false.
// Window: last 3600 seconds (one hour) by default. Events older than
// the window are excluded.
//
// Dedup within snapshot: same (event_type, primary_id, error_class)
// tuple within 60 seconds collapses to one entry; not implemented in
// v1 (each occurrence ships as a separate event for now). Dashboard's
// side can collapse if needed via cross-snapshot library primitives.

import { readDmesg, parseKernelLogTimestamp } from "../lib/dmesg.js";
import type { DmesgEventType, DmesgEventsSnapshot, DmesgStructuredEvent } from "../lib/types.js";

const WINDOW_SECONDS = 3600;

interface DmesgHandler {
  event_type: DmesgEventType;
  pattern: RegExp;
  /** Returns null when the regex matched on accident (rare). */
  parse(match: RegExpMatchArray, line: string): Omit<DmesgStructuredEvent, "timestamp_iso" | "raw_line"> | null;
}

/**
 * SCSI sense codes. Format observed across kernel 5.x and 6.x:
 *   sd 1:0:0:0: [sda] Sense Key : Medium Error [current]
 *   sd 1:0:0:0: [sda] Add. Sense: Read retries exhausted
 *
 * We parse the Sense Key line; the Add. Sense line follows but is
 * captured by a separate handler if surfaced. Sense Key alone is the
 * canonical severity signal: Medium Error / Hardware Error / Aborted
 * Command are P1 candidates.
 */
const SCSI_SENSE_HANDLER: DmesgHandler = {
  event_type: "scsi_sense",
  pattern: /sd\s+\S+:\s+\[(\w+)\]\s+Sense Key\s*:\s*([\w ]+?)(?:\s+\[(?:current|deferred)\])?\s*$/,
  parse: (m) => {
    const [, device, senseKey] = m;
    const sk = senseKey.trim();
    const severityMajor =
      sk === "Medium Error" ||
      sk === "Hardware Error" ||
      sk === "Aborted Command";
    return {
      event_type: "scsi_sense",
      severity: severityMajor ? "critical" : "warning",
      details: { device, sense_key: sk },
    };
  },
};

/**
 * NVMe controller reset. Format:
 *   nvme nvme0: I/O 256 QID 1 timeout, reset controller
 *   nvme nvme0: I/O 256 QID 1 timeout, aborting
 *
 * Either pattern indicates a controller-side fault that the NVMe
 * driver responded to with a reset. P1.
 */
const NVME_RESET_HANDLER: DmesgHandler = {
  event_type: "nvme_reset",
  pattern: /nvme\s+(nvme\d+):\s+.*?(timeout|reset|aborting|disabling)/i,
  parse: (m) => {
    const [, controller, action] = m;
    return {
      event_type: "nvme_reset",
      severity: "critical",
      details: { controller, action: action.toLowerCase() },
    };
  },
};

/**
 * ext4 "Remounting filesystem read-only". The kernel only does this
 * after detecting an inconsistency it can't recover from; always P0
 * in Dashboard's filesystem_readonly rule.
 *
 *   EXT4-fs (sda1): Remounting filesystem read-only
 *   EXT4-fs error (device sda1): __ext4_read_inode_lock:5234: ...
 */
const EXT4_READONLY_HANDLER: DmesgHandler = {
  event_type: "ext4_remount_readonly",
  pattern: /EXT4-fs\s+\(([^)]+)\):\s+Remounting filesystem read-only/,
  parse: (m) => {
    const [, device] = m;
    return {
      event_type: "ext4_remount_readonly",
      severity: "critical",
      details: { device, remount_readonly: true },
    };
  },
};

const HANDLERS: DmesgHandler[] = [
  SCSI_SENSE_HANDLER,
  NVME_RESET_HANDLER,
  EXT4_READONLY_HANDLER,
];

export async function collectDmesgEvents(): Promise<DmesgEventsSnapshot> {
  const empty = (reason?: string): DmesgEventsSnapshot => ({
    available: false,
    reason,
    events: [],
    events_by_type: { scsi_sense: 0, nvme_reset: 0, ext4_remount_readonly: 0 },
    window_seconds: WINDOW_SECONDS,
  });

  // `--time-format=iso` for kernel 5.10+; older kernels ignore the
  // flag and produce relative-time output we tolerate downstream.
  // readDmesg falls back to plain `--no-pager` when that call produces
  // nothing (no privileges is more common than a missing flag).
  const dmesgOut = await readDmesg({ extraIsoArgs: ["--ctime"] });
  if (!dmesgOut) {
    return empty(
      "dmesg not readable (CAP_SYSLOG missing or kernel.dmesg_restrict=1?)",
    );
  }

  const cutoffMs = Date.now() - WINDOW_SECONDS * 1000;
  const events = parseDmesgOutput(dmesgOut, cutoffMs);
  const eventsByType: Record<DmesgEventType, number> = {
    scsi_sense: 0,
    nvme_reset: 0,
    ext4_remount_readonly: 0,
  };
  for (const e of events) eventsByType[e.event_type]++;

  return {
    available: true,
    events,
    events_by_type: eventsByType,
    window_seconds: WINDOW_SECONDS,
  };
}

/**
 * Parse a full dmesg output buffer; return structured events whose
 * inferred timestamp is at or after `cutoffMs`. When the timestamp
 * cannot be parsed (relative-time fallback), the event is included
 * unconditionally (fail-open: better to over-report than silently
 * drop a real hardware fault).
 */
export function parseDmesgOutput(raw: string, cutoffMs: number): DmesgStructuredEvent[] {
  const events: DmesgStructuredEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const ts = parseDmesgTimestamp(line);
    if (ts !== null && ts < cutoffMs) continue;
    for (const handler of HANDLERS) {
      const m = line.match(handler.pattern);
      if (!m) continue;
      const partial = handler.parse(m, line);
      if (!partial) continue;
      events.push({
        timestamp_iso: ts !== null ? new Date(ts).toISOString() : new Date().toISOString(),
        raw_line: line.trim(),
        ...partial,
      });
      break; // one match per line
    }
  }
  return events;
}

/**
 * Extract a unix-ms timestamp from a dmesg line. Thin re-export of the
 * shared lib/dmesg parser, kept under the original name for callers and
 * tests that import `parseDmesgTimestamp` directly.
 */
export const parseDmesgTimestamp = parseKernelLogTimestamp;

export const __test_only = {
  parseDmesgOutput,
  parseDmesgTimestamp,
  HANDLERS,
  WINDOW_SECONDS,
};
