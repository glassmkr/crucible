import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type { AlertResult } from "../lib/types.js";

const STATE_FILE = "/var/lib/glassmkr/alert-state.json";
export const MAX_CORRUPT_STATE_BACKUPS = 5;

function pruneCorruptBackups(path: string): void {
  const parent = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  const backups = readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  for (const name of backups.slice(MAX_CORRUPT_STATE_BACKUPS)) {
    unlinkSync(`${parent}/${name}`);
  }
}

export interface AlertState {
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

export function loadAlertStateFile(path: string): Map<string, AlertState> {
  try {
    const raw = readFileSync(path, "utf-8");
    const data: Record<string, AlertState> = JSON.parse(raw);
    return new Map(Object.entries(data));
  } catch (err: any) {
    if (err?.code === "ENOENT") return new Map();
    const backup = `${path}.corrupt-${Date.now()}-${process.pid}`;
    console.error(`[state] Invalid alert state at ${path}; preserving it as ${backup}:`, err);
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
      pruneCorruptBackups(path);
    } catch (backupErr) {
      console.error(`[state] Failed to preserve corrupt alert state at ${path}:`, backupErr);
    }
    return new Map();
  }
}

export function saveAlertStateFile(path: string, value: Map<string, AlertState>): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const obj: Record<string, AlertState> = {};
  for (const [key, item] of value) obj[key] = item;
  const temp = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  let parentFd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, JSON.stringify(obj, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(parentFd);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
}

function load() {
  state = loadAlertStateFile(STATE_FILE);
}

function save() {
  try {
    saveAlertStateFile(STATE_FILE, state);
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
