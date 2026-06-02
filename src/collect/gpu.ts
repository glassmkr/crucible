// GPU collection (NVIDIA data-center GPUs).
//
// Three-tier, capability-gated. Per CC_SPEC_CRUCIBLE_GPU_COLLECTION_
// 2026-05-19.md + handoff Decisions locked (Simon, 2026-05-19).
//
// Tier 1 (nvidia-smi): always tried first; <10ms short-circuit on
//   non-NVIDIA hosts. Validation-pending provenance: ships ahead of
//   fleet validation, lifted to fleet-tested in a follow-up PR after
//   Simon's 2-3 GPU hosts come online.
// Tier 2 (DCGM): basic dcgmi parsing. Desk-research-only provenance.
//   Lifts to fleet-tested if a validation host runs nv-hostengine.
// Tier 3 (Redfish OEM): SHIPS AS STUB. Detection probe returns
//   available: false with parser_quality "stub" so Dashboard can
//   render the honesty surface (same pattern as the HPE/Adaptec RAID
//   stub parsers from PR #163 and the lenovo/cisco/openbmc SEL
//   stubs from PR #165). Full Supermicro HGX / NVIDIA reference
//   schema implementation is a post-validation follow-up.
//
// Critical constraint: zero performance and zero error overhead on
// hosts without NVIDIA GPUs. The `which nvidia-smi` probe is the
// gate; everything else short-circuits.

import { existsSync } from "fs";

import { run, runDetailed, looksLikeFieldRenameError, isUnitActive } from "../lib/exec.js";
import type {
  Gpu,
  GpuSnapshot,
  GpuCapabilities,
  NvLinkBasic,
  Tier1Snapshot,
  Tier2Snapshot,
  Tier3Snapshot,
  XidEvent,
} from "../lib/types.js";

const NVIDIA_SMI_TIMEOUT_MS = 5000;
const DCGM_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

// XID error severity table (NVIDIA XID Errors documentation).
// Maintenance note: NVIDIA adds new XIDs in driver releases; refresh
// when major driver versions land. Last refreshed 2026-05-19 against
// the published XID error reference.
const XID_CRITICAL = new Set([
  13, 31, 43, 45, 48, 56, 57, 58, 62, 63, 64,
  65, 66, 68, 69, 71, 72, 73, 74, 76, 78,
  79, // GPU has fallen off the bus -> most severe
  92, 94, 95, 96, 100, 101, 110, 111, 119, 120,
]);
const XID_WARNING = new Set([8, 14, 22, 25, 32, 38, 39, 42, 44, 46, 60, 67]);

export async function collectGpu(): Promise<GpuSnapshot> {
  const caps = await probeGpuCapabilities();
  if (!caps.nvidia_smi) {
    return {
      available: false,
      reason: "nvidia-smi not present (non-NVIDIA host or driver not installed)",
      capabilities: caps,
    };
  }
  const tier1 = await collectTier1();
  const tier2 = caps.dcgm
    ? await collectTier2()
    : ({
        available: false,
        reason: "DCGM not active (nv-hostengine service not running)",
      } as Tier2Snapshot | { available: false; reason: string });
  const tier3 = await collectTier3Stub(caps);
  return { available: true, capabilities: caps, tier1, tier2, tier3 };
}

// ---------------------------------------------------------------------------
// Detection probe
// ---------------------------------------------------------------------------

export async function probeGpuCapabilities(): Promise<GpuCapabilities> {
  const startMs = Date.now();
  // Fast path: nvidia-smi binary presence. existsSync is synchronous
  // and ~microseconds; the spec's <10ms target is easily met when the
  // file is absent.
  const nvidiaSmiPath = findInPath("nvidia-smi");
  if (!nvidiaSmiPath) {
    return {
      nvidia_smi: false,
      nvidia_driver_version: null,
      dcgm: false,
      dcgmi_version: null,
      redfish_endpoint: null,
      redfish_oem_schema: null,
      probe_duration_ms: Date.now() - startMs,
    };
  }
  // Driver version + sanity check (nvidia-smi might exist but be broken
  // on a host with a kernel/driver mismatch; treat that as
  // nvidia_smi=false per the spec).
  const driverOut = await run(
    "nvidia-smi",
    ["--query-gpu=driver_version", "--format=csv,noheader,nounits"],
    PROBE_TIMEOUT_MS,
  );
  if (!driverOut) {
    return {
      nvidia_smi: false,
      nvidia_driver_version: null,
      dcgm: false,
      dcgmi_version: null,
      redfish_endpoint: null,
      redfish_oem_schema: null,
      probe_duration_ms: Date.now() - startMs,
    };
  }
  const driverVersion = driverOut.split("\n")[0].trim() || null;

  // DCGM probe. Both `pgrep nv-hostengine` (or `systemctl is-active`)
  // and `dcgmi --version` must succeed.
  const dcgmActive = await isDcgmActive();
  const dcgmiVersionOut = dcgmActive
    ? await run("dcgmi", ["--version"], PROBE_TIMEOUT_MS)
    : null;
  const dcgmiVersion = dcgmiVersionOut
    ? (dcgmiVersionOut.split("\n").find((l) => /version/i.test(l)) ?? dcgmiVersionOut.split("\n")[0]).trim()
    : null;

  // Redfish probe ships as stub: detection returns null endpoint /
  // unknown schema so Tier 3 falls through to "available: false".
  // Per Simon's 2026-05-19 locked decision; full OEM schema queries
  // are a post-fleet-validation follow-up.

  return {
    nvidia_smi: true,
    nvidia_driver_version: driverVersion,
    dcgm: dcgmActive && dcgmiVersion !== null,
    dcgmi_version: dcgmiVersion,
    redfish_endpoint: null,
    redfish_oem_schema: null,
    probe_duration_ms: Date.now() - startMs,
  };
}

function findInPath(binary: string): string | null {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${binary}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function isDcgmActive(): Promise<boolean> {
  // Prefer systemctl is-active; fall back to pgrep.
  if (await isUnitActive("nv-hostengine", PROBE_TIMEOUT_MS)) return true;
  const pgrepOut = await run("pgrep", ["-f", "nv-hostengine"], PROBE_TIMEOUT_MS);
  return Boolean(pgrepOut && pgrepOut.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Tier 1 (nvidia-smi)
// ---------------------------------------------------------------------------

const NVIDIA_SMI_CSV_FIELDS = [
  "index", "uuid", "name", "pci.bus_id", "vbios_version",
  "memory.total", "memory.used",
  "temperature.gpu", "power.draw", "power.limit",
  "utilization.gpu", "utilization.memory",
  "clocks.gr", "clocks.sm", "clocks.mem",
  "pstate",
  "pcie.link.gen.current", "pcie.link.gen.max",
  "pcie.link.width.current", "pcie.link.width.max",
  "ecc.mode.current",
  "ecc.errors.corrected.volatile.total", "ecc.errors.corrected.aggregate.total",
  "ecc.errors.uncorrected.volatile.total", "ecc.errors.uncorrected.aggregate.total",
  // NVIDIA naming asymmetry: the single-bit field is
  // `retired_pages.single_bit_ecc.count` (with _ecc) but the double-bit
  // is `retired_pages.double_bit.count` (no _ecc). Confirmed against
  // `nvidia-smi --help-query-gpu` on driver 550.163.01. v0.13.0 shipped
  // with `retired_pages.double_bit_ecc.count` (extrapolated from the
  // single-bit name); nvidia-smi rejects the unknown field, prints the
  // error to stderr, and exits 0 with empty stdout — Crucible then
  // reports "no GPU rows" and marks tier1 unavailable even though the
  // host has working nvidia-smi. Discovered 2026-05-20 on the val-L4
  // validation host.
  "retired_pages.single_bit_ecc.count", "retired_pages.double_bit.count",
  "retired_pages.pending",
  "fan.speed",
] as const;

async function collectTier1(): Promise<Tier1Snapshot | { available: false; reason: string }> {
  // Use runDetailed so we can distinguish "tool not installed" from
  // "tool exited 0 with empty stdout but errored to stderr". The
  // latter is the silent-no-op class that hid the v0.13.0
  // retired_pages.double_bit_ecc typo for ~24h until a real GPU host
  // triggered the trigger campaign.
  const res = await runDetailed(
    "nvidia-smi",
    [`--query-gpu=${NVIDIA_SMI_CSV_FIELDS.join(",")}`, "--format=csv,noheader,nounits"],
    NVIDIA_SMI_TIMEOUT_MS,
  );
  if (!res.installed) {
    return { available: false, reason: "nvidia-smi not present (non-NVIDIA host or driver not installed)" };
  }
  if (res.timedOut) {
    return { available: false, reason: "nvidia-smi query timed out" };
  }
  // exit 0 + empty stdout + stderr complains about a field rename is
  // exactly the v0.13.0 / v0.13.2 bug shape. Surface this loudly with
  // a reason that points an operator at the cause.
  if (
    res.exitCode === 0 &&
    (!res.stdout || res.stdout.trim().length === 0) &&
    looksLikeFieldRenameError(res.stderr)
  ) {
    console.warn(`[gpu] nvidia-smi exited 0 with empty stdout but stderr looks like a field-name rename: ${res.stderr.trim().slice(0, 240)}`);
    return {
      available: false,
      reason: `nvidia-smi exited 0 with empty stdout; stderr suggests a queried field has been renamed by the driver version. stderr=${res.stderr.trim().slice(0, 200)}`,
    };
  }
  const csvOut = res.stdout;
  if (!csvOut) {
    return { available: false, reason: "nvidia-smi query returned no output" };
  }
  const gpus: Gpu[] = [];
  for (const line of csvOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const parsed = parseNvidiaSmiCsvRow(line);
    if (parsed) gpus.push(parsed);
  }
  if (gpus.length === 0) {
    return { available: false, reason: "nvidia-smi returned no GPU rows" };
  }

  // Throttle reasons from XML output (CSV path doesn't expose
  // performance_state.reasons cleanly).
  await enrichThrottleReasons(gpus);

  // NVLink basic state per GPU.
  for (const gpu of gpus) {
    gpu.nvlink_links = await collectNvLinkBasic(gpu.index);
  }

  // XID events from dmesg (last 24h).
  const xidEvents = await collectXidEvents();

  // Driver version (already in probe; re-read here to keep tier 1
  // self-contained for callers that import it directly).
  const driverOut = await run(
    "nvidia-smi",
    ["--query-gpu=driver_version", "--format=csv,noheader,nounits"],
    NVIDIA_SMI_TIMEOUT_MS,
  );
  const driverVersion = driverOut ? driverOut.split("\n")[0].trim() : "unknown";

  return {
    available: true,
    gpus,
    xid_events: xidEvents,
    driver_version: driverVersion,
  };
}

export function parseNvidiaSmiCsvRow(line: string): Gpu | null {
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < NVIDIA_SMI_CSV_FIELDS.length - 3) return null; // tolerate trailing empty cols on older driver versions
  const num = (i: number): number => {
    const v = parts[i];
    if (v === undefined || v === "" || /\[(N\/A|Not Supported)\]/i.test(v)) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const nullableNum = (i: number): number | null => {
    const v = parts[i];
    if (!v || /\[(N\/A|Not Supported)\]/i.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (i: number): string => parts[i] ?? "";
  const bool = (i: number): boolean => /enabled/i.test(parts[i] ?? "");
  return {
    index: num(0),
    uuid: str(1),
    name: str(2),
    pci_bdf: str(3),
    vbios_version: str(4),
    vram_total_mib: num(5),
    vram_used_mib: num(6),
    temp_c: num(7),
    power_draw_w: num(8),
    power_limit_w: num(9),
    utilization_gpu_percent: num(10),
    utilization_mem_percent: num(11),
    clock_graphics_mhz: num(12),
    clock_sm_mhz: num(13),
    clock_mem_mhz: num(14),
    pstate: str(15),
    pcie_link_gen_current: num(16),
    pcie_link_gen_max: num(17),
    pcie_link_width_current: num(18),
    pcie_link_width_max: num(19),
    ecc_mode_current: bool(20),
    ecc_errors_corrected_volatile: num(21),
    ecc_errors_corrected_aggregate: num(22),
    ecc_errors_uncorrected_volatile: num(23),
    ecc_errors_uncorrected_aggregate: num(24),
    retired_pages_single_bit: nullableNum(25),
    retired_pages_double_bit: nullableNum(26),
    retired_pages_pending: nullableNum(27),
    thermal_slowdown_active: false, // set by enrichThrottleReasons
    thermal_violation_total_ms: null, // Tier 2 enriches
    power_violation_total_ms: null,   // Tier 2 enriches
    fan_speed_percent: nullableNum(28),
    nvlink_links: [], // set by collectNvLinkBasic
    performance_state_reasons: [], // set by enrichThrottleReasons
  };
}

async function enrichThrottleReasons(gpus: Gpu[]): Promise<void> {
  // nvidia-smi -q -x emits a deeply-nested XML; we extract the
  // <clocks_throttle_reasons> block per GPU and flag the active
  // reasons. Lightweight regex-based extraction; avoids pulling a
  // full xml2js dependency for what is essentially a flat key-value
  // section.
  const xmlOut = await run("nvidia-smi", ["-q", "-x"], NVIDIA_SMI_TIMEOUT_MS);
  if (!xmlOut) return;
  const gpuBlocks = xmlOut.split(/<gpu /).slice(1); // skip the header
  // Positive-affirmation: count GPUs for which we found a recognisable
  // throttle/event-reasons block. If we found NONE on a host that has
  // active GPUs, the most likely cause is another driver-version XML
  // tag rename (same shape as the v0.13.2 fix), and we want a loud
  // warning so the next person sees it without re-running a campaign.
  let matchedGpus = 0;
  for (let i = 0; i < gpuBlocks.length && i < gpus.length; i++) {
    const block = gpuBlocks[i];
    // Driver 535-: <clocks_throttle_reasons>; driver 550+: <clocks_event_reasons>.
    // Per-element tags follow the same rename. Match either, then probe each
    // reason key with both naming prefixes so we work across the rename
    // boundary. Discovered 2026-05-20 on val-L4 (driver 550.163.01): power-cap
    // throttling didn't trigger gpu_power_cap_throttling because the
    // performance_state_reasons array stayed empty.
    const reasonsBlock =
      block.match(/<clocks_event_reasons>([\s\S]*?)<\/clocks_event_reasons>/) ||
      block.match(/<clocks_throttle_reasons>([\s\S]*?)<\/clocks_throttle_reasons>/);
    if (!reasonsBlock) continue;
    matchedGpus++;
    const reasons: string[] = [];
    for (const [suffix, label] of [
      ["gpu_idle", "gpu_idle"],
      ["applications_clocks_setting", "applications_clocks_setting"],
      ["sw_power_cap", "sw_power_cap"],
      ["hw_slowdown", "hw_slowdown"],
      ["hw_thermal_slowdown", "hw_thermal_slowdown"],
      ["hw_power_brake_slowdown", "hw_power_brake"],
      ["sw_thermal_slowdown", "sw_thermal_slowdown"],
      ["sync_boost", "sync_boost"],
      ["display_clock_setting", "display_clock_setting"],
      ["display_clocks_setting", "display_clock_setting"], // driver-550 plural
    ] as const) {
      const re = new RegExp(
        `<clocks_(?:event|throttle)_reason_${suffix}>([^<]+)</clocks_(?:event|throttle)_reason_${suffix}>`,
      );
      const m = reasonsBlock[1].match(re);
      if (m && /^(active|true)/i.test(m[1].trim())) {
        if (!reasons.includes(label)) reasons.push(label);
      }
    }
    gpus[i].performance_state_reasons = reasons;
    gpus[i].thermal_slowdown_active =
      reasons.includes("hw_slowdown") ||
      reasons.includes("hw_thermal_slowdown") ||
      reasons.includes("sw_thermal_slowdown");
  }
  // Silent-regression-class defense: nvidia-smi returned XML with at
  // least one <gpu> block but none had a recognisable throttle/event
  // reasons sub-block. Most likely cause is a third XML rename the
  // matcher doesn't cover; warn so the next investigator sees this
  // without re-running a trigger campaign on a real GPU host.
  if (gpus.length > 0 && matchedGpus === 0 && gpuBlocks.length > 0) {
    console.warn(
      "[gpu] enrichThrottleReasons: nvidia-smi -q -x emitted GPU blocks but none contained " +
        "<clocks_event_reasons> or <clocks_throttle_reasons>. " +
        "Likely a new driver-version XML rename; performance_state_reasons will be empty " +
        "and the dashboard's gpu_power_cap_throttling + gpu_thermal_critical rules cannot fire. " +
        "Inspect the output of `nvidia-smi -q -x | head -40` and extend the matcher in collect/gpu.ts.",
    );
  }
}

async function collectNvLinkBasic(gpuIndex: number): Promise<NvLinkBasic[]> {
  const out = await run(
    "nvidia-smi",
    ["nvlink", "--status", "-i", String(gpuIndex)],
    NVIDIA_SMI_TIMEOUT_MS,
  );
  if (!out) return [];
  return parseNvLinkStatus(out);
}

export function parseNvLinkStatus(raw: string): NvLinkBasic[] {
  // nvidia-smi nvlink --status output format:
  //   GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-...)
  //          Link 0: 26.562 GB/s
  //          Link 1: <inactive>
  //          Link 2: 26.562 GB/s
  //
  // Inactive shown as "<inactive>" or "Inactive"; down often shown
  // as "Down" or similar. We classify three buckets: up (positive
  // bandwidth), inactive (idle but no fault), down (faulted).
  const links: NvLinkBasic[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*Link\s+(\d+):\s*(.+?)\s*$/);
    if (!m) continue;
    const linkId = Number(m[1]);
    const value = m[2];
    const bwMatch = value.match(/(\d+(?:\.\d+)?)\s*GB\/s/i);
    let state: NvLinkBasic["state"];
    let speedGbps = 0;
    if (bwMatch) {
      const bw = Number(bwMatch[1]);
      state = bw > 0 ? "up" : "inactive";
      speedGbps = bw;
    } else if (/inactive/i.test(value)) {
      state = "inactive";
    } else {
      // Any other value (Down, error text, ...): treat as down.
      state = "down";
    }
    links.push({ link_id: linkId, state, speed_gbps: speedGbps });
  }
  return links;
}

async function collectXidEvents(): Promise<XidEvent[]> {
  const out = await run("dmesg", ["--time-format=iso", "--no-pager"], NVIDIA_SMI_TIMEOUT_MS);
  if (!out) {
    // Fallback without --time-format flag (older kernels)
    const fallback = await run("dmesg", ["--no-pager"], NVIDIA_SMI_TIMEOUT_MS);
    if (!fallback) return [];
    return parseXidEvents(fallback);
  }
  return parseXidEvents(out);
}

export function parseXidEvents(raw: string): XidEvent[] {
  const events: XidEvent[] = [];
  const cutoffMs = Date.now() - 24 * 3600 * 1000; // 24h window
  const seen = new Set<string>(); // dedup key (timestamp, bdf, code)
  for (const line of raw.split("\n")) {
    const m = line.match(
      /NRM(?:: )?Xid \(PCI:([\da-fA-F:.]+)\):\s*(\d+)(?:,)?\s*(.*)$/,
    ) || line.match(/NVRM: Xid \(PCI:([\da-fA-F:.]+)\):\s*(\d+)(?:,)?\s*(.*)$/);
    if (!m) continue;
    const [, bdf, codeStr, rest] = m;
    const code = Number.parseInt(codeStr, 10);
    if (!Number.isFinite(code)) continue;
    const ts = parseLineTimestamp(line);
    if (ts !== null && ts < cutoffMs) continue;
    const key = `${ts ?? "unknown"}|${bdf}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const severity: XidEvent["severity"] = XID_CRITICAL.has(code)
      ? "critical"
      : XID_WARNING.has(code)
        ? "warning"
        : "info";
    events.push({
      timestamp_iso: ts !== null ? new Date(ts).toISOString() : new Date().toISOString(),
      xid_code: code,
      pci_bdf: bdf,
      severity,
      raw_message: line.trim(),
    });
  }
  return events;
}

function parseLineTimestamp(line: string): number | null {
  const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[,.]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)/);
  if (isoMatch) {
    const t = Date.parse(isoMatch[1].replace(",", "."));
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2 (DCGM)
// ---------------------------------------------------------------------------

async function collectTier2(): Promise<Tier2Snapshot | { available: false; reason: string }> {
  // Best-effort tier 2 collection. parser_quality=stub per
  // CC_HANDOFF_GPU_WORKSTREAM_2026-05-19.md Decisions locked: ships
  // as desk-research-only because we have no DCGM-equipped host in
  // the validation fleet yet. Lifts to fleet-tested in the follow-up
  // PR if one of Simon's 2-3 incoming validation hosts runs
  // nv-hostengine.
  //
  // Implementation intentionally narrow: ship the shape Dashboard
  // expects with the actively-queryable fields, leave topology +
  // detailed nvlink as null for now.
  const healthOut = await run(
    "dcgmi",
    ["health", "-g", "0", "-c"],
    DCGM_TIMEOUT_MS,
  );
  if (!healthOut) {
    return {
      available: false,
      reason: "dcgmi health query returned no output (DCGM accessible but query failed)",
    };
  }
  return {
    available: true,
    parser_quality: "stub",
    nvswitch_status: [],
    nvlink_detailed: [],
    retired_pages_detail: [],
    thermal_violation_time_series_ms: 0,
    power_violation_time_series_ms: 0,
    topology_actual: { nodes: [], edges: [] },
    topology_expected: null,
    health_summary_raw: healthOut.slice(0, 4096), // cap at 4KB for snapshot size
  };
}

// ---------------------------------------------------------------------------
// Tier 3 (Redfish OEM) — stub per Simon's locked decision
// ---------------------------------------------------------------------------

async function collectTier3Stub(
  _caps: GpuCapabilities,
): Promise<Tier3Snapshot | { available: false; reason: string }> {
  // Per CC_HANDOFF_GPU_WORKSTREAM_2026-05-19.md Decisions locked:
  // "Tier 3 (Redfish OEM) ships as stub with parser_quality: 'stub'
  // honesty surface, matching the BMC vendor matrix pattern from
  // PR #165 and the HPE/Adaptec hardware RAID parsers from PR #163."
  //
  // The detection probe (probeGpuCapabilities) returns
  // redfish_endpoint: null and redfish_oem_schema: null in this
  // release; this stub returns available: false with the appropriate
  // reason. Post-fleet-validation follow-up will implement Supermicro
  // HGX and NVIDIA reference Redfish schemas.
  return {
    available: false,
    reason:
      "Tier 3 Redfish OEM ships as stub in v0.13.0 (parser_quality: stub); Supermicro HGX + NVIDIA reference schemas pending fleet validation",
  };
}

export const __test_only = {
  XID_CRITICAL,
  XID_WARNING,
  parseLineTimestamp,
};
