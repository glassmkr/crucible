// Counter epochs for GPU telemetry.
//
// WHY. NVIDIA documents reset semantics for ECC (volatile counters clear at driver
// load; aggregate counters are inforom-backed and persist for the device lifetime)
// and documents essentially NOTHING equivalent for NVLink counters. The 2026-08-02
// research treats that asymmetry as the finding rather than as a gap in the search:
// NVIDIA publishes persistence when it exists, so silence means we must not assume
// it.
//
// Concretely, for NVLink error counters we do not know whether they survive a
// driver reload, a GPU reset, or a fabric manager restart. On NVLink 5 there is no
// supported manual reset at all, so we cannot even establish a clean baseline by
// zeroing them.
//
// The rule this forces: never ship `counter > threshold`, and never difference two
// samples without first proving they belong to the same epoch. A counter that
// silently resets turns a "total errors" rule into one that quietly stops firing,
// which is the worst failure mode we have: a rule that looks healthy because it is
// broken. We shipped exactly that shape in the storage domain, claiming a SMART
// attribute latched when our own code assumed it cleared.
//
// The agent's job is only to emit the epoch key beside every counter. The
// comparison happens server-side, where the history is.

import { readFileSync } from "node:fs";

export interface GpuCounterEpoch {
  /** Stable device identity. Survives reboots; changes if the card is swapped. */
  gpu_uuid: string | null;
  /** Slot identity. Changes if the card moves, even when the UUID does not. */
  pci_bdf: string | null;
  /** Kernel boot identity. Changes on every reboot. */
  boot_id: string | null;
  /** Counters can reset when the driver reloads, so this belongs in the key. */
  driver_version: string | null;
  /** NVML version can move independently of the driver package version. */
  nvml_version: string | null;
  /**
   * B300 only. Fabric manager owns NVSwitch state, so an FM restart is a candidate
   * reset boundary for anything fabric-derived. Null where FM is absent, which is
   * every H200 NVL and every non-NVSwitch box.
   */
  fabric_manager_started_at: string | null;
  /** Our own parse can change meaning between releases; a bump invalidates history. */
  collector_version: string;
}

/**
 * What happened between two samples of the same counter.
 *
 * `unknown_epoch` and `reset_observed` are deliberately distinct. The first means
 * we cannot compare; the second means we can see that a reset happened. Both must
 * be visible as states rather than as an absent alert, because a rule that stops
 * evaluating looks exactly like a rule with nothing to report.
 */
export type CounterDeltaKind =
  | "delta"           // same epoch, value did not decrease: the delta is real
  | "reset_observed"  // same epoch, value decreased: something zeroed it underneath us
  | "unknown_epoch"   // epoch differs or is incomplete: do not compare
  | "first_sample";   // nothing to compare against yet

export interface CounterDelta {
  kind: CounterDeltaKind;
  /** Only populated when kind is "delta". Never negative. */
  delta: number | null;
  /** Always the current raw reading, kept as a fact regardless of comparability. */
  current: number;
}

/** Two epochs are the same only if every populated field matches. */
export function sameEpoch(a: GpuCounterEpoch | null, b: GpuCounterEpoch | null): boolean {
  if (!a || !b) return false;
  const keys: Array<keyof GpuCounterEpoch> = [
    "gpu_uuid",
    "pci_bdf",
    "boot_id",
    "driver_version",
    "nvml_version",
    "fabric_manager_started_at",
    "collector_version",
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * An epoch missing its identity anchors cannot be trusted to scope a comparison.
 * We require at least a device identity and a boot identity: without the first we
 * might be differencing two different cards, without the second we might be
 * differencing across a reboot.
 */
export function epochIsComplete(e: GpuCounterEpoch | null): boolean {
  if (!e) return false;
  return Boolean((e.gpu_uuid || e.pci_bdf) && e.boot_id && e.driver_version);
}

/**
 * Classify a counter sample against the previous one. This is the only sanctioned
 * way to turn two readings into a delta.
 */
export function classifyCounter(
  previous: { value: number; epoch: GpuCounterEpoch } | null,
  current: { value: number; epoch: GpuCounterEpoch },
): CounterDelta {
  if (!previous) {
    return { kind: "first_sample", delta: null, current: current.value };
  }
  if (!epochIsComplete(current.epoch) || !epochIsComplete(previous.epoch)) {
    return { kind: "unknown_epoch", delta: null, current: current.value };
  }
  if (!sameEpoch(previous.epoch, current.epoch)) {
    return { kind: "unknown_epoch", delta: null, current: current.value };
  }
  if (current.value < previous.value) {
    // Same epoch by every identifier we have, and the counter still went
    // backwards. Something zeroed it that we cannot see. This is NOT "the problem
    // healed" and must never be reported as a decrease.
    return { kind: "reset_observed", delta: null, current: current.value };
  }
  return { kind: "delta", delta: current.value - previous.value, current: current.value };
}

/**
 * Linux boot identity. Changes on every boot, so it scopes any counter that the
 * kernel or driver re-initialises at start.
 */
export function readBootId(read: (p: string) => string = defaultRead): string | null {
  const raw = read("/proc/sys/kernel/random/boot_id");
  if (!raw) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function defaultRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function buildEpoch(parts: {
  gpuUuid?: string | null;
  pciBdf?: string | null;
  bootId?: string | null;
  driverVersion?: string | null;
  nvmlVersion?: string | null;
  fabricManagerStartedAt?: string | null;
  collectorVersion: string;
}): GpuCounterEpoch {
  return {
    gpu_uuid: parts.gpuUuid ?? null,
    pci_bdf: parts.pciBdf ?? null,
    boot_id: parts.bootId ?? null,
    driver_version: parts.driverVersion ?? null,
    nvml_version: parts.nvmlVersion ?? null,
    fabric_manager_started_at: parts.fabricManagerStartedAt ?? null,
    collector_version: parts.collectorVersion,
  };
}
