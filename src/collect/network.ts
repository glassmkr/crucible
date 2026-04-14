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
}

const previousCounters = new Map<string, PreviousCounters>();

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

// Compute delta, handling counter wraps (current < previous means reset, use current as delta)
function delta(current: number, previous: number): number {
  if (current >= previous) return current - previous;
  return current; // counter wrapped or reset
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

    // Compute error/drop deltas (0 on first cycle after start or new interface)
    let rxErrorsDelta = 0;
    let txErrorsDelta = 0;
    let rxDropsDelta = 0;
    let txDropsDelta = 0;

    if (prev) {
      rxErrorsDelta = delta(s2.rx_errors, prev.rx_errors);
      txErrorsDelta = delta(s2.tx_errors, prev.tx_errors);
      rxDropsDelta = delta(s2.rx_drops, prev.rx_drops);
      txDropsDelta = delta(s2.tx_drops, prev.tx_drops);
    }

    // Store current cumulative values for next cycle
    previousCounters.set(name, {
      rx_errors: s2.rx_errors,
      tx_errors: s2.tx_errors,
      rx_drops: s2.rx_drops,
      tx_drops: s2.tx_drops,
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
      operstate: getOperstate(name),
    };
    const master = getBondMaster(name);
    if (master) entry.bond_master = master;
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
