// Does this host have a BMC at all?
//
// WHY THIS EXISTS. The IPMI capability probe records WHY it could not talk to a
// BMC, but its reason values cannot express whether a BMC is even present:
//   - `ipmitool -V` is checked BEFORE any BMC contact, so `no_ipmitool_binary`
//     and the CVE-version reason are emitted on hosts that have no BMC at all.
//   - `no_bmc_device` is emitted whenever the wrapped sensor probe returns
//     empty, which also covers a DEAD BMC, a missing sudo wrapper, a permission
//     failure and a timeout.
// So the dashboard could not distinguish "no BMC, correctly silent" from "BMC
// exists and stopped answering", and had to suppress both. An adversarial review
// on 2026-07-29 called that out: the one condition the IPMI-blindness rule was
// asked for was the one it could never report.
//
// The fix is to ship the FACT rather than a verdict. The kernel enumerates an
// IPMI controller as a character device, so the presence of that device node is
// independent of whether ipmitool exists, is patched, or can currently reach the
// BMC. The dashboard evaluator is the authoritative layer in this system, so it
// decides what the combination means; this module only reports what is on disk.
//
// Deliberately NOT a boolean. Absence of the node is not proof of absence of a
// BMC: `ipmi_devintf` may simply not be loaded. Callers get the path or null and
// must treat null as "undetermined", never as "no BMC".

import { existsSync } from "node:fs";

/** Device nodes the in-kernel IPMI drivers create, in the order they are tried.
 *  /dev/ipmi0 is by far the common one; the others appear on older kernels and
 *  some distro udev rule sets. */
export const IPMI_DEVICE_NODES = [
  "/dev/ipmi0",
  "/dev/ipmi/0",
  "/dev/ipmidev/0",
] as const;

export interface PresenceDeps {
  /** Override for tests. */
  exists?: (p: string) => boolean;
}

/**
 * Return the first IPMI device node that exists, or null when none do.
 *
 * A non-null result means the kernel found an IPMI controller, i.e. this host
 * really does have a BMC, regardless of whether we can currently talk to it.
 * Null means UNDETERMINED, not "no BMC": the driver module may not be loaded.
 *
 * Pure apart from the injected `exists`; unit-tested. Cheap enough (a few stat
 * calls) to run on every snapshot, which matters because the capability probe
 * itself is one-shot at startup and therefore cannot notice a BMC that dies
 * later.
 */
export function findBmcDeviceNode(deps: PresenceDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  for (const node of IPMI_DEVICE_NODES) {
    try {
      if (exists(node)) return node;
    } catch {
      // An unreadable /dev entry is not our business; treat as absent and keep
      // looking rather than failing the whole snapshot.
    }
  }
  return null;
}
