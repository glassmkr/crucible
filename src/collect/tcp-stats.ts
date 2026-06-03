// TCP statistics from /proc/net/snmp + /proc/net/netstat.
//
// Per CC_SPEC_CRUCIBLE_C7_C10_NETWORK_PROCESS_COLLECTION_2026-05-19.md §4.
//
// Two source files:
//   - /proc/net/snmp `Tcp:` section: OutSegs, RetransSegs, InSegs (the
//     canonical TCP counters; stable across kernel versions).
//   - /proc/net/netstat `TcpExt:` section: ListenOverflows, ListenDrops
//     (extended counters; used for the listen_overflow rule). Spec §8
//     left this as Phase-0 decision; folded in because parsing
//     /proc/net/netstat once is cheap and listen_overflow is a
//     subordinate the Dashboard side wants.
//
// Rate calculation mirrors vmstat (C3) and conntrack (C9): module-level
// previous-counters Map, null rates on first snapshot, counter-reset
// detection.

import { parseColumnarStat, readProcFile } from "../lib/parse.js";

export interface TcpStatsSnapshot {
  available: boolean;
  reason?: string;
  // Cumulative counters from /proc/net/snmp `Tcp:`.
  out_segs_total?: number;
  retrans_segs_total?: number;
  in_segs_total?: number;
  // Retransmit metrics over the most recent interval (null on first
  // snapshot or after counter reset).
  retrans_ratio?: number | null;
  retrans_rate_per_sec?: number | null;
  // Cumulative counters from /proc/net/netstat `TcpExt:` (listen-queue
  // signals). Optional because /proc/net/netstat may not exist on
  // pathological / minimal kernels.
  listen_overflows_total?: number;
  listen_drops_total?: number;
  listen_overflows_rate_per_sec?: number | null;
  listen_drops_rate_per_sec?: number | null;
}

interface CounterSnapshot {
  out_segs: number;
  retrans_segs: number;
  in_segs: number;
  listen_overflows: number | null;
  listen_drops: number | null;
  capturedAtMs: number;
}

let previous: CounterSnapshot | null = null;

export function collectTcpStats(): TcpStatsSnapshot {
  const snmp = parseTcpSnmp();
  if (!snmp) {
    return {
      available: false,
      reason: "/proc/net/snmp Tcp counters unavailable",
    };
  }
  const ext = parseTcpExt(); // may be null on kernels without netstat

  const nowMs = Date.now();
  let retransRatio: number | null = null;
  let retransRatePerSec: number | null = null;
  let listenOverflowsRate: number | null = null;
  let listenDropsRate: number | null = null;

  if (previous) {
    const elapsedSec = (nowMs - previous.capturedAtMs) / 1000;
    if (elapsedSec > 0) {
      const outDelta = snmp.out_segs - previous.out_segs;
      const retransDelta = snmp.retrans_segs - previous.retrans_segs;
      // Counter reset / wraparound: leave rates null.
      if (outDelta >= 0 && retransDelta >= 0) {
        retransRatio = outDelta > 0 ? retransDelta / outDelta : 0;
        retransRatePerSec = retransDelta / elapsedSec;
      }
      if (
        ext &&
        previous.listen_overflows !== null &&
        previous.listen_drops !== null
      ) {
        const oDelta = ext.listen_overflows - previous.listen_overflows;
        const dDelta = ext.listen_drops - previous.listen_drops;
        if (oDelta >= 0) listenOverflowsRate = oDelta / elapsedSec;
        if (dDelta >= 0) listenDropsRate = dDelta / elapsedSec;
      }
    }
  }

  previous = {
    out_segs: snmp.out_segs,
    retrans_segs: snmp.retrans_segs,
    in_segs: snmp.in_segs,
    listen_overflows: ext ? ext.listen_overflows : null,
    listen_drops: ext ? ext.listen_drops : null,
    capturedAtMs: nowMs,
  };

  const out: TcpStatsSnapshot = {
    available: true,
    out_segs_total: snmp.out_segs,
    retrans_segs_total: snmp.retrans_segs,
    in_segs_total: snmp.in_segs,
    retrans_ratio: retransRatio,
    retrans_rate_per_sec: retransRatePerSec,
  };
  if (ext) {
    out.listen_overflows_total = ext.listen_overflows;
    out.listen_drops_total = ext.listen_drops;
    out.listen_overflows_rate_per_sec = listenOverflowsRate;
    out.listen_drops_rate_per_sec = listenDropsRate;
  }
  return out;
}

/**
 * Parse /proc/net/snmp's `Tcp:` two-line section (header + values).
 *
 * Lines look like:
 *   Tcp: RtoAlgorithm RtoMin ... InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors
 *   Tcp: 1 200 ... 9876543 8765432 1234 0 100 0
 */
export function parseTcpSnmp(): {
  out_segs: number;
  retrans_segs: number;
  in_segs: number;
} | null {
  const raw = readProcFile("/proc/net/snmp");
  if (!raw) return null;
  const cols = parseColumnarStat(raw, "Tcp:", ["InSegs", "OutSegs", "RetransSegs"]);
  if (!cols) return null;
  return {
    out_segs: cols.OutSegs,
    retrans_segs: cols.RetransSegs,
    in_segs: cols.InSegs,
  };
}

/**
 * Parse /proc/net/netstat's `TcpExt:` two-line section for the listen-
 * queue counters.
 */
export function parseTcpExt(): {
  listen_overflows: number;
  listen_drops: number;
} | null {
  const raw = readProcFile("/proc/net/netstat");
  if (!raw) return null;
  const cols = parseColumnarStat(raw, "TcpExt:", ["ListenOverflows", "ListenDrops"]);
  if (!cols) return null;
  return {
    listen_overflows: cols.ListenOverflows,
    listen_drops: cols.ListenDrops,
  };
}

export const __test_only = {
  resetForTests: () => {
    previous = null;
  },
};
