import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { AlertResult } from "../lib/types.js";

const STATE_FILE = "/var/lib/glassmkr/alert-state.json";

interface AlertState {
  type: string;
  first_seen: string;
  last_seen: string;
  notified: boolean;
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
  const currentTypes = new Set(currentAlerts.map((a) => a.type));
  const newAlerts: AlertResult[] = [];
  const resolvedAlerts: AlertResult[] = [];

  // Check for new alerts
  for (const alert of currentAlerts) {
    const existing = state.get(alert.type);
    if (!existing) {
      // New alert
      state.set(alert.type, { type: alert.type, first_seen: now, last_seen: now, notified: false });
      newAlerts.push(alert);
    } else {
      // Existing alert, update last_seen
      existing.last_seen = now;
    }
  }

  // Check for resolved alerts
  for (const [type, alertState] of state) {
    if (!currentTypes.has(type)) {
      resolvedAlerts.push({
        type,
        severity: "warning",
        title: `Resolved: ${type}`,
        message: `Condition cleared. Active for ${timeSince(alertState.first_seen)}.`,
        evidence: {},
        recommendation: "",
      });
      state.delete(type);
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
