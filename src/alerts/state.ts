import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { AlertResult } from "../lib/types.js";

const STATE_FILE = "/var/lib/glassmkr/alert-state.json";

interface AlertState {
  type: string;
  instance?: string;
  first_seen: string;
  last_seen: string;
  notified: boolean;
}

// Notify state is keyed per RESOURCE, not just per type. Rules emit one
// AlertResult per disk/drive/array/interface/sensor; keying by type alone let
// a second failing resource (e.g. /dev/sdb after /dev/sda already fired) look
// already-known and never notify, and resolved every instance of a type
// together. Keying by type + instance tracks each independently. The NUL
// separator cannot appear in a type or instance string. (Codex 2026-07-17.)
function stateKey(a: { type: string; instance?: string }): string {
  return a.instance ? `${a.type}\u0000${a.instance}` : a.type;
}

let state: Map<string, AlertState> = new Map();

function load() {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const data: Record<string, AlertState> = JSON.parse(raw);
    state = new Map(Object.entries(data));
  } catch {
    state = new Map();
  }
}

function save() {
  try {
    mkdirSync("/var/lib/glassmkr", { recursive: true });
    const obj: Record<string, AlertState> = {};
    for (const [k, v] of state) obj[k] = v;
    writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[state] Failed to save alert state:", err);
  }
}

// Initialize on import
load();

export function updateAlertState(currentAlerts: AlertResult[]): {
  newAlerts: AlertResult[];
  resolvedAlerts: AlertResult[];
} {
  const now = new Date().toISOString();
  const currentKeys = new Set(currentAlerts.map(stateKey));
  const newAlerts: AlertResult[] = [];
  const resolvedAlerts: AlertResult[] = [];

  // New / still-active alerts, tracked per resource (type + instance).
  for (const alert of currentAlerts) {
    const key = stateKey(alert);
    const existing = state.get(key);
    if (!existing) {
      // New alert for this specific resource.
      state.set(key, {
        type: alert.type,
        instance: alert.instance,
        first_seen: now,
        last_seen: now,
        notified: false,
      });
      newAlerts.push(alert);
    } else {
      // Already firing for this resource: refresh last_seen only.
      existing.last_seen = now;
    }
  }

  // Resolved: a tracked resource whose key is no longer firing. Iterating a Map
  // while deleting the current entry is safe (visited/current keys only).
  for (const [key, alertState] of state) {
    if (!currentKeys.has(key)) {
      const label = alertState.instance
        ? `${alertState.type} (${alertState.instance})`
        : alertState.type;
      resolvedAlerts.push({
        type: alertState.type,
        instance: alertState.instance,
        severity: "warning",
        title: `Resolved: ${label}`,
        message: `Condition cleared. Active for ${timeSince(alertState.first_seen)}.`,
        evidence: {},
        recommendation: "",
      });
      state.delete(key);
    }
  }

  save();
  return { newAlerts, resolvedAlerts };
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} minute(s)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour(s) ${minutes % 60} minute(s)`;
  const days = Math.floor(hours / 24);
  return `${days} day(s)`;
}

// Test-only: reset the in-memory state map between cases (the module is a
// singleton, so state persists across calls within a test file otherwise).
export const __test_only = {
  reset: () => { state = new Map(); },
};
