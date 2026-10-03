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
// operational value: accept-rate signal from the three included
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
  /** Returns null when the line matched but is not an event: a benign
   *  form, or a regex accident. `following` holds the next few raw lines
   *  (the SCSI handler reads its Add. Sense / CDB detail from them). */
  parse(match: RegExpMatchArray, line: string, following: string[]): Omit<DmesgStructuredEvent, "timestamp_iso" | "raw_line"> | null;
}

// Sense key names as the kernel prints them (drivers/scsi/constants.c,
// snstext[]), indexed by key value for kernels built without
// CONFIG_SCSI_CONSTANTS, which print "Sense Key : 0x3".
const SENSE_KEYS = [
  "No Sense", "Recovered Error", "Not Ready", "Medium Error",
  "Hardware Error", "Illegal Request", "Unit Attention", "Data Protect",
  "Blank Check", "Vendor Specific", "Copy Aborted", "Aborted Command",
  "Equal", "Volume Overflow", "Miscompare", "Completed",
] as const;
// Not errors: "No Sense" and "Completed" report success.
const NON_ERROR_SENSE_KEYS = new Set(["No Sense", "Completed"]);
// The kernel follows a sense key line with "Add. Sense:" and "CDB:" lines
// for the same disk (scsi_print_sense, scsi_print_command).
const SCSI_DETAIL_RE = /\bsd \d+:\d+:\d+:\d+:\s+\[([A-Za-z0-9]{1,32})\]\s+(?:tag#\d+\s+)?(Add\. Sense|CDB):\s*(.{0,160})/;
const SCSI_DISABLE_RE = /\bsd \d+:\d+:\d+:\d+:\s+\[([A-Za-z0-9]{1,32})\]\s+.{0,80}\bdisabling (?:write same|discard)\b/i;
/** How many lines after a sense key line to read its Add. Sense and CDB from. */
const SENSE_DETAIL_LINES = 4;

function senseKeyOf(text: string): string | null {
  const hex = text.match(/^0x([0-9a-fA-F])\b/);
  if (hex) return SENSE_KEYS[Number.parseInt(hex[1], 16)];
  // Only a known key is taken, never the rest of the line.
  for (const key of SENSE_KEYS) {
    if (text.startsWith(key) && !/^[A-Za-z0-9]/.test(text.slice(key.length))) return key;
  }
  return null;
}

/**
 * A sense key that is the drive's normal answer to a feature probe, judged
 * from the Add. Sense and CDB lines that follow it for the same disk:
 *   - Recovered Error with "ATA pass through information available" is the
 *     status an ATA pass-through command (smartctl, hdparm, udisks) returns;
 *   - Illegal Request with "Invalid field in cdb" (or an unsupported opcode)
 *     on an ATA pass-through, WRITE SAME or UNMAP command, or followed by the
 *     kernel disabling write same or discard, is a feature the disk lacks.
 * Neither says anything about the media.
 */
function isProbeResponse(senseKey: string, device: string, following: string[]): boolean {
  if (senseKey !== "Recovered Error" && senseKey !== "Illegal Request") return false;
  let addSense = "";
  let cdb = "";
  let disabled = false;
  for (const line of following) {
    const detail = line.match(SCSI_DETAIL_RE);
    if (detail && detail[1] === device) {
      if (detail[2] === "CDB") cdb ||= detail[3];
      else addSense ||= detail[3];
      continue;
    }
    const off = line.match(SCSI_DISABLE_RE);
    if (off && off[1] === device) disabled = true;
  }
  if (senseKey === "Recovered Error") return /^ATA pass through information available\b/i.test(addSense);
  if (disabled) return true;
  return (
    /^(?:Invalid field in cdb|Invalid command operation code)\b/i.test(addSense) &&
    /^(?:ATA command pass through|Write same|Unmap)\b/i.test(cdb)
  );
}

/**
 * SCSI sense codes. Format observed across kernel 5.x and 6.x:
 *   sd 1:0:0:0: [sda] Sense Key : Medium Error [current]
 *   sd 2:0:0:0: [sdc] tag#18 Sense Key : Medium Error [current] [descriptor]
 *   sd 1:0:0:0: [sda] Add. Sense: Read retries exhausted
 *
 * We parse the Sense Key line; the Add. Sense / CDB lines that follow only
 * tell a feature-probe answer apart from a media fault. Sense Key alone is
 * the canonical severity signal: Medium Error / Hardware Error / Aborted
 * Command are P1 candidates. "No Sense", an unrecognised key, and a probe
 * answer (isProbeResponse) are not events.
 */
const SCSI_SENSE_HANDLER: DmesgHandler = {
  event_type: "scsi_sense",
  pattern: /\bsd \d+:\d+:\d+:\d+:\s+\[([A-Za-z0-9]{1,32})\]\s+(?:tag#\d+\s+)?Sense Key\s*:\s*(.*)$/,
  parse: (m, _line, following) => {
    const [, device, rest] = m;
    const sk = senseKeyOf(rest.trim());
    if (sk === null || NON_ERROR_SENSE_KEYS.has(sk) || isProbeResponse(sk, device, following)) return null;
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

// NVMe controller faults the driver answered with an abort, a controller
// reset or a disable (drivers/nvme/host/pci.c, core.c). The handler's
// keyword pattern alone also matched the benign boot line "Shutdown timeout
// set to 8 seconds" and the lost-interrupt "timeout, completion polled";
// neither is a controller reset.
const NVME_FAULT_RE =
  /\btimeout, (?:reset controller|aborting|disable controller)\b|\bcontroller is down; will reset\b|\breset(?:ting)? controller\b|\bDevice not ready; aborting reset\b|\bDisabling device after reset failure\b/i;

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
  parse: (m, line) => {
    if (!NVME_FAULT_RE.test(line)) return null;
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
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ts = parseDmesgTimestamp(line);
    if (ts !== null && ts < cutoffMs) continue;
    for (const handler of HANDLERS) {
      const m = line.match(handler.pattern);
      if (!m) continue;
      const partial = handler.parse(m, line, lines.slice(i + 1, i + 1 + SENSE_DETAIL_LINES));
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
