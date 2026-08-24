import { readProcFile, sleep } from "../lib/parse.js";
import { readFileSync, readdirSync } from "fs";
import type { NetworkInfo } from "../lib/types.js";

interface IfaceStats {
  rx_bytes: number; rx_packets: number; rx_errors: number; rx_drops: number;
  tx_bytes: number; tx_packets: number; tx_errors: number; tx_drops: number;
}

// Previous cumulative counters for delta computation (persists in process memory across cycles)
interface PreviousCounters {
  rx_errors: number;
  tx_errors: number;
  rx_drops: number;
  tx_drops: number;
  rx_packets: number;
  tx_packets: number;
  rx_crc_errors?: number;
  rx_frame_errors?: number;
  rx_length_errors?: number;
  tx_carrier_errors?: number;
  carrier_changes?: number;
}

const previousCounters = new Map<string, PreviousCounters>();

function readStatCounter(iface: string, name: string): number | undefined {
  try {
    const raw = readFileSync(`/sys/class/net/${iface}/statistics/${name}`, "utf-8").trim();
    const val = parseInt(raw, 10);
    return Number.isFinite(val) ? val : undefined;
  } catch {
    return undefined;
  }
}

function parseNetDev(): Record<string, IfaceStats> {
  const raw = readProcFile("/proc/net/dev") || "";
  const result: Record<string, IfaceStats> = {};
  for (const line of raw.split("\n").slice(2)) {
    const match = line.match(/^\s*(\S+):\s+(.*)/);
    if (!match) continue;
    const name = match[1];
    // Skip virtual interfaces
    if (name === "lo" || name.startsWith("veth") || name.startsWith("docker") || name.startsWith("br-") || name.startsWith("virbr")) continue;
    const parts = match[2].trim().split(/\s+/).map(Number);
    result[name] = {
      rx_bytes: parts[0] || 0, rx_packets: parts[1] || 0, rx_errors: parts[2] || 0, rx_drops: parts[3] || 0,
      tx_bytes: parts[8] || 0, tx_packets: parts[9] || 0, tx_errors: parts[10] || 0, tx_drops: parts[11] || 0,
    };
  }
  return result;
}

function getSpeed(iface: string): number {
  try {
    const speed = readFileSync(`/sys/class/net/${iface}/speed`, "utf-8").trim();
    const val = parseInt(speed, 10);
    return isNaN(val) || val <= 0 ? 0 : val;
  } catch {
    return 0;
  }
}

function getOperstate(iface: string): string {
  try {
    return readFileSync(`/sys/class/net/${iface}/operstate`, "utf-8").trim();
  } catch {
    return "unknown";
  }
}

function getBondMaster(iface: string): string | undefined {
  try {
    const bonds = readdirSync("/proc/net/bonding/");
    for (const bond of bonds) {
      const content = readFileSync(`/proc/net/bonding/${bond}`, "utf-8");
      if (content.includes(`Slave Interface: ${iface}`)) return bond;
    }
  } catch {
    // No bonds or /proc/net/bonding doesn't exist
  }
  return undefined;
}

function isBondMaster(iface: string): boolean {
  try {
    return readdirSync("/proc/net/bonding/").includes(iface);
  } catch {
    return false;
  }
}

// Compute delta, handling counter wraps (current < previous means reset, use current as delta)
function delta(current: number, previous: number): number {
  if (current >= previous) return current - previous;
  return current; // counter wrapped or reset
}

const NET_CLASS_ROOT = "/sys/class/net";

// Read a bare-integer file directly under /sys/class/net/IFACE/ (not the
// statistics/ subdir readStatCounter serves). undefined on any failure.
function readIfaceCounter(root: string, iface: string, name: string): number | undefined {
  try {
    const raw = readFileSync(`${root}/${iface}/${name}`, "utf-8").trim();
    if (!/^\d+$/.test(raw)) return undefined;
    const val = parseInt(raw, 10);
    return Number.isFinite(val) ? val : undefined;
  } catch {
    return undefined;
  }
}

export interface CarrierFlaps {
  carrier_changes: number;
  carrier_changes_delta: number | null;
  carrier_up_count?: number;
  carrier_down_count?: number;
}

// Link-flap counters (collectd connectivity parity close, 2026-08-24).
// /sys/class/net/IFACE/carrier_changes counts every carrier transition
// since the interface registered, so a flap BETWEEN two ~5-minute
// snapshots still moves the counter even though operstate looks fine at
// both sample instants. carrier_up_count/carrier_down_count (kernel
// 4.16+) split the direction where present. Returns null when the
// kernel does not expose carrier_changes at all (field stays absent);
// the delta is null on the first cycle for an interface (no baseline),
// never 0. Interface filtering is the caller's: this only runs for
// interfaces parseNetDev already kept (loopback/virtual are skipped
// there). `root` is a test hook.
export function collectCarrierFlaps(
  iface: string,
  prevChanges: number | undefined,
  root: string = NET_CLASS_ROOT,
): CarrierFlaps | null {
  const changes = readIfaceCounter(root, iface, "carrier_changes");
  if (changes === undefined) return null;
  const result: CarrierFlaps = {
    carrier_changes: changes,
    carrier_changes_delta: prevChanges === undefined ? null : delta(changes, prevChanges),
  };
  const up = readIfaceCounter(root, iface, "carrier_up_count");
  const down = readIfaceCounter(root, iface, "carrier_down_count");
  if (up !== undefined) result.carrier_up_count = up;
  if (down !== undefined) result.carrier_down_count = down;
  return result;
}

export async function collectNetwork(): Promise<NetworkInfo[]> {
  const stats1 = parseNetDev();
  await sleep(1000);
  const stats2 = parseNetDev();

  const currentIfaces = new Set<string>();
  const results: NetworkInfo[] = [];

  for (const [name, s2] of Object.entries(stats2)) {
    const s1 = stats1[name];
    if (!s1) continue;
    currentIfaces.add(name);

    const prev = previousCounters.get(name);

    // Link-flap counters; null when the kernel lacks carrier_changes.
    const flaps = collectCarrierFlaps(name, prev?.carrier_changes);

    // /sys/class/net/*/statistics/ exposes finer-grained RX/TX subtype
    // counters than /proc/net/dev. Read cumulative values here; delta is
    // derived below against the previous cycle's snapshot.
    const rxCrcCum = readStatCounter(name, "rx_crc_errors");
    const rxFrameCum = readStatCounter(name, "rx_frame_errors");
    const rxLenCum = readStatCounter(name, "rx_length_errors");
    const txCarrierCum = readStatCounter(name, "tx_carrier_errors");

    // Compute error/drop deltas (0 on first cycle after start or new interface)
    let rxErrorsDelta = 0;
    let txErrorsDelta = 0;
    let rxDropsDelta = 0;
    let txDropsDelta = 0;
    let rxPacketsDelta = 0;
    let txPacketsDelta = 0;
    let rxCrcDelta: number | undefined;
    let rxFrameDelta: number | undefined;
    let rxLenDelta: number | undefined;
    let txCarrierDelta: number | undefined;

    if (prev) {
      rxErrorsDelta = delta(s2.rx_errors, prev.rx_errors);
      txErrorsDelta = delta(s2.tx_errors, prev.tx_errors);
      rxDropsDelta = delta(s2.rx_drops, prev.rx_drops);
      txDropsDelta = delta(s2.tx_drops, prev.tx_drops);
      rxPacketsDelta = delta(s2.rx_packets, prev.rx_packets);
      txPacketsDelta = delta(s2.tx_packets, prev.tx_packets);
      if (rxCrcCum != null && prev.rx_crc_errors != null) rxCrcDelta = delta(rxCrcCum, prev.rx_crc_errors);
      if (rxFrameCum != null && prev.rx_frame_errors != null) rxFrameDelta = delta(rxFrameCum, prev.rx_frame_errors);
      if (rxLenCum != null && prev.rx_length_errors != null) rxLenDelta = delta(rxLenCum, prev.rx_length_errors);
      if (txCarrierCum != null && prev.tx_carrier_errors != null) txCarrierDelta = delta(txCarrierCum, prev.tx_carrier_errors);
    }

    // Store current cumulative values for next cycle
    previousCounters.set(name, {
      rx_errors: s2.rx_errors,
      tx_errors: s2.tx_errors,
      rx_drops: s2.rx_drops,
      tx_drops: s2.tx_drops,
      rx_packets: s2.rx_packets,
      tx_packets: s2.tx_packets,
      rx_crc_errors: rxCrcCum,
      rx_frame_errors: rxFrameCum,
      rx_length_errors: rxLenCum,
      tx_carrier_errors: txCarrierCum,
      carrier_changes: flaps?.carrier_changes,
    });

    const entry: NetworkInfo = {
      interface: name,
      speed_mbps: getSpeed(name),
      rx_bytes_sec: s2.rx_bytes - s1.rx_bytes, // already a 1-second delta
      tx_bytes_sec: s2.tx_bytes - s1.tx_bytes,
      rx_errors: rxErrorsDelta,
      tx_errors: txErrorsDelta,
      rx_drops: rxDropsDelta,
      tx_drops: txDropsDelta,
      rx_packets: rxPacketsDelta,
      tx_packets: txPacketsDelta,
      operstate: getOperstate(name),
    };
    if (rxCrcDelta !== undefined) entry.rx_crc_errors = rxCrcDelta;
    if (rxFrameDelta !== undefined) entry.rx_frame_errors = rxFrameDelta;
    if (rxLenDelta !== undefined) entry.rx_length_errors = rxLenDelta;
    if (txCarrierDelta !== undefined) entry.tx_carrier_errors = txCarrierDelta;
    if (flaps) {
      entry.carrier_changes = flaps.carrier_changes;
      entry.carrier_changes_delta = flaps.carrier_changes_delta;
      if (flaps.carrier_up_count !== undefined) entry.carrier_up_count = flaps.carrier_up_count;
      if (flaps.carrier_down_count !== undefined) entry.carrier_down_count = flaps.carrier_down_count;
    }
    const master = getBondMaster(name);
    if (master) entry.bond_master = master;
    // Identify bond masters (have at least one slave pointing at them).
    if (isBondMaster(name)) entry.is_bond_master = true;
    results.push(entry);
  }

  // Remove stale interfaces that disappeared
  for (const name of previousCounters.keys()) {
    if (!currentIfaces.has(name)) {
      previousCounters.delete(name);
    }
  }

  return results;
}
