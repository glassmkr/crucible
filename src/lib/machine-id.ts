// Stable, machine-unique identity used to make fleet onboarding idempotent.
//
// When a provisioning script (Ansible / cloud-init / post-install) re-runs
// against a host, the dashboard needs to recognise "this is the same machine"
// so it maps back to the existing server row instead of minting a duplicate
// that burns the node quota. This module derives that identity.
//
// Preference order:
//   1. DMI product UUID (/sys/class/dmi/id/product_uuid) - survives an OS
//      reinstall on bare metal (our primary target). Requires root to read
//      (the file is 0400), which the enroll flow has.
//   2. /etc/machine-id (or /var/lib/dbus/machine-id) - systemd's stable
//      per-install id; world-readable, and regenerated on a proper clone, so
//      it disambiguates VMs when a product UUID is absent or vendor-shared.
//
// Some firmware ships a bogus or vendor-duplicated product UUID (the same
// value across many boards); those are rejected so identity never collapses
// unrelated hosts onto one server row.

import * as fs from "node:fs";

const PRODUCT_UUID_PATH = "/sys/class/dmi/id/product_uuid";
const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MACHINE_ID_RE = /^[0-9a-f]{32}$/;

// Known-bogus product UUIDs seen across many boards from the same vendor
// (AMI/MSI sample values, all-zero, all-ff). Never use these as identity.
const BOGUS_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
  "00020003-0004-0005-0006-000700080009",
]);

export type MachineIdSource = "product_uuid" | "machine_id";

export interface MachineId {
  id: string;
  source: MachineIdSource;
}

export type ReadFileSync = (path: string) => string;

const defaultReadFileSync: ReadFileSync = (p) => fs.readFileSync(p, "utf8");

/**
 * Resolve the host's stable machine identity, or null when nothing usable is
 * available (e.g. running unprivileged with no product UUID and no
 * machine-id). Callers should degrade gracefully to non-idempotent enroll
 * when this returns null. `readFileSync` is injectable for tests.
 */
export function readMachineId(readFileSync: ReadFileSync = defaultReadFileSync): MachineId | null {
  try {
    const raw = readFileSync(PRODUCT_UUID_PATH).trim().toLowerCase();
    if (UUID_RE.test(raw) && !BOGUS_UUIDS.has(raw)) {
      return { id: raw, source: "product_uuid" };
    }
  } catch {
    // product_uuid unreadable (non-root, VM, or absent) - fall through.
  }

  for (const path of MACHINE_ID_PATHS) {
    try {
      const raw = readFileSync(path).trim().toLowerCase();
      if (MACHINE_ID_RE.test(raw)) {
        return { id: raw, source: "machine_id" };
      }
    } catch {
      // try the next candidate
    }
  }

  return null;
}
